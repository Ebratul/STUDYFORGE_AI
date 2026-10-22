import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClock } from "../../src/lib/clock.js";
import { db } from "../../src/lib/db.js";
import { client, makeApp, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";
import { withEnv } from "../helpers/with-env.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => setClock(null));

const rec = (u: TestUser, category: string, quantity: number, task: string, at = new Date()) =>
  db.usageRecord.create({ data: { userId: u.id, category, quantity: BigInt(quantity), metadata: { task, provider: "mock", model: "m" }, createdAt: at } });

describe("GET /api/ai/usage", () => {
  it("returns daily, monthly, per-task breakdown and an honest no-cost note; flat daily fields are kept", async () => {
    const [u, other] = [await createUser(), await createUser()];
    await rec(u, "llm.requests", 2, "CHAT");
    await rec(u, "llm.tokens", 300, "CHAT");
    await rec(u, "llm.requests", 1, "ANALYSIS");
    await rec(u, "llm.tokens", 100, "ANALYSIS");
    await rec(u, "llm.tokens", 50, "MCQ", new Date(Date.now() - 10 * 86_400_000)); // inside 30 days, outside today
    await rec(u, "llm.tokens", 999, "CHAT", new Date(Date.now() - 40 * 86_400_000)); // outside 30 days
    await rec(other, "llm.tokens", 12345, "CHAT");
    const body = await (await client(t, u).get("/api/ai/usage")).json();
    expect(body).toMatchObject({ tokens: 400, requests: 3 }); // existing flat shape still works
    expect(body.daily).toMatchObject({ tokens: 400, requests: 3, tokenLimit: 1_000_000, requestLimit: 1000 });
    expect(new Date(body.daily.resetsAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.monthly).toMatchObject({ tokenLimit: 0, requestLimit: 0 });
    expect(body.monthly.tokens).toBeGreaterThanOrEqual(400);
    const by = Object.fromEntries(body.byTask.map((x: { task: string }) => [x.task, x]));
    expect(by.CHAT).toMatchObject({ requests: 2, tokens: 300 });
    expect(by.ANALYSIS).toMatchObject({ requests: 1, tokens: 100 });
    expect(by.MCQ).toMatchObject({ tokens: 50 });
    expect(JSON.stringify(body)).not.toContain("12345");
    expect(body.note).toMatch(/no cost estimate/);
    expect(JSON.stringify(body)).not.toMatch(/\$|cost":/);
    expect((await client(t).get("/api/ai/usage")).status).toBe(401);
  });

  it("the monthly window starts on the 1st (UTC) and resets on the next 1st", async () => {
    const u = await createUser();
    setClock(() => new Date("2026-03-15T10:00:00Z"));
    await rec(u, "llm.tokens", 70, "CHAT", new Date("2026-03-02T00:00:00Z"));
    await rec(u, "llm.tokens", 30, "CHAT", new Date("2026-02-28T23:59:00Z")); // previous month
    const m = (await (await client(t, u).get("/api/ai/usage")).json()).monthly;
    expect(m.tokens).toBe(70);
    expect(m.resetsAt).toBe("2026-04-01T00:00:00.000Z");
  });
});

describe("quota enforcement names the window", () => {
  it("monthly caps stop chat before any provider call; daily caps still apply", async () => {
    await withEnv({ AI_MONTHLY_REQUEST_LIMIT: "2" }, async () => {
      const u = await createUser();
      await setupAi(t, u, { embedding: false });
      await rec(u, "llm.requests", 2, "CHAT");
      const conv = (await (await client(t, u).post("/api/conversations", { mode: "GENERAL" })).json()).conversation.id;
      const res = await client(t, u).post(`/api/conversations/${conv}/messages`, { content: "hello" });
      expect(res.status).toBe(429);
      const err = (await res.json()).error;
      expect(err).toMatchObject({ code: "QUOTA_EXCEEDED", details: { window: "monthly" } });
      expect(err.details.resetsAt).toMatch(/^\d{4}-\d\d-01T00:00:00/);
      expect(t.rag.chatCalls).toHaveLength(0);
    });
    await withEnv({ AI_DAILY_TOKEN_LIMIT: "10" }, async () => {
      const u = await createUser();
      await setupAi(t, u, { embedding: false });
      await rec(u, "llm.tokens", 10, "CHAT");
      const conv = (await (await client(t, u).post("/api/conversations", { mode: "GENERAL" })).json()).conversation.id;
      const err = (await (await client(t, u).post(`/api/conversations/${conv}/messages`, { content: "hello" })).json()).error;
      expect(err.details.window).toBe("daily");
    });
  });

  it("generation and regeneration are blocked by the monthly cap too", async () => {
    await withEnv({ AI_MONTHLY_TOKEN_LIMIT: "5" }, async () => {
      const u = await createUser();
      await setupAi(t, u, { embedding: false });
      await rec(u, "llm.tokens", 5, "MCQ");
      const res = await client(t, u).post("/api/generation/mcq", { topic: "Cells", grounding: "GENERAL", count: 2 });
      expect(res.status).toBe(429);
      expect((await res.json()).error.details.window).toBe("monthly");
      expect(t.rag.generateCalls).toHaveLength(0);
    });
  });
});

describe("autoAiFeedback preference", () => {
  it("defaults to on, is read from /api/me and /api/profile, and can be switched off and on again", async () => {
    const u = await createUser();
    expect((await (await client(t, u).get("/api/me")).json()).preference.autoAiFeedback).toBe(true);
    expect((await (await client(t, u).get("/api/profile")).json()).preference.autoAiFeedback).toBe(true);
    const base = { theme: "DARK", locale: "bn", emailNotifications: false };
    expect((await client(t, u).patch("/api/preferences", { ...base, autoAiFeedback: false })).status).toBe(200);
    expect((await (await client(t, u).get("/api/profile")).json()).preference).toMatchObject({ theme: "DARK", locale: "bn", autoAiFeedback: false });
    // an older client that doesn't send the field leaves it unchanged
    expect((await client(t, u).patch("/api/preferences", base)).status).toBe(200);
    expect((await (await client(t, u).get("/api/profile")).json()).preference.autoAiFeedback).toBe(false);
    expect((await client(t, u).patch("/api/preferences", { ...base, autoAiFeedback: "yes" })).status).toBe(422);
    expect((await client(t, u).patch("/api/preferences", { ...base, autoAiFeedback: true })).status).toBe(200);
    expect((await (await client(t, u).get("/api/me")).json()).preference.autoAiFeedback).toBe(true);
  });
});
