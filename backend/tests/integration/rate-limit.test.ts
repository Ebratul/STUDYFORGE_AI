import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkRateLimit } from "../../src/lib/rate-limit.js";
import { getAuth } from "../../src/auth/auth.js";
import { db } from "../../src/lib/db.js";

describe("application rate limiter", () => {
  it("allows up to the limit then blocks with a retry hint", async () => {
    const key = `t:${randomUUID()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkRateLimit({ key, limit: 3, windowSec: 60 }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[3]!.retryAfterSec).toBeGreaterThan(0);
    expect(results[0]!.remaining).toBe(2);
  });

  it("is atomic under concurrency (exactly `limit` requests succeed)", async () => {
    const key = `t:${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 25 }, () => checkRateLimit({ key, limit: 10, windowSec: 60 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("resets after the window elapses", async () => {
    const key = `t:${randomUUID()}`;
    await checkRateLimit({ key, limit: 1, windowSec: 60 });
    expect((await checkRateLimit({ key, limit: 1, windowSec: 60 })).allowed).toBe(false);
    await db.rateLimitBucket.update({ where: { key }, data: { windowStart: new Date(Date.now() - 120_000) } });
    expect((await checkRateLimit({ key, limit: 1, windowSec: 60 })).allowed).toBe(true);
  });

  it("keys are independent", async () => {
    const a = `t:${randomUUID()}`;
    const b = `t:${randomUUID()}`;
    await checkRateLimit({ key: a, limit: 1, windowSec: 60 });
    expect((await checkRateLimit({ key: a, limit: 1, windowSec: 60 })).allowed).toBe(false);
    expect((await checkRateLimit({ key: b, limit: 1, windowSec: 60 })).allowed).toBe(true);
  });
});

describe("auth endpoint rate limiting (Better Auth, database storage)", () => {
  it("throttles repeated sign-in attempts from one client", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const attempt = () =>
      getAuth().handler(
        new Request("http://localhost:3100/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3100", "x-forwarded-for": ip },
          body: JSON.stringify({ email: "nobody@example.test", password: "Wrong-password-1" }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
  });
});
