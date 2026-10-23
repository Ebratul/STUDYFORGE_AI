import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getSessionUserFromHeaders } from "../../src/auth/session.js";
import { db } from "../../src/lib/db.js";
import { createGoogleHarness, googleClaims, hasSession, mockGoogleToken, tokenResponse, type GoogleHarness } from "../helpers/google.js";
import { createUser, TEST_PASSWORD } from "../helpers/users.js";

let g: GoogleHarness;
beforeEach(() => {
  g = createGoogleHarness();
});

const cookieOf = (c: string) => new Headers({ cookie: c });
const errorOf = (location: string) => new URL(location, "http://localhost:3100").searchParams.get("error");
const accountsOf = (userId: string) => db.account.findMany({ where: { userId } });

describe("starting the Google flow", () => {
  it("is offered by the public providers endpoint", async () => {
    const res = await g.req("GET", "/api/auth-providers", { origin: null });
    expect(await res.json()).toEqual({ google: true });
  });

  it("redirects to Google with the authorization-code flow, PKCE (S256), state and only the basic identity scopes", async () => {
    const s = await g.start();
    expect(s.res.status).toBe(200);
    const u = s.url!;
    expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(process.env.AUTH_GOOGLE_ID);
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3100/api/auth/callback/google");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(new Set(u.searchParams.get("scope")!.split(/[ +]/))).toEqual(new Set(["openid", "email", "profile"]));
    expect(u.searchParams.get("access_type")).toBeNull(); // no offline access => no refresh token
    expect(u.toString()).not.toContain(process.env.AUTH_GOOGLE_SECRET!);
  });

  it("sets an HttpOnly, SameSite=Lax state cookie", async () => {
    const s = await g.start();
    const state = s.res.headers.getSetCookie().find((c) => /state/i.test(c));
    expect(state).toBeTruthy();
    expect(state).toMatch(/HttpOnly/i);
    expect(state).toMatch(/SameSite=Lax/i);
  });

  it("sends the PKCE verifier (not the challenge) and the client secret only to Google's token endpoint", async () => {
    const claims = googleClaims();
    const r = await g.signInWithGoogle(claims);
    const req = r.mock.lastTokenRequest!;
    expect(req.get("grant_type")).toBe("authorization_code");
    expect(req.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(req.get("redirect_uri")).toBe("http://localhost:3100/api/auth/callback/google");
    expect(req.get("code_verifier")).not.toBe(new URL(r.start.url!).searchParams.get("code_challenge"));
  });
});

describe("new-user Google sign-in", () => {
  it("creates the user, Google account link, profile, preferences and welcome notification, and signs them in", async () => {
    const claims = googleClaims({ email: `New.Person-${randomUUID()}@Example.test`, name: "Nila Chowdhury" });
    const r = await g.signInWithGoogle(claims, { start: { newUserCallbackURL: "/workspace?welcome=1" } });
    expect(r.res.status).toBe(302);
    expect(r.location).toBe("/workspace?welcome=1");
    expect(hasSession(r.cookies)).toBe(true);

    const user = await db.user.findUniqueOrThrow({ where: { email: (claims.email as string).toLowerCase() } });
    expect(user).toMatchObject({ name: "Nila Chowdhury", emailVerified: true, role: "USER", status: "ACTIVE", image: "https://lh3.googleusercontent.com/a/avatar-1234" });

    const accounts = await accountsOf(user.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerId: "google", accountId: claims.sub, password: null });

    const [profile, pref, notes, audit] = await Promise.all([
      db.userProfile.findUnique({ where: { userId: user.id } }),
      db.userPreference.findUnique({ where: { userId: user.id } }),
      db.notification.findMany({ where: { userId: user.id } }),
      db.auditEvent.findMany({ where: { actorId: user.id }, select: { action: true } }),
    ]);
    expect(profile?.displayName).toBe("Nila Chowdhury");
    expect(pref).toBeTruthy();
    expect(notes.map((n) => n.type)).toContain("system.welcome");
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["auth.sign_up", "auth.sign_in", "auth.account_linked"]));
  });

  it("the new session works for the app (role/status resolved server-side)", async () => {
    const r = await g.signInWithGoogle(googleClaims());
    const me = await getSessionUserFromHeaders(cookieOf(r.cookies));
    expect(me?.role).toBe("USER");
    const res = await g.req("GET", "/api/me", { cookie: r.cookies, origin: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { image: string } }).user.image).toContain("googleusercontent.com");
  });

  it("never stores Google's access, refresh or id tokens", async () => {
    const claims = googleClaims();
    await g.signInWithGoogle(claims);
    const acc = await db.account.findFirstOrThrow({ where: { providerId: "google", accountId: claims.sub as string } });
    expect(acc).toMatchObject({ accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null });
    expect(JSON.stringify(acc)).not.toContain("mock-access-token");
    expect(JSON.stringify(acc)).not.toContain("mock-refresh-token");
  });

  it("the account has no password; a visitor cannot sign in with the e-mail and a guess", async () => {
    const claims = googleClaims();
    await g.signInWithGoogle(claims);
    const res = await g.req("POST", "/api/auth/sign-in/email", { body: { email: claims.email, password: TEST_PASSWORD } });
    expect(res.status).toBe(401);
  });
});

describe("returning-user Google sign-in", () => {
  it("reuses the same user and account, and keeps the user's own profile edits", async () => {
    const claims = googleClaims({ name: "Original Name" });
    await g.signInWithGoogle(claims);
    const user = await db.user.findUniqueOrThrow({ where: { email: claims.email as string } });
    // The user edits their app profile; Google later reports different values.
    await db.user.update({ where: { id: user.id }, data: { name: "My Chosen Name", image: null } });

    const again = await g.signInWithGoogle({ ...claims, name: "Google Changed It", picture: "https://lh3.googleusercontent.com/a/new" }, { start: { newUserCallbackURL: "/workspace?welcome=1" } });
    expect(again.location).toBe("/workspace"); // returning user: normal callback, not the new-user URL
    expect(hasSession(again.cookies)).toBe(true);

    expect(await db.user.count({ where: { email: claims.email as string } })).toBe(1);
    expect(await db.account.count({ where: { providerId: "google", accountId: claims.sub as string } })).toBe(1);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.name).toBe("My Chosen Name");
    expect(after.image).toBeNull();
    expect(await db.userProfile.count({ where: { userId: user.id } })).toBe(1);
  });

  it("recognises the person by Google's stable subject id, not the e-mail", async () => {
    const claims = googleClaims();
    await g.signInWithGoogle(claims);
    const user = await db.user.findUniqueOrThrow({ where: { email: claims.email as string } });
    // The Google account's e-mail changed (still verified); same `sub` => same app user.
    const again = await g.signInWithGoogle({ ...claims, email: `moved-${randomUUID()}@example.test` });
    expect(hasSession(again.cookies)).toBe(true);
    const me = await getSessionUserFromHeaders(cookieOf(again.cookies));
    expect(me?.id).toBe(user.id);
  });

  it("keeps existing exam/question/document/conversation data reachable after a Google sign-in", async () => {
    const claims = googleClaims();
    const first = await g.signInWithGoogle(claims);
    const me = (await getSessionUserFromHeaders(cookieOf(first.cookies)))!;
    const conv = await db.conversation.create({ data: { userId: me.id, title: "Photosynthesis notes" } });
    const col = await db.questionCollection.create({ data: { ownerId: me.id, title: "Biology", titleKey: "biology" } });

    const again = await g.signInWithGoogle(claims);
    const res = await g.req("GET", `/api/conversations/${conv.id}`, { cookie: again.cookies, origin: null });
    expect(res.status).toBe(200);
    expect(await db.questionCollection.findUnique({ where: { id: col.id } })).toMatchObject({ ownerId: me.id });
  });
});

describe("cancellation and invalid callbacks", () => {
  it("returns to the login page with access_denied when the user cancels at Google, with no session and no token exchange", async () => {
    const mock = mockGoogleToken(() => tokenResponse(googleClaims()));
    const s = await g.start({ errorCallbackURL: "/login?next=%2Fexams" });
    const cb = await g.callback({ error: "access_denied", state: s.state }, s.cookies);
    mock.restore();
    expect(cb.res.status).toBe(302);
    expect(cb.location).toBe("/login?next=%2Fexams&error=access_denied");
    expect(hasSession(cb.cookies)).toBe(false);
    expect(mock.tokenCalls).toBe(0);
  });

  it("rejects a callback without state", async () => {
    const s = await g.start();
    const cb = await g.callback({ code: "x" }, s.cookies);
    expect(cb.location).toContain("error=state_not_found");
    expect(hasSession(cb.cookies)).toBe(false);
  });

  it("rejects a forged state (CSRF / login-fixation attempt)", async () => {
    const mock = mockGoogleToken(() => tokenResponse(googleClaims()));
    const s = await g.start();
    const cb = await g.callback({ code: "x", state: `${s.state}tampered` }, s.cookies);
    mock.restore();
    expect(cb.location).toMatch(/error=(state_mismatch|please_restart_the_process|invalid_state)/);
    expect(hasSession(cb.cookies)).toBe(false);
    expect(mock.tokenCalls).toBe(0);
  });

  it("rejects a valid state presented by a browser that did not start the flow (no state cookie)", async () => {
    const mock = mockGoogleToken(() => tokenResponse(googleClaims()));
    const s = await g.start();
    const cb = await g.callback({ code: "x", state: s.state }, ""); // attacker-initiated link opened in the victim's browser
    mock.restore();
    expect(cb.location).toMatch(/error=state_mismatch/);
    expect(hasSession(cb.cookies)).toBe(false);
    expect(mock.tokenCalls).toBe(0);
  });

  it("a state value can be used once only (replay)", async () => {
    const claims = googleClaims();
    const mock = mockGoogleToken(() => tokenResponse(claims));
    const s = await g.start();
    const first = await g.callback({ code: "c1", state: s.state }, s.cookies);
    const replay = await g.callback({ code: "c1", state: s.state }, s.cookies);
    mock.restore();
    expect(hasSession(first.cookies)).toBe(true);
    expect(replay.location).toMatch(/error=/);
    expect(mock.tokenCalls).toBe(1);
  });

  it("handles Google rejecting the authorization code (invalid_grant) without a session", async () => {
    const r = await g.signInWithGoogle(googleClaims(), { token: () => ({ status: 400, body: { error: "invalid_grant" } }) });
    expect(r.location).toMatch(/^\/login\?error=/);
    expect(hasSession(r.cookies)).toBe(false);
  });

  it("does not leak the client secret or tokens in any error redirect", async () => {
    const r = await g.signInWithGoogle(googleClaims(), { token: () => ({ status: 500, body: { error: "boom", client_secret: process.env.AUTH_GOOGLE_SECRET } }) });
    expect(r.location).not.toContain(process.env.AUTH_GOOGLE_SECRET!);
    expect(await r.res.text()).not.toContain(process.env.AUTH_GOOGLE_SECRET!);
  });

  it("rejects an unknown provider id", async () => {
    const res = await g.req("POST", "/api/auth/sign-in/social", { body: { provider: "github", callbackURL: "/workspace" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("verified-email handling", () => {
  const refused = async (overrides: Record<string, unknown>, code: string) => {
    const claims = googleClaims(overrides);
    const r = await g.signInWithGoogle(claims);
    expect(errorOf(r.location)).toBe(code);
    expect(r.location.startsWith("/login?")).toBe(true);
    expect(hasSession(r.cookies)).toBe(false);
    expect(await db.user.count({ where: { email: (claims.email as string | undefined)?.toLowerCase() ?? "none@invalid" } })).toBe(0);
    expect(await db.account.count({ where: { accountId: claims.sub as string } })).toBe(0);
  };

  it("refuses an unverified Google e-mail (no user is created)", () => refused({ email_verified: false }, "email_not_verified"));
  it("refuses a missing email_verified claim", () => refused({ email_verified: undefined }, "email_not_verified"));
  it("refuses non-boolean look-alikes such as 'false' or 1", async () => {
    await refused({ email_verified: "false" }, "email_not_verified");
    await refused({ email_verified: 1 }, "email_not_verified");
  });
  it("refuses a missing e-mail", () => refused({ email: undefined }, "email_not_found"));
  it("refuses a missing or empty subject", async () => {
    const claims = googleClaims({ sub: "" });
    const r = await g.signInWithGoogle(claims);
    expect(["invalid_identity", "unable_to_get_user_info"]).toContain(errorOf(r.location));
    expect(hasSession(r.cookies)).toBe(false);
  });
  it("accepts the string 'true' that older Google tokens used", async () => {
    const r = await g.signInWithGoogle(googleClaims({ email_verified: "true" }));
    expect(hasSession(r.cookies)).toBe(true);
  });
});

describe("untrusted profile data", () => {
  it("normalises the name and drops pictures that are not on Google's image CDN", async () => {
    const claims = googleClaims({ name: `  ‮evil\u0000  ${"x".repeat(300)}  `, picture: "https://evil.example/avatar.png" });
    await g.signInWithGoogle(claims);
    const user = await db.user.findUniqueOrThrow({ where: { email: claims.email as string } });
    expect(user.name.length).toBeLessThanOrEqual(80);
    expect(user.name).not.toMatch(/[\p{Cc}\p{Bidi_Control}]/u);
    expect(user.image).toBeNull();
  });

  it.each(["javascript:alert(1)", "http://lh3.googleusercontent.com/a/x", "https://user:pw@lh3.googleusercontent.com/a/x", "https://googleusercontent.com.evil.example/a", "data:image/png;base64,AAAA"])("drops picture %s", async (picture) => {
    const claims = googleClaims({ picture });
    await g.signInWithGoogle(claims);
    expect((await db.user.findUniqueOrThrow({ where: { email: claims.email as string } })).image).toBeNull();
  });

  it("falls back to the e-mail's local part when Google sends no name", async () => {
    const claims = googleClaims({ name: undefined, email: "kabir.hossain@example.test" });
    claims.email = `kabir.hossain+${randomUUID().slice(0, 8)}@example.test`;
    await g.signInWithGoogle(claims);
    expect((await db.user.findUniqueOrThrow({ where: { email: claims.email as string } })).name).toMatch(/^kabir\.hossain/);
  });
});

describe("duplicate provider identities and concurrency", () => {
  it("the database refuses the same Google identity on two users", async () => {
    const a = await createUser();
    const b = await createUser();
    const sub = `dup-${randomUUID()}`;
    await db.account.create({ data: { userId: a.id, providerId: "google", accountId: sub } });
    await expect(db.account.create({ data: { userId: b.id, providerId: "google", accountId: sub } })).rejects.toThrow();
  });

  it("two simultaneous first sign-ins for one Google identity create exactly one user and one link", async () => {
    const claims = googleClaims();
    const mock = mockGoogleToken(() => tokenResponse(claims));
    const [s1, s2] = await Promise.all([g.start(), g.start()]);
    const [c1, c2] = await Promise.all([g.callback({ code: "a", state: s1.state }, s1.cookies), g.callback({ code: "b", state: s2.state }, s2.cookies)]);
    mock.restore();

    expect(await db.user.count({ where: { email: claims.email as string } })).toBe(1);
    expect(await db.account.count({ where: { providerId: "google", accountId: claims.sub as string } })).toBe(1);
    // At least one browser is signed in; the other either is too (same user) or was asked to retry.
    expect([c1, c2].some((c) => hasSession(c.cookies))).toBe(true);
    for (const c of [c1, c2]) if (!hasSession(c.cookies)) expect(c.location).toMatch(/error=/);
  });

  it("refuses to link a Google identity that already belongs to another user", async () => {
    const claims = googleClaims();
    const owner = await g.signInWithGoogle(claims);
    const ownerId = (await getSessionUserFromHeaders(cookieOf(owner.cookies)))!.id;

    // A different signed-in user whose e-mail matches the Google e-mail, so only the ownership rule can stop the link.
    const intruder = await createUser();
    const stolen = { ...claims, email: intruder.email };
    const mock = mockGoogleToken(() => tokenResponse(stolen));
    const link = await g.req("POST", "/api/auth/link-social", { cookie: intruder.headers.get("cookie")!, body: { provider: "google", callbackURL: "/settings/privacy", errorCallbackURL: "/settings/privacy" } });
    const url = new URL(((await link.json()) as { url: string }).url);
    const cb = await g.callback({ code: "z", state: url.searchParams.get("state")! }, mergeCookies(intruder.headers.get("cookie")!, link));
    mock.restore();
    expect(errorOf(cb.location)).toBe("account_already_linked_to_different_user");
    expect(await db.account.count({ where: { providerId: "google", accountId: claims.sub as string } })).toBe(1);
    expect((await db.account.findFirstOrThrow({ where: { providerId: "google", accountId: claims.sub as string } })).userId).toBe(ownerId);
    expect(await accountsOf(intruder.id)).toHaveLength(1);
  });
});

function mergeCookies(existing: string, res: Response): string {
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter(Boolean);
  return [existing, ...set].join("; ");
}

describe("existing password accounts and account linking", () => {
  it("does NOT sign a Google user into an existing account just because the e-mail matches", async () => {
    const pw = await createUser();
    const r = await g.signInWithGoogle(googleClaims({ email: pw.email }));
    expect(errorOf(r.location)).toBe("account_not_linked");
    expect(hasSession(r.cookies)).toBe(false);
    expect(await accountsOf(pw.id)).toHaveLength(1); // still only the credential account
  });

  it("does not link even when the existing account's e-mail is verified (linking is always explicit)", async () => {
    const pw = await createUser();
    await db.user.update({ where: { id: pw.id }, data: { emailVerified: true } });
    const r = await g.signInWithGoogle(googleClaims({ email: pw.email }));
    expect(errorOf(r.location)).toBe("account_not_linked");
    expect(hasSession(r.cookies)).toBe(false);
    expect((await accountsOf(pw.id)).map((a) => a.providerId)).toEqual(["credential"]);
  });

  it("does not touch the existing user's profile or password", async () => {
    const pw = await createUser({ name: "Password Person" });
    const before = await db.account.findFirstOrThrow({ where: { userId: pw.id, providerId: "credential" } });
    await g.signInWithGoogle(googleClaims({ email: pw.email, name: "Attacker Name" }));
    const user = await db.user.findUniqueOrThrow({ where: { id: pw.id } });
    expect(user.name).toBe("Password Person");
    const after = await db.account.findFirstOrThrow({ where: { userId: pw.id, providerId: "credential" } });
    expect(after.password).toBe(before.password);
  });

  it("lets a signed-in owner connect Google explicitly; afterwards Google signs into the SAME account with all its data", async () => {
    const pw = await createUser();
    const conv = await db.conversation.create({ data: { userId: pw.id, title: "Mine" } });
    const claims = googleClaims({ email: pw.email });
    const mock = mockGoogleToken(() => tokenResponse(claims));

    const link = await g.req("POST", "/api/auth/link-social", { cookie: pw.headers.get("cookie")!, body: { provider: "google", callbackURL: "/settings/privacy?linked=google", errorCallbackURL: "/settings/privacy" } });
    expect(link.status).toBe(200);
    const url = new URL(((await link.json()) as { url: string }).url);
    expect(url.hostname).toBe("accounts.google.com");
    const cb = await g.callback({ code: "link", state: url.searchParams.get("state")! }, mergeCookies(pw.headers.get("cookie")!, link));
    mock.restore();
    expect(cb.location).toBe("/settings/privacy?linked=google");

    expect((await accountsOf(pw.id)).map((a) => a.providerId).sort()).toEqual(["credential", "google"]);
    expect(await db.user.count({ where: { email: pw.email } })).toBe(1);

    const later = await g.signInWithGoogle(claims);
    expect(hasSession(later.cookies)).toBe(true);
    expect((await getSessionUserFromHeaders(cookieOf(later.cookies)))!.id).toBe(pw.id);
    const res = await g.req("GET", `/api/conversations/${conv.id}`, { cookie: later.cookies, origin: null });
    expect(res.status).toBe(200);
  });

  it("refuses to connect a Google account with a different e-mail", async () => {
    const pw = await createUser();
    const claims = googleClaims(); // different e-mail
    const mock = mockGoogleToken(() => tokenResponse(claims));
    const link = await g.req("POST", "/api/auth/link-social", { cookie: pw.headers.get("cookie")!, body: { provider: "google", callbackURL: "/settings/privacy", errorCallbackURL: "/settings/privacy" } });
    const url = new URL(((await link.json()) as { url: string }).url);
    const cb = await g.callback({ code: "link", state: url.searchParams.get("state")! }, mergeCookies(pw.headers.get("cookie")!, link));
    mock.restore();
    expect(cb.location).toBe("/settings/privacy?error=email_does_not_match");
    expect(await accountsOf(pw.id)).toHaveLength(1);
  });

  it("requires a signed-in user to start linking", async () => {
    const res = await g.req("POST", "/api/auth/link-social", { body: { provider: "google", callbackURL: "/settings/privacy" } });
    expect(res.status).toBe(401);
  });

  it("requires a FRESH session to start linking (a stolen older session cannot attach an attacker's Google account)", async () => {
    const pw = await createUser();
    await db.session.updateMany({ where: { userId: pw.id }, data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const res = await g.req("POST", "/api/auth/link-social", { cookie: pw.headers.get("cookie")!, body: { provider: "google", callbackURL: "/settings/privacy" } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("SESSION_NOT_FRESH");
  });

  it("lists sign-in methods without exposing provider ids, tokens or hashes", async () => {
    const pw = await createUser();
    await db.account.create({ data: { userId: pw.id, providerId: "google", accountId: `sub-${randomUUID()}` } });
    const res = await g.req("GET", "/api/account/sign-in-methods", { cookie: pw.headers.get("cookie")!, origin: null });
    const body = await res.json();
    expect(body).toMatchObject({ hasPassword: true, googleAvailable: true, providers: [{ provider: "google" }] });
    expect(JSON.stringify(body)).not.toContain("sub-");
    expect(Object.keys((body as { providers: object[] }).providers[0]!).sort()).toEqual(["id", "linkedAt", "provider"]);
  });

  it("can disconnect Google when another sign-in method remains, but never the last method", async () => {
    const pw = await createUser();
    const google = await db.account.create({ data: { userId: pw.id, providerId: "google", accountId: `sub-${randomUUID()}` } });
    const ok = await g.req("POST", "/api/auth/unlink-account", { cookie: pw.headers.get("cookie")!, body: { accountId: google.id } });
    expect(ok.status).toBe(200);
    const credential = await db.account.findFirstOrThrow({ where: { userId: pw.id, providerId: "credential" } });
    const blocked = await g.req("POST", "/api/auth/unlink-account", { cookie: pw.headers.get("cookie")!, body: { accountId: credential.id } });
    expect(blocked.status).toBe(400);
    expect(await accountsOf(pw.id)).toHaveLength(1);
  });

  it("a Google-only user cannot remove their only sign-in method", async () => {
    const r = await g.signInWithGoogle(googleClaims());
    const me = (await getSessionUserFromHeaders(cookieOf(r.cookies)))!;
    const acc = await db.account.findFirstOrThrow({ where: { userId: me.id } });
    const res = await g.req("POST", "/api/auth/unlink-account", { cookie: r.cookies, body: { accountId: acc.id } });
    expect(res.status).toBe(400);
    expect(await accountsOf(me.id)).toHaveLength(1);
  });

  it("a Google-created account can't be pre-registered with a password by someone else", async () => {
    const claims = googleClaims();
    await g.signInWithGoogle(claims);
    const res = await g.req("POST", "/api/auth/sign-up/email", { body: { name: "Squatter", email: claims.email, password: TEST_PASSWORD } });
    // The response must not create a second account or reveal a session for the Google user.
    expect(await db.user.count({ where: { email: claims.email as string } })).toBe(1);
    expect(hasSession(cookieJarOf(res))).toBe(false);
  });
});

const cookieJarOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

describe("cross-user data isolation", () => {
  it("two Google users only ever see their own data", async () => {
    const a = await g.signInWithGoogle(googleClaims());
    const b = await g.signInWithGoogle(googleClaims());
    const aid = (await getSessionUserFromHeaders(cookieOf(a.cookies)))!.id;
    const bid = (await getSessionUserFromHeaders(cookieOf(b.cookies)))!.id;
    expect(aid).not.toBe(bid);

    const conv = await db.conversation.create({ data: { userId: aid, title: "A's private notes" } });
    expect((await g.req("GET", `/api/conversations/${conv.id}`, { cookie: b.cookies, origin: null })).status).toBe(404);
    expect((await g.req("GET", `/api/conversations/${conv.id}`, { cookie: a.cookies, origin: null })).status).toBe(200);
    const list = (await (await g.req("GET", "/api/conversations", { cookie: b.cookies, origin: null })).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).not.toContain(conv.id);
    expect((await g.req("DELETE", `/api/conversations/${conv.id}`, { cookie: b.cookies })).status).toBe(404);
  });

  it("a Google session cannot reach admin APIs", async () => {
    const a = await g.signInWithGoogle(googleClaims());
    expect([403, 404]).toContain((await g.req("GET", "/api/admin/users", { cookie: a.cookies, origin: null })).status);
  });
});

describe("post-login redirects", () => {
  const start = (body: Record<string, unknown>) => g.req("POST", "/api/auth/sign-in/social", { body: { provider: "google", ...body } });

  it.each(["https://evil.example/phish", "//evil.example", "http://localhost:3100.evil.example/", "javascript:alert(1)", "/\\evil.example", "https://localhost:3100/x"])("rejects callbackURL %s", async (callbackURL) => {
    const res = await start({ callbackURL });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects an untrusted errorCallbackURL or newUserCallbackURL", async () => {
    expect((await start({ callbackURL: "/workspace", errorCallbackURL: "https://evil.example" })).status).toBeGreaterThanOrEqual(400);
    expect((await start({ callbackURL: "/workspace", newUserCallbackURL: "https://evil.example" })).status).toBeGreaterThanOrEqual(400);
  });

  it("accepts relative paths and our own origin", async () => {
    expect((await start({ callbackURL: "/exams/abc?x=1" })).status).toBe(200);
    expect((await start({ callbackURL: "http://localhost:3100/workspace" })).status).toBe(200);
  });

  it("refuses cross-origin initiation (CSRF)", async () => {
    const res = await g.req("POST", "/api/auth/sign-in/social", { origin: "https://evil.example", body: { provider: "google", callbackURL: "/workspace" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("redirects a successful sign-in to the originally requested authorized page", async () => {
    const r = await g.signInWithGoogle(googleClaims(), { start: { callbackURL: "/exams/abc123", newUserCallbackURL: "/exams/abc123" } });
    expect(r.location).toBe("/exams/abc123");
  });
});

describe("logout and session invalidation", () => {
  it("sign-out deletes the server session; the old cookie stops working", async () => {
    const r = await g.signInWithGoogle(googleClaims());
    expect((await g.req("GET", "/api/me", { cookie: r.cookies, origin: null })).status).toBe(200);
    const out = await g.req("POST", "/api/auth/sign-out", { cookie: r.cookies, body: {} });
    expect(out.status).toBe(200);
    expect((await g.req("GET", "/api/me", { cookie: r.cookies, origin: null })).status).toBe(401);
  });

  it("session cookies are HttpOnly and SameSite=Lax", async () => {
    const r = await g.signInWithGoogle(googleClaims());
    const set = r.res.headers.getSetCookie().find((c) => c.includes("session_token"))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
  });

  it("a suspended user is refused at Google sign-in and their sessions stop working", async () => {
    const claims = googleClaims();
    const first = await g.signInWithGoogle(claims);
    const me = (await getSessionUserFromHeaders(cookieOf(first.cookies)))!;
    await db.user.update({ where: { id: me.id }, data: { status: "SUSPENDED" } });

    expect((await g.req("GET", "/api/me", { cookie: first.cookies, origin: null })).status).toBe(401);
    const again = await g.signInWithGoogle(claims);
    expect(hasSession(again.cookies)).toBe(false);
    expect(again.location).toContain("error=account_suspended");
  });
});

describe("rate limiting", () => {
  it("throttles repeated Google sign-in initiation from one client", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await g.req("POST", "/api/auth/sign-in/social", { ip, body: { provider: "google", callbackURL: "/workspace" } })).status);
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
  });

  it("throttles the callback endpoint too", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 26; i++) statuses.push((await g.req("GET", "/api/auth/callback/google?code=x&state=y", { ip, origin: null })).status);
    expect(statuses).toContain(429);
  });
});

describe("Google-only accounts (no password)", () => {
  it("can delete the account with a fresh sign-in; the Google link and data go with it", async () => {
    const claims = googleClaims();
    const r = await g.signInWithGoogle(claims);
    const me = (await getSessionUserFromHeaders(cookieOf(r.cookies)))!;
    await db.conversation.create({ data: { userId: me.id, title: "to be erased" } });

    const res = await g.req("POST", "/api/auth/delete-user", { cookie: r.cookies, body: {} });
    expect(res.status).toBe(200);
    expect(await db.user.count({ where: { id: me.id } })).toBe(0);
    expect(await db.account.count({ where: { accountId: claims.sub as string } })).toBe(0);
    expect(await db.conversation.count({ where: { userId: me.id } })).toBe(0);
  });

  it("must have signed in recently to delete the account", async () => {
    const r = await g.signInWithGoogle(googleClaims());
    const me = (await getSessionUserFromHeaders(cookieOf(r.cookies)))!;
    await db.session.updateMany({ where: { userId: me.id }, data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
    const res = await g.req("POST", "/api/auth/delete-user", { cookie: r.cookies, body: {} });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await res.json())).toMatch(/SESSION_EXPIRED|SESSION_NOT_FRESH/);
    expect(await db.user.count({ where: { id: me.id } })).toBe(1);
  });

  it("can add a first password through the e-mailed reset link; Google keeps working", async () => {
    const claims = googleClaims();
    const r = await g.signInWithGoogle(claims);
    const me = (await getSessionUserFromHeaders(cookieOf(r.cookies)))!;
    expect(await db.account.count({ where: { userId: me.id, providerId: "credential" } })).toBe(0);

    const ask = await g.req("POST", "/api/auth/request-password-reset", { cookie: r.cookies, body: { email: claims.email, redirectTo: "/reset-password" } });
    expect(ask.status).toBe(200);
    const row = await db.verification.findFirstOrThrow({ where: { identifier: { startsWith: "reset-password:" }, value: me.id }, orderBy: { createdAt: "desc" } });
    const token = row.identifier.replace("reset-password:", "");
    const done = await g.req("POST", "/api/auth/reset-password", { body: { newPassword: TEST_PASSWORD, token } });
    expect(done.status).toBe(200);

    expect(await db.account.count({ where: { userId: me.id, providerId: "credential" } })).toBe(1);
    expect((await g.req("GET", "/api/me", { cookie: r.cookies, origin: null })).status).toBe(401); // a reset signs out every device
    const pw = await g.req("POST", "/api/auth/sign-in/email", { body: { email: claims.email, password: TEST_PASSWORD } });
    expect(pw.status).toBe(200);
    const again = await g.signInWithGoogle(claims);
    expect(hasSession(again.cookies)).toBe(true);
    expect((await getSessionUserFromHeaders(cookieOf(again.cookies)))!.id).toBe(me.id);
  });
});
