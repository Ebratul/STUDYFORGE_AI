import { describe, expect, it } from "vitest";
import { getAuth } from "../../src/auth/auth.js";
import { getSessionUserFromHeaders } from "../../src/auth/session.js";
import { db } from "../../src/lib/db.js";
import { createUser, signInAgain, TEST_PASSWORD, makeAdmin } from "../helpers/users.js";
import { randomUUID } from "node:crypto";

describe("registration", () => {
  it("creates the user, profile, preferences, welcome notification and audit event", async () => {
    const u = await createUser({ name: "Rima Akter" });
    const [user, profile, pref, notes, audit] = await Promise.all([
      db.user.findUnique({ where: { id: u.id } }),
      db.userProfile.findUnique({ where: { userId: u.id } }),
      db.userPreference.findUnique({ where: { userId: u.id } }),
      db.notification.findMany({ where: { userId: u.id } }),
      db.auditEvent.findMany({ where: { actorId: u.id, action: "auth.sign_up" } }),
    ]);
    expect(user?.role).toBe("USER");
    expect(user?.status).toBe("ACTIVE");
    expect(profile?.displayName).toBe("Rima Akter");
    expect(pref?.theme).toBe("SYSTEM");
    expect(notes.map((n) => n.type)).toContain("system.welcome");
    expect(audit).toHaveLength(1);
  });

  it("stores a hashed password, never the plaintext", async () => {
    const u = await createUser();
    const account = await db.account.findFirst({ where: { userId: u.id, providerId: "credential" } });
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain(TEST_PASSWORD);
  });

  it("ignores attempts to self-assign the ADMIN role at sign-up", async () => {
    const email = `evil-${randomUUID()}@example.test`;
    // `input: false` fields are rejected or ignored depending on version; either way the role must stay USER.
    await getAuth().api
      .signUpEmail({ body: { name: "Evil", email, password: TEST_PASSWORD, role: "ADMIN" } as never })
      .catch(() => undefined);
    const user = await db.user.findUnique({ where: { email } });
    if (user) expect(user.role).toBe("USER");
  });

  it("rejects weak passwords", async () => {
    await expect(getAuth().api.signUpEmail({ body: { name: "A", email: `w-${randomUUID()}@example.test`, password: "short" } })).rejects.toThrow();
  });
});

describe("sign in", () => {
  it("rejects a wrong password and an unknown email with the same status", async () => {
    const u = await createUser();
    const wrong = await getAuth().api.signInEmail({ body: { email: u.email, password: "Wrong-password-1" } }).catch((e) => e);
    const unknown = await getAuth().api.signInEmail({ body: { email: `nobody-${randomUUID()}@example.test`, password: "Wrong-password-1" } }).catch((e) => e);
    expect(wrong.status).toBe(unknown.status);
    expect(wrong.message).toBe(unknown.message);
  });

  it("resolves the session user, including role and status, from cookies", async () => {
    const u = await createUser();
    const session = await getSessionUserFromHeaders(u.headers);
    expect(session?.id).toBe(u.id);
    expect(session?.role).toBe("USER");
  });

  it("returns null without credentials or with a forged cookie", async () => {
    expect(await getSessionUserFromHeaders(new Headers())).toBeNull();
    expect(await getSessionUserFromHeaders(new Headers({ cookie: "studyforge.session_token=forged.value" }))).toBeNull();
  });

  it("picks up role changes immediately (no stale cached role)", async () => {
    const u = await createUser();
    expect((await getSessionUserFromHeaders(u.headers))?.role).toBe("USER");
    await makeAdmin(u.id);
    expect((await getSessionUserFromHeaders(u.headers))?.role).toBe("ADMIN");
  });
});

describe("suspension", () => {
  it("invalidates existing sessions on the next request and blocks new sign-ins", async () => {
    const u = await createUser();
    expect(await getSessionUserFromHeaders(u.headers)).not.toBeNull();
    await db.user.update({ where: { id: u.id }, data: { status: "SUSPENDED" } });
    expect(await getSessionUserFromHeaders(u.headers)).toBeNull();
    await expect(signInAgain(u)).rejects.toThrow();
  });
});

describe("session invalidation on sensitive changes", () => {
  it("changing the password with revokeOtherSessions signs out other devices", async () => {
    const u = await createUser();
    const other = await signInAgain(u);
    expect(await getSessionUserFromHeaders(other)).not.toBeNull();
    await getAuth().api.changePassword({
      headers: u.headers,
      body: { currentPassword: TEST_PASSWORD, newPassword: "Another-strong-pass-2", revokeOtherSessions: true },
    });
    expect(await getSessionUserFromHeaders(other)).toBeNull();
  });

  it("logout invalidates the session server-side", async () => {
    const u = await createUser();
    await getAuth().api.signOut({ headers: u.headers });
    expect(await getSessionUserFromHeaders(u.headers)).toBeNull();
  });

  it("account deletion removes the user and cascades owned rows but keeps anonymised audit events", async () => {
    const u = await createUser();
    await getAuth().api.deleteUser({ headers: u.headers, body: { password: TEST_PASSWORD } });
    expect(await db.user.findUnique({ where: { id: u.id } })).toBeNull();
    expect(await db.notification.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.userProfile.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
    const trail = await db.auditEvent.findMany({ where: { targetId: u.id, action: { in: ["account.deletion_requested", "account.deleted"] } } });
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((e) => e.actorId === null)).toBe(true);
  });

  it("refuses account deletion with a wrong password", async () => {
    const u = await createUser();
    await expect(getAuth().api.deleteUser({ headers: u.headers, body: { password: "Nope-nope-nope-1" } })).rejects.toThrow();
    expect(await db.user.findUnique({ where: { id: u.id } })).not.toBeNull();
  });
});
