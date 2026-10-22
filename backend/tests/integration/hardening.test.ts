import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "../../src/auth/auth.js";
import type { AppEnv } from "../../src/http/context.js";
import { errorCategory, onError, requestContext } from "../../src/http/middleware.js";
import { AppError } from "../../src/lib/errors.js";
import { db } from "../../src/lib/db.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, signInAgain, TEST_ORIGIN, TEST_PASSWORD } from "../helpers/users.js";
import { seedBankQuestions, seedPublishedExam, seedGroup } from "../helpers/exam-fixtures.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => vi.restoreAllMocks());

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? (f === "generated" ? [] : walk(join(dir, f))) : f.endsWith(".ts") ? [join(dir, f)] : []));

describe("static review: SQL and secrets in source", () => {
  it("never uses unsafe raw SQL APIs (only tagged, parameterised templates)", () => {
    const offenders = walk("src").filter((f) => /\$(query|execute)RawUnsafe|Prisma\.raw\(/.test(readFileSync(f, "utf8")));
    // Reviewed exception: the leaderboard builds its distribution-band SQL from compile-time numeric constants (DISTRIBUTION), never from input.
    expect(offenders.filter((f) => !f.endsWith("modules/groups/leaderboard.ts"))).toEqual([]);
  });

  it("does not build SQL by string concatenation or untagged template literals passed to raw queries", () => {
    const bad: string[] = [];
    for (const f of walk("src")) {
      const text = readFileSync(f, "utf8");
      // $queryRaw(`...`) / $executeRaw(`...`) with a plain template string would be interpolated, not parameterised
      if (/\$(query|execute)Raw\(\s*[`"']/.test(text)) bad.push(f);
      if (/\$(query|execute)Raw\([^)]*\+/.test(text)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });
});

describe("every mutating /api route is guarded", () => {
  const mutating = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const routes = () => {
    const app = makeApp().app;
    const seen = new Set<string>();
    for (const r of app.routes) {
      if (!mutating.has(r.method) || !r.path.startsWith("/api") || r.path.startsWith("/api/auth")) continue;
      seen.add(`${r.method} ${r.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x").replace(/\*/g, "x")}`);
    }
    return [...seen].map((k) => k.split(" ") as [string, string]);
  };

  it("enumerates a meaningful number of routes", () => {
    expect(routes().length).toBeGreaterThan(50);
  });

  it("rejects cross-origin and origin-less calls before anything else (CSRF guard), for every route", async () => {
    for (const [method, path] of routes()) {
      for (const origin of ["https://evil.example", undefined]) {
        const res = await t.app.request(path, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: method === "DELETE" ? undefined : "{}" });
        expect(res.status, `${method} ${path} origin=${origin}`).toBe(403);
        expect((await res.json()).error.code).toBe("BAD_ORIGIN");
      }
    }
  });

  it("requires a session on every route when the origin is right", async () => {
    for (const [method, path] of routes()) {
      const res = await t.app.request(path, { method, headers: { origin: TEST_ORIGIN, "content-type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("list endpoints cap their page size", () => {
  it("rejects (422) or caps (<= 100 items) oversized page requests", async () => {
    const u = await createUser();
    const c = client(t, u);
    const conv = (await (await c.post("/api/conversations", { title: "x" })).json()).conversation.id as string;
    const col = (await (await c.post("/api/collections", { title: "c" })).json()).collection.id as string;
    const group = await seedGroup(u);
    const { exam } = await seedPublishedExam({ owner: u, group });
    const urls = [
      "/api/conversations?limit=100000", `/api/conversations/${conv}/messages?limit=100000`, "/api/questions?pageSize=100000", "/api/collections?pageSize=100000", `/api/collections/${col}/questions?pageSize=100000`,
      "/api/exams?scope=mine&pageSize=100000", "/api/attempts?pageSize=100000", `/api/groups/${group.id}/members?pageSize=100000`, `/api/groups/${group.id}/exams?pageSize=100000`,
      `/api/exams/${exam.id}/leaderboard?pageSize=100000`, `/api/exams/${exam.id}/participants?pageSize=100000`, "/api/generation/runs?limit=100000",
    ];
    for (const url of urls) {
      const res = await c.get(url);
      if (res.status === 422) continue;
      expect(res.status, url).toBe(200);
      const body = await res.json();
      const items = (body.items ?? body.messages ?? []) as unknown[];
      expect(items.length, url).toBeLessThanOrEqual(100);
    }
  });
});

describe("responses and headers", () => {
  it("every API response (success and error) is no-store, nosniff and carries a request id", async () => {
    const u = await createUser();
    for (const [res, label] of [
      [await client(t, u).get("/api/me"), "200"],
      [await client(t).get("/api/me"), "401"],
      [await client(t, u).get("/api/does-not-exist"), "404"],
      [await client(t, u).patch("/api/profile", { name: "" }), "422"],
      [await t.app.request("/api/profile", { method: "PATCH", headers: { origin: "https://evil.example" }, body: "{}" }), "403"],
    ] as const) {
      expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      expect(res.headers.get("x-request-id"), label).toBeTruthy();
    }
  });

  it("public health endpoints expose no configuration or secrets", async () => {
    expect(await (await client(t).get("/api/health")).json()).toEqual({ status: "ok" });
    const ready = await (await client(t).get("/api/ready")).json();
    expect(Object.keys(ready).sort()).toEqual(["ai", "status"]);
    expect(JSON.stringify(ready)).not.toMatch(/postgres|secret|token|url/i);
  });

  it("unexpected errors return a generic message: no stack, SQL, paths or upstream text", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", requestContext);
    app.onError(onError);
    app.get("/boom", () => {
      throw new Error('select * from "User" where password = $1 failed at /srv/app/src/db.ts:12 Bearer abcdefghijklmnop');
    });
    app.get("/typed", () => {
      throw new AppError("PROVIDER_ERROR", "The AI provider returned an error.", { providerCode: "PROVIDER_TIMEOUT" });
    });
    const errLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Something went wrong. Please try again.", requestId: expect.any(String) } });
    const logged = errLog.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"category":"internal"');
    expect(logged).not.toMatch(/abcdefghijklmnop/); // secrets are redacted even in server logs
    const typed = await (await app.request("/typed")).json();
    expect(typed.error.code).toBe("PROVIDER_ERROR");
    expect(JSON.stringify(typed)).not.toMatch(/stack|select \*/i);
  });

  it("classifies error codes into the documented categories", () => {
    expect(errorCategory("VALIDATION")).toBe("validation");
    expect(errorCategory("UNAUTHENTICATED")).toBe("auth");
    expect(errorCategory("NOT_ELIGIBLE")).toBe("auth");
    expect(errorCategory("RATE_LIMITED")).toBe("rate_limit");
    expect(errorCategory("QUOTA_EXCEEDED")).toBe("rate_limit");
    expect(errorCategory("PROVIDER_ERROR")).toBe("upstream");
    expect(errorCategory("GENERATION_FAILED")).toBe("upstream");
    expect(errorCategory("INTERNAL")).toBe("internal");
  });
});

describe("session invalidation", () => {
  it("changing the password ends every other session even if the client doesn't ask for it", async () => {
    const u = await createUser();
    const other = await signInAgain(u);
    expect(await db.session.count({ where: { userId: u.id } })).toBeGreaterThanOrEqual(2);
    const res = await getAuth().api.changePassword({ headers: u.headers, body: { currentPassword: TEST_PASSWORD, newPassword: "Another-strong-pass-77", revokeOtherSessions: false }, asResponse: true });
    expect(res.status).toBe(200);
    expect((await t.app.request("/api/me", { headers: other })).status).toBe(401);
    expect((await t.app.request("/api/me", { headers: u.headers })).status).toBe(200); // the session that made the change survives
  });

  it("deleting data of a suspended user's questions still works through ownership rules only (no admin bypass)", async () => {
    const [u] = [await createUser()];
    const [q] = await seedBankQuestions(u, 1);
    const admin = await createUser();
    await db.user.update({ where: { id: admin.id }, data: { role: "ADMIN" } });
    expect((await client(t, admin).delete(`/api/questions/${q!.id}`)).status).toBe(404);
    expect(await db.question.count({ where: { id: q!.id } })).toBe(1);
  });
});
