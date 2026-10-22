import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { setClock } from "../../src/lib/clock.js";
import { cleanLabel, flushMetrics, hourStart, incr, purgeOldMetrics, recordBlock, recordProviderEvent, recordRequest, resetMetricsForTests, routeGroup } from "../../src/lib/metrics.js";
import { withEnv } from "../helpers/with-env.js";
import { client, makeApp, readSse, setupAi, type TestApp } from "../helpers/http.js";
import { createUser } from "../helpers/users.js";
import { form, textFile } from "../helpers/files.js";
import { ingestHandlers } from "../../src/modules/jobs/ingest.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import type { GenerateEvent } from "../../src/clients/rag-agent.js";

let t: TestApp;
const HOUR = new Date("2026-03-04T10:30:00Z");
beforeEach(async () => {
  t = makeApp();
  resetMetricsForTests();
  await db.metricBucket.deleteMany();
  setClock(null);
});

const admin = async () => {
  const u = await createUser();
  await db.user.update({ where: { id: u.id }, data: { role: "ADMIN" } });
  return u;
};
const metrics = async (hours = 24) => (await (await client(t, await admin()).get(`/api/admin/metrics?hours=${hours}`)).json()) as any;

describe("metrics collection", () => {
  it("keeps labels coarse and bounded", () => {
    expect(routeGroup("/api/questions/cmabc123/revisions")).toBe("questions");
    expect(routeGroup("/api/attempts/xyz/answers")).toBe("attempts");
    expect(routeGroup("/api/not-a-real-group/user-12345")).toBe("other");
    expect(routeGroup("/whatever")).toBe("other");
    expect(cleanLabel("a b;c'd\"e\n@x")).toBe("a_b_c_d_e__x");
    expect(cleanLabel("x".repeat(200))).toHaveLength(80);
    expect(hourStart(HOUR).toISOString()).toBe("2026-03-04T10:00:00.000Z");
  });

  it("aggregates in memory and flushes additively into hourly buckets", async () => {
    setClock(() => HOUR);
    for (let i = 0; i < 3; i++) recordRequest("/api/questions/abc", 200);
    recordRequest("/api/questions/abc", 404);
    recordRequest("/api/attempts/x/answers", 500);
    recordRequest("/api/health", 200); // health probes are not counted
    expect(await flushMetrics()).toBe(3);
    expect(await flushMetrics()).toBe(0); // nothing pending
    recordRequest("/api/questions/zzz", 200);
    await flushMetrics();
    const rows = await db.metricBucket.findMany({ where: { name: "api.request" }, orderBy: { label: "asc" } });
    expect(rows.map((r) => [r.label, r.count])).toEqual([["attempts|5xx", 1], ["questions|2xx", 4], ["questions|4xx", 1]]);
    expect(rows.every((r) => r.bucket.toISOString() === "2026-03-04T10:00:00.000Z")).toBe(true);
    // a later hour is a separate bucket
    setClock(() => new Date(HOUR.getTime() + 3_600_000));
    recordRequest("/api/questions/abc", 200);
    await flushMetrics();
    expect(await db.metricBucket.count({ where: { name: "api.request", label: "questions|2xx" } })).toBe(2);
  });

  it("records provider outcomes and blocks without ids or content", async () => {
    setClock(() => HOUR);
    recordProviderEvent("OPENAI", "chat", true);
    recordProviderEvent("OPENAI", "chat", false, "PROVIDER_RATE_LIMITED");
    recordProviderEvent("openai", "chat", false, "PROVIDER_RATE_LIMITED");
    recordBlock("rate_limit", "/api/groups/join");
    recordBlock("quota", "/api/generation/mcq");
    incr("custom.thing", "odd label; DROP TABLE");
    await flushMetrics();
    const labels = (await db.metricBucket.findMany()).map((r) => `${r.name}:${r.label}=${r.count}`).sort();
    expect(labels).toEqual(expect.arrayContaining(["provider.call:openai|chat|ok=1", "provider.call:openai|chat|error|PROVIDER_RATE_LIMITED=2", "block.rate_limit:groups=1", "block.quota:generation=1"]));
    expect(labels.join()).toContain("custom.thing:odd_label__DROP_TABLE=1"); // anything outside the safe alphabet is replaced
  });

  it("purges buckets older than the retention window", async () => {
    setClock(() => new Date("2026-03-30T00:00:00Z"));
    await db.metricBucket.createMany({ data: [{ bucket: new Date("2026-03-01T00:00:00Z"), name: "api.request", label: "me|2xx", count: 5 }, { bucket: new Date("2026-03-29T23:00:00Z"), name: "api.request", label: "me|2xx", count: 7 }] });
    expect(await purgeOldMetrics(14)).toBe(1);
    expect((await db.metricBucket.findMany()).map((b) => b.count)).toEqual([7]);
  });
});

describe("what the API actually records", () => {
  it("counts requests by status class and route group, and the admin series is zero-filled", async () => {
    const u = await createUser();
    const c = client(t, u);
    await c.get("/api/me");
    await c.get("/api/me");
    await client(t).get("/api/me"); // 401 -> 4xx
    await client(t).get("/api/health"); // not counted
    const m = await metrics(3);
    expect(m.api).toHaveLength(3);
    expect(m.api.at(-1)).toMatchObject({ "2xx": expect.any(Number), "4xx": expect.any(Number), "5xx": 0 });
    const me = m.apiByGroup.find((g: { group: string }) => g.group === "me");
    expect(me["2xx"]).toBeGreaterThanOrEqual(2);
    expect(me["4xx"]).toBeGreaterThanOrEqual(1);
    expect(m.apiByGroup.find((g: { group: string }) => g.group === "health")).toBeUndefined();
    expect(m.totals.requests).toBeGreaterThanOrEqual(3);
    expect((await client(t, await admin()).get("/api/admin/metrics?hours=169")).status).toBe(422);
  });

  it("counts rate-limit and quota blocks", async () => {
    const u = await createUser();
    await withEnv({ INVITE_ATTEMPTS_PER_HOUR_USER: "1" }, async () => {
      const c = client(t, u);
      await c.get("/api/groups/join-preview?code=nope");
      expect((await c.get("/api/groups/join-preview?code=nope")).status).toBe(429);
    });
    await withEnv({ AI_DAILY_REQUEST_LIMIT: "1" }, async () => {
      await setupAi(t, u);
      await db.usageRecord.create({ data: { userId: u.id, category: "llm.requests", quantity: 5n } });
      expect((await client(t, u).post("/api/generation/mcq", { topic: "x", grounding: "GENERAL", count: 1 })).status).toBe(429);
    });
    const m = await metrics(2);
    expect(m.blocks.rateLimit).toEqual(expect.arrayContaining([expect.objectContaining({ group: "groups" })]));
    expect(m.blocks.quota).toEqual(expect.arrayContaining([expect.objectContaining({ group: "generation" })]));
  });

  it("records AI-service outcomes for chat and generation (success and failure) as provider events", async () => {
    const u = await createUser();
    await setupAi(t, u);
    // generation: success then rate-limited
    await readSse(await client(t, u).post("/api/generation/mcq", { topic: "Cells", grounding: "GENERAL", count: 1 }));
    t.rag.generateScript = async function* (): AsyncGenerator<GenerateEvent> {
      yield { event: "error", data: { code: "PROVIDER_RATE_LIMITED", message: "slow down", retryable: true } };
    };
    await readSse(await client(t, u).post("/api/generation/mcq", { topic: "Cells", grounding: "GENERAL", count: 1 }));
    // chat: success then failure
    const conv = (await (await client(t, u).post("/api/conversations", { mode: "GENERAL" })).json()).conversation.id as string;
    await readSse(await client(t, u).post(`/api/conversations/${conv}/messages`, { content: "hello" }));
    t.rag.chatScript = async function* () {
      yield { event: "error", data: { code: "PROVIDER_AUTH_INVALID", message: "bad key", retryable: false } };
    };
    await readSse(await client(t, u).post(`/api/conversations/${conv}/messages`, { content: "again" }));

    const m = await metrics(2);
    const find = (task: string) => m.providers.find((p: { provider: string; task: string }) => p.provider === "mock" && p.task === task);
    expect(find("mcq")).toMatchObject({ ok: 1, error: 1, errorRate: 0.5, byCode: [{ code: "PROVIDER_RATE_LIMITED", count: 1 }] });
    expect(find("chat")).toMatchObject({ ok: 1, error: 1, byCode: [{ code: "PROVIDER_AUTH_INVALID", count: 1 }] });
    expect(JSON.stringify(m)).not.toMatch(/hello|again|Cells|slow down/);
  });

  it("records embedding outcomes of document processing", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const up = (name: string) => client(t, u).raw("POST", "/api/documents", form([{ name, type: "text/plain", data: textFile(`Some notes ${name}`) }]));
    await up("one.txt");
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    await up("two.txt");
    t.rag.ingestScript = async () => {
      throw new RagAgentError("PROVIDER_RATE_LIMITED", "slow down", false, null, 429);
    };
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    const m = await metrics(2);
    expect(m.providers.find((p: { task: string }) => p.task === "embedding")).toMatchObject({ provider: "mock", ok: 1, error: 1, byCode: [{ code: "PROVIDER_RATE_LIMITED", count: 1 }] });
  });
});
