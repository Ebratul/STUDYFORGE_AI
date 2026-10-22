import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, makeAdmin, signInAgain } from "../helpers/users.js";

let t: TestApp;
beforeAll(() => {
  t = makeApp();
});

describe("authentication on the HTTP API", () => {
  it("rejects anonymous requests to every protected route with 401", async () => {
    const c = client(t);
    for (const path of ["/api/me", "/api/profile", "/api/notifications", "/api/sessions", "/api/account/export", "/api/ai/credentials", "/api/ai/preferences", "/api/conversations", "/api/documents", "/api/documents/limits", "/api/admin/overview"]) {
      const res = await c.get(path);
      expect(res.status, path).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("GET /api/me returns the session user and never leaks sensitive fields", async () => {
    const u = await createUser({ name: "Ayesha" });
    const res = await client(t, u).get("/api/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ id: u.id, email: u.email, role: "USER" });
    expect(JSON.stringify(body)).not.toMatch(/password|token|secret/i);
    expect(body.unread).toBe(1); // welcome notification
  });
});

describe("CSRF: mutating requests must carry our Origin", () => {
  it("blocks cross-origin and origin-less mutations", async () => {
    const u = await createUser();
    for (const origin of ["https://evil.example", ""]) {
      const res = await t.app.request("/api/profile", {
        method: "PATCH",
        headers: { cookie: u.headers.get("cookie")!, "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify({ name: "Hacked", timezone: "UTC" }),
      });
      expect(res.status).toBe(403);
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).name).not.toBe("Hacked");
  });
});

describe("cross-user access is denied", () => {
  it("notifications: B cannot read or mark A's notification", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const aNote = await db.notification.findFirstOrThrow({ where: { userId: a.id } });
    const cb = client(t, b);
    const list = await (await cb.get("/api/notifications")).json();
    expect(list.items.some((n: { id: string }) => n.id === aNote.id)).toBe(false);
    expect((await cb.post(`/api/notifications/${aNote.id}/read`)).status).toBe(404);
    expect((await cb.post("/api/notifications/read-all")).status).toBe(200);
    expect((await db.notification.findUniqueOrThrow({ where: { id: aNote.id } })).readAt).toBeNull();
    expect((await client(t, a).post(`/api/notifications/${aNote.id}/read`)).status).toBe(200);
  });

  it("sessions: B cannot list or revoke A's sessions; revoke-others spares the caller", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const aSession = await db.session.findFirstOrThrow({ where: { userId: a.id } });
    const cb = client(t, b);
    const list = await (await cb.get("/api/sessions")).json();
    expect(list.items.some((s: { id: string }) => s.id === aSession.id)).toBe(false);
    expect((await cb.delete(`/api/sessions/${aSession.id}`)).status).toBe(404);
    await cb.post("/api/sessions/revoke-others");
    expect(await db.session.findUnique({ where: { id: aSession.id } })).not.toBeNull();

    const second = await signInAgain(a);
    const ca = client(t, a);
    expect((await ca.post("/api/sessions/revoke-others")).status).toBe(200);
    expect((await ca.get("/api/me")).status).toBe(200);
    expect((await client(t, { headers: second }).get("/api/me")).status).toBe(401);
  });

  it("sessions: sessions list never contains tokens", async () => {
    const u = await createUser();
    const text = await (await client(t, u).get("/api/sessions")).text();
    const token = (await db.session.findFirstOrThrow({ where: { userId: u.id } })).token;
    expect(text).not.toContain(token);
  });

  it("the current session cannot be revoked by id", async () => {
    const u = await createUser();
    const c = client(t, u);
    const { items } = await (await c.get("/api/sessions")).json();
    const current = items.find((s: { current: boolean }) => s.current);
    expect((await c.delete(`/api/sessions/${current.id}`)).status).toBe(403);
    expect((await c.get("/api/me")).status).toBe(200);
  });

  it("profile and preferences updates only affect the caller", async () => {
    const [a, b] = [await createUser({ name: "Alice" }), await createUser({ name: "Bob" })];
    const ca = client(t, a);
    expect((await ca.patch("/api/profile", { name: "Alice Updated", displayName: "Al", bio: "hi", timezone: "Asia/Dhaka" })).status).toBe(200);
    expect((await ca.patch("/api/preferences", { theme: "DARK", locale: "bn", emailNotifications: false })).status).toBe(200);
    const bUser = await db.user.findUniqueOrThrow({ where: { id: b.id }, include: { profile: true, preference: true } });
    expect(bUser.name).toBe("Bob");
    expect(bUser.profile?.bio).toBeNull();
    expect(bUser.preference?.theme).toBe("SYSTEM");
  });

  it("profile validation returns field errors", async () => {
    const u = await createUser();
    const res = await client(t, u).patch("/api/profile", { name: "", bio: "x".repeat(300), timezone: "Mars/Base" });
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.details.fields).toMatchObject({ name: "Enter your name.", bio: "Use at most 280 characters.", timezone: "Choose a valid time zone." });
  });

  it("data export contains only the caller's data and never credentials", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await client(t, a).put("/api/ai/credentials/mock", { apiKey: "mock-valid-key" });
    const text = await (await client(t, a).get("/api/account/export")).text();
    expect(text).toContain(a.email);
    expect(text).not.toContain(b.email);
    expect(text).not.toMatch(/mock-valid-key|ciphertext|authTag/);
  });
});

describe("admin surface", () => {
  it("is invisible (404) to regular users and works for admins; demotion applies immediately", async () => {
    const u = await createUser();
    const c = client(t, u);
    expect((await c.get("/api/admin/overview")).status).toBe(404);
    await makeAdmin(u.id);
    const res = await c.get("/api/admin/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/@example\.test/); // no emails in admin aggregates
    await db.user.update({ where: { id: u.id }, data: { role: "USER" } });
    expect((await c.get("/api/admin/overview")).status).toBe(404);
  });
});

describe("health", () => {
  it("health and readiness respond without auth and without internals", async () => {
    expect(await (await client(t).get("/api/health")).json()).toEqual({ status: "ok" });
    const ready = await (await client(t).get("/api/ready")).json();
    expect(ready.status).toBe("ready");
    expect(ready.ai).toBe("up");
  });
});
