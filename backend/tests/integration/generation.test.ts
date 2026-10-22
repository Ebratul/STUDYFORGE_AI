import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagAgentError, type GenerateEvent, type GenerateKind, type GenerateRequest, type RagQuestion } from "../../src/clients/rag-agent.js";
import { resetEnvCache } from "../../src/config/env.js";
import { db } from "../../src/lib/db.js";
import { fakeQuestions } from "../helpers/fake-generation.js";
import { client, makeApp, readSse, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => {
  for (const k of ["AI_DAILY_REQUEST_LIMIT", "GEN_RATE_PER_MINUTE", "GEN_TIMEOUT_MS"]) delete process.env[k];
  process.env.AI_DAILY_REQUEST_LIMIT = "1000";
  resetEnvCache();
});

const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>) => {
  Object.assign(process.env, vars);
  resetEnvCache();
  try {
    await fn();
  } finally {
    for (const k of Object.keys(vars)) delete process.env[k];
    process.env.AI_DAILY_REQUEST_LIMIT = "1000";
    resetEnvCache();
  }
};

async function ready(embedding = true): Promise<TestUser> {
  const u = await createUser();
  await setupAi(t, u, { embedding });
  return u;
}
async function readyDoc(u: TestUser, name = "notes.txt", over: Record<string, unknown> = {}) {
  return db.document.create({
    data: { ownerId: u.id, name, extension: "txt", mimeType: "text/plain", sizeBytes: 100, sha256: randomUUID(), storageKey: `u/${u.id}/${randomUUID().replaceAll("-", "")}`, status: "READY", embeddingModel: "mock-embed", embeddingProvider: "MOCK", processingVersion: 1, ...over },
  });
}
const gen = (u: TestUser, kind: "mcq" | "cq", body: Record<string, unknown>) => client(t, u).post(`/api/generation/${kind}`, body);
const mcqBody = (over: Record<string, unknown> = {}) => ({ topic: "Cells", grounding: "GENERAL", count: 3, ...over });
const cqBody = (over: Record<string, unknown> = {}) => ({ topic: "Rivers", grounding: "GENERAL", mode: "WITH_ANSWERS", structure: "stimulus_4part", count: 2, ...over });
async function run(u: TestUser, kind: "mcq" | "cq", body: Record<string, unknown>) {
  const res = await gen(u, kind, body);
  expect(res.status).toBe(200);
  const events = await readSse(res);
  const result = events.find((e) => e.event === "result");
  expect(result, JSON.stringify(events)).toBeTruthy();
  return { events, run: result!.data.run as any };
}
const lastCall = () => t.rag.generateCalls.at(-1)!;
/** Makes the fake provider return exactly these questions (as rag_agent would). */
const returns = (build: (req: GenerateRequest) => RagQuestion[], extra: { rejected?: number; warnings?: { code: string; message: string }[]; llm_calls?: number } = {}) => {
  t.rag.generateScript = async function* (kind: GenerateKind, req: GenerateRequest): AsyncGenerator<GenerateEvent> {
    yield { event: "result", data: { questions: build(req), rejected: extra.rejected ?? 0, warnings: extra.warnings ?? [], usage: { prompt_tokens: 10, completion_tokens: 20, llm_calls: extra.llm_calls ?? 1 } } };
    void kind;
  };
};
const fails = (code: string, extra: Record<string, unknown> = {}) => {
  t.rag.generateScript = async function* (): AsyncGenerator<GenerateEvent> {
    yield { event: "error", data: { code, message: `safe message for ${code}`, retryable: code === "PROVIDER_RATE_LIMITED", ...extra } };
  };
};
const usage = async (u: TestUser, category: string) => Number((await db.usageRecord.aggregate({ where: { userId: u.id, category }, _sum: { quantity: true } }))._sum.quantity ?? 0);

describe("starting a run: validation, configuration and quotas happen before streaming", () => {
  it("needs a configured model and key (task preference, falling back to the default)", async () => {
    const u = await createUser();
    const res = await gen(u, "mcq", mcqBody());
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("NOT_CONFIGURED");
    expect(t.rag.generateCalls).toHaveLength(0);
    // a per-run model override for a provider with no saved key is refused, never silently switched
    const v = await ready();
    const o = await gen(v, "mcq", mcqBody({ model: { provider: "openai", modelId: "gpt-x" } }));
    expect((await o.json()).error.code).toBe("NOT_CONFIGURED");
    expect(t.rag.generateCalls).toHaveLength(0);
  });

  it("validates every setting on the server and names the field", async () => {
    const u = await ready();
    const bad = async (body: Record<string, unknown>, kind: "mcq" | "cq" = "mcq") => {
      const res = await gen(u, kind, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      return (await res.json()).error.details.fields as Record<string, string>;
    };
    expect(await bad(mcqBody({ count: 51 }))).toHaveProperty("count");
    expect(await bad(mcqBody({ count: 0 }))).toHaveProperty("count");
    expect(await bad(mcqBody({ optionCount: 9 }))).toHaveProperty("optionCount");
    expect(await bad(mcqBody({ difficulty: "IMPOSSIBLE" }))).toHaveProperty("difficulty");
    expect(await bad(mcqBody({ language: "fr" }))).toHaveProperty("language");
    expect(await bad(mcqBody({ marks: 1, negativeMarks: 2 }))).toHaveProperty("negativeMarks");
    expect(await bad(mcqBody({ topic: "x".repeat(301) }))).toHaveProperty("topic");
    expect(await bad(mcqBody({ grounding: "SOURCE_ONLY", pastedText: undefined }))).toHaveProperty("grounding"); // a topic alone isn't a source
    expect(await bad(mcqBody({ grounding: "GENERAL", pastedText: "some text" }))).toHaveProperty("grounding");
    expect(await bad(mcqBody({ grounding: undefined }))).toHaveProperty("grounding");
    expect(await bad(mcqBody({ apiKey: "sk-evil" }))).toBeTruthy(); // unknown keys are rejected
    expect(await bad(cqBody({ count: 21 }), "cq")).toHaveProperty("count");
    expect(await bad(cqBody({ structure: "multipart" }), "cq")).toHaveProperty("partCount");
    expect(await bad(cqBody({ structure: "stimulus_4part", stimulus: "none" }), "cq")).toHaveProperty("stimulus");
    expect(t.rag.generateCalls).toHaveLength(0);
    expect(await db.generationRun.count({ where: { userId: u.id } })).toBe(0);
  });

  it("requires authentication", async () => {
    expect((await client(t).post("/api/generation/mcq", mcqBody())).status).toBe(401);
    expect((await client(t).get("/api/generation/runs")).status).toBe(401);
  });

  it("enforces the daily AI request quota and the per-minute generation rate limit", async () => {
    const u = await ready();
    await withEnv({ AI_DAILY_REQUEST_LIMIT: "3" }, async () => {
      await db.usageRecord.create({ data: { userId: u.id, category: "llm.requests", quantity: 3n } });
      const res = await gen(u, "mcq", mcqBody());
      expect(res.status).toBe(429);
      expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED");
    });
    expect(t.rag.generateCalls).toHaveLength(0);
    await withEnv({ GEN_RATE_PER_MINUTE: "2" }, async () => {
      const v = await ready();
      for (let i = 0; i < 2; i++) await readSse(await gen(v, "mcq", mcqBody()));
      const res = await gen(v, "mcq", mcqBody());
      expect(res.status).toBe(429);
      expect((await res.json()).error.code).toBe("RATE_LIMITED");
    });
  });

  it("allows one running generation per user and recovers from a stale one", async () => {
    const u = await ready();
    const mk = (ageMs: number) => db.generationRun.create({ data: { userId: u.id, kind: "MCQ", status: "RUNNING", settings: {}, provider: "MOCK", model: "mock-chat", createdAt: new Date(Date.now() - ageMs), expiresAt: new Date(Date.now() + 1e9) } });
    const fresh = await mk(1000);
    const res = await gen(u, "mcq", mcqBody());
    expect(res.status).toBe(409);
    await db.generationRun.delete({ where: { id: fresh.id } });
    const stale = await mk(11 * 60 * 1000);
    await run(u, "mcq", mcqBody());
    expect((await db.generationRun.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("INTERRUPTED");
  });
});

describe("MCQ generation", () => {
  it("streams run → status → result, persists the run, records usage, and never exposes the API key", async () => {
    const u = await ready();
    const res = await gen(u, "mcq", mcqBody({ count: 4, difficulty: "MIXED" }));
    const raw = await res.clone().text();
    expect(raw).not.toContain("mock-valid-key");
    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["run", "status", "result"]);
    const view = events[2]!.data.run;
    expect(view).toMatchObject({ kind: "MCQ", status: "SUCCEEDED", provider: "mock", model: "mock-chat", rejectedCount: 0 });
    expect(events[0]!.data.runId).toBe(view.id);
    expect(view.questions).toHaveLength(4);
    expect(view.questions.map((q: { difficulty: string }) => q.difficulty)).toEqual(["EASY", "MEDIUM", "HARD", "EASY"]);
    expect(view.questions[0]).toMatchObject({ kind: "MCQ", sourceSupport: "MODEL_ONLY", reviewReasons: [] });
    expect(view.questions[0].options).toHaveLength(4);
    expect(view.settings).not.toHaveProperty("pastedText");

    // what the backend sent to rag_agent: the key only server-to-server, settings validated and echoed, limits applied
    const { kind, body } = lastCall();
    expect(kind).toBe("mcq");
    expect(body.chat).toMatchObject({ provider: "mock", api_key: "mock-valid-key", model: "mock-chat" });
    expect(body.embedding).toBeNull();
    expect(body.grounding).toBe("GENERAL");
    expect(body.sources).toEqual({ topic: "Cells", pasted_text: null, document_ids: [] });
    expect(body.spec).toMatchObject({ count: 4, difficulty: "MIXED", language: "en", option_count: 4, include_explanations: true, include_short_notes: true, marks: 1, negative_marks: 0 });
    expect(body.limits).toMatchObject({ batch_size: 10, max_llm_calls: 16, max_context_chars: 14000, max_regen_per_batch: 2 });
    expect(body.cross_check).toBe(true);
    expect(body.chat.params.max_output_tokens).toBeLessThanOrEqual(8000);

    expect(await usage(u, "llm.requests")).toBe(1);
    expect(await usage(u, "llm.tokens")).toBe(100 + 50 * 4);
    const row = await db.generationRun.findUniqueOrThrow({ where: { id: view.id } });
    expect(row).toMatchObject({ status: "SUCCEEDED", llmCalls: 1, promptTokens: 100 });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
  });

  it.each([
    [{ language: "bn", difficulty: "HARD", optionCount: 5, marks: 2, negativeMarks: 0.5, includeExplanations: false, includeShortNotes: false, crossCheck: false, subject: "Biology" }],
    [{ language: "en", difficulty: "EASY", optionCount: 3 }],
  ] as Record<string, unknown>[][])("passes difficulty, language, option count, marks and flags through (%j)", async (settings: Record<string, unknown>) => {
    const u = await ready();
    const { run: view } = await run(u, "mcq", mcqBody({ count: 2, ...settings }));
    const spec = lastCall().body.spec as Record<string, unknown>;
    expect(spec.language).toBe(settings.language);
    expect(spec.difficulty).toBe(settings.difficulty);
    expect(spec.option_count).toBe(settings.optionCount);
    for (const q of view.questions) {
      expect(q.language).toBe(settings.language);
      expect(q.difficulty).toBe(settings.difficulty);
      expect(q.options).toHaveLength(settings.optionCount as number);
      expect(q.marks).toBe(settings.marks ?? 1);
      if (settings.includeExplanations === false) expect(q.explanation).toBeNull();
    }
    if (settings.crossCheck === false) expect(lastCall().body.cross_check).toBe(false);
  });

  it("uses the MCQ task preference, then the default, and can be overridden per run for a provider the user has a key for", async () => {
    const u = await ready();
    await client(t, u).put("/api/ai/preferences", { tasks: { MCQ: { provider: "mock", modelId: "mock-chat-plain", temperature: 0.2, maxTokens: 500 } } });
    await run(u, "mcq", mcqBody());
    expect(lastCall().body.chat).toMatchObject({ model: "mock-chat-plain", params: { temperature: 0.2, max_output_tokens: 500 } });
    await run(u, "mcq", mcqBody({ model: { provider: "mock", modelId: "mock-chat" } }));
    expect(lastCall().body.chat.model).toBe("mock-chat");
    const limits = await (await client(t, u).get("/api/questions/limits")).json();
    expect(limits.models.MCQ).toEqual({ provider: "mock", modelId: "mock-chat-plain" });
  });

  it("reports the model's context window when the provider listed it", async () => {
    const u = await ready();
    t.rag.listModels = async (provider) => ({ provider, fetched_at: new Date().toISOString(), models: [{ id: "mock-chat", context_length: 32768, capabilities: { chat: true, embeddings: false, streaming: true, structured_output: "yes", tools: "no" }, capability_source: "catalogue" }] });
    await run(u, "mcq", mcqBody());
    expect(lastCall().body.context_tokens).toBe(32768);
  });

  it("caps max output tokens at the platform limit even if the user's preference is higher", async () => {
    const u = await ready();
    await client(t, u).put("/api/ai/preferences", { default: { provider: "mock", modelId: "mock-chat", maxTokens: 30000 } });
    await run(u, "mcq", mcqBody());
    expect(lastCall().body.chat.params.max_output_tokens).toBe(8000);
  });
});

describe("sources and document authorization", () => {
  it("only uses the caller's own READY documents", async () => {
    const [u, other] = [await ready(), await ready()];
    const mine = await readyDoc(u);
    const theirs = await readyDoc(other, "secret.txt");
    const processing = await readyDoc(u, "slow.txt", { status: "PROCESSING" });
    const failed = await readyDoc(u, "bad.pdf", { status: "NEEDS_OCR" });

    const res = await gen(u, "mcq", { documentIds: [theirs.id], grounding: "SOURCE_ONLY", count: 1 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain("secret.txt"); // a foreign document is indistinguishable from a missing one
    expect(((await (await gen(u, "mcq", { documentIds: [processing.id], grounding: "SOURCE_ONLY" })).json()).error.details.fields.documentIds)).toMatch(/slow\.txt.*isn't ready/);
    expect(((await (await gen(u, "mcq", { documentIds: [failed.id], grounding: "SOURCE_ONLY" })).json()).error.details.fields.documentIds)).toMatch(/bad\.pdf/);
    expect(((await (await gen(u, "mcq", { documentIds: ["does-not-exist"], grounding: "SOURCE_ONLY" })).json()).error.details.fields.documentIds)).toBeTruthy();
    expect(t.rag.generateCalls).toHaveLength(0);

    const ok = await run(u, "mcq", { documentIds: [mine.id], grounding: "SOURCE_ONLY", count: 2 });
    expect(lastCall().body.sources.document_ids).toEqual([mine.id]);
    expect(ok.run.sources.documents).toEqual([{ id: mine.id, name: "notes.txt" }]);
  });

  it("documents without a topic are covered without embeddings; a topic needs the matching embedding model", async () => {
    const u = await ready(false); // no embedding preference
    const d = await readyDoc(u);
    await run(u, "mcq", { documentIds: [d.id], grounding: "SOURCE_ONLY", count: 1 });
    expect(lastCall().body.embedding).toBeNull();
    expect(lastCall().body.sources.topic).toBeNull();

    const res = await gen(u, "mcq", { documentIds: [d.id], topic: "Cells", grounding: "SOURCE_ONLY" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("NOT_CONFIGURED");

    const v = await ready();
    const mismatch = await readyDoc(v, "old.txt", { embeddingModel: "some-other-model" });
    const r2 = await gen(v, "mcq", { documentIds: [mismatch.id], topic: "Cells", grounding: "SOURCE_ONLY" });
    expect(r2.status).toBe(422);
    expect((await r2.json()).error.details.fields.documentIds).toMatch(/different embedding model/);

    const good = await readyDoc(v);
    await run(v, "mcq", { documentIds: [good.id], topic: "Cells", grounding: "SOURCE_PREFERRED", count: 1 });
    expect(lastCall().body.embedding).toMatchObject({ provider: "mock", model: "mock-embed", api_key: "mock-valid-key" });
  });

  it("combines pasted text, topic and documents; pasted evidence has no document id", async () => {
    const u = await ready();
    const d = await readyDoc(u);
    const { run: view } = await run(u, "mcq", { topic: "Cells", pastedText: "Cells are the basic unit of life.", documentIds: [d.id], grounding: "SOURCE_ONLY", count: 1 });
    expect(lastCall().body.sources).toMatchObject({ topic: "Cells", pasted_text: "Cells are the basic unit of life.", document_ids: [d.id] });
    expect(view.sources).toMatchObject({ topic: "Cells", pastedTextChars: 33 });
    expect(view.questions[0]).toMatchObject({ sourceSupport: "SOURCE_QUOTED" });
    expect(view.questions[0].sources[0]).toMatchObject({ documentId: d.id, quoteVerified: true });
    const pasteOnly = await run(u, "mcq", { pastedText: "Only pasted.", grounding: "SOURCE_ONLY", count: 1 });
    expect(pasteOnly.run.questions[0].sources[0]).toMatchObject({ documentId: null, documentName: "Pasted text" });
  });
});

describe("rag_agent output is validated again by the backend", () => {
  const base = (over: Partial<RagQuestion> = {}) => ({ ...fakeQuestions("mcq", { spec: { count: 1, option_count: 4, language: "en", difficulty: "EASY" }, sources: { topic: "T", pasted_text: null, document_ids: [] }, grounding: "GENERAL" } as unknown as GenerateRequest)[0]!, ...over });

  it("rejects malformed questions, invalid answer keys and duplicates, and reports it", async () => {
    const u = await ready();
    const good = base();
    returns(() => [
      good,
      base({ id: "g_badkey0001", correct_option_id: "no-such-option" }),
      base({ id: "g_nooptions01", options: [{ id: "x1", text: "only" }], correct_option_id: "x1" }),
      base({ id: "g_dupoptions1", options: [{ id: "x1", text: "same" }, { id: "x2", text: "Same." }], correct_option_id: "x1" }),
      base({ id: "g_dupe000001", stem: good.stem }), // exact duplicate of the first
      base({ id: "g_emptystem1", stem: "   " }),
    ]);
    const { run: view } = await run(u, "mcq", mcqBody({ count: 5 }));
    expect(view.questions).toHaveLength(1);
    expect(view.rejectedCount).toBe(5);
    expect(view.warnings.map((w: { code: string }) => w.code)).toEqual(expect.arrayContaining(["SOME_REJECTED", "FEWER_THAN_REQUESTED"]));
  });

  it("fails with a useful error (and keeps nothing) when nothing valid comes back", async () => {
    const u = await ready();
    returns(() => [base({ correct_option_id: "zzz" })]);
    const events = await readSse(await gen(u, "mcq", mcqBody()));
    const err = events.find((e) => e.event === "error")!;
    expect(err.data).toMatchObject({ code: "GENERATION_FAILED", details: { reason: "NO_VALID_QUESTIONS" } });
    expect(err.data.message).toMatch(/didn't pass validation/);
    expect(events.some((e) => e.event === "result")).toBe(false);
    const row = await db.generationRun.findFirstOrThrow({ where: { userId: u.id } });
    expect(row).toMatchObject({ status: "FAILED", errorCode: "NO_VALID_QUESTIONS", result: null });
    expect(await db.question.count({ where: { ownerId: u.id } })).toBe(0);
  });

  it("trims to the requested count", async () => {
    const u = await ready();
    returns((req) => fakeQuestions("mcq", { ...req, spec: { ...req.spec, count: 9 } }));
    const { run: view } = await run(u, "mcq", mcqBody({ count: 3 }));
    expect(view.questions).toHaveLength(3);
  });

  it("drops evidence that points at documents the request wasn't allowed to use, and enforces SOURCE_ONLY itself", async () => {
    const u = await ready();
    const mine = await readyDoc(u);
    const foreignSource = { document_id: "someone-elses-doc", document_name: "x.pdf", chunk_id: "c", page: 1, section: null, quote: "q", quote_verified: true };
    returns((req) => [base({ sources: [foreignSource], source_support: "SOURCE_QUOTED" }), ...fakeQuestions("mcq", { ...req, spec: { ...req.spec, count: 1 } })].map((q, i) => ({ ...q, id: `g_foreign000${i}` })));
    const { run: view } = await run(u, "mcq", { documentIds: [mine.id], grounding: "SOURCE_ONLY", count: 2 });
    expect(view.questions).toHaveLength(1); // the question citing a foreign document had no valid evidence left → rejected under SOURCE_ONLY
    expect(view.questions[0].sources.every((s: { documentId: string | null }) => s.documentId === mine.id)).toBe(true);
    expect(view.rejectedCount).toBe(1);
  });

  it("recomputes source support instead of trusting rag_agent, and keeps unverified questions as MODEL_ONLY under SOURCE_PREFERRED", async () => {
    const u = await ready();
    returns(() => [base({ source_support: "SOURCE_QUOTED", sources: [{ document_id: null, document_name: "Pasted text", page: null, section: null, quote: "claimed", quote_verified: false }] })]);
    const { run: view } = await run(u, "mcq", { pastedText: "text", grounding: "SOURCE_PREFERRED", count: 1 });
    expect(view.questions[0].sourceSupport).toBe("MODEL_ONLY");
  });

  it("surfaces warnings and review flags from rag_agent without altering them", async () => {
    const u = await ready();
    returns(() => [base({ review_reasons: ["SOLVER_DISAGREES", "not a valid code!"] })], { warnings: [{ code: "CROSS_CHECK_SKIPPED", message: "skipped" }, { code: "NO_STRUCTURED_OUTPUT_NATIVE", message: "prompt JSON used" }], llm_calls: 3 });
    const { run: view } = await run(u, "mcq", mcqBody({ count: 1 }));
    expect(view.questions[0].reviewReasons).toEqual(["SOLVER_DISAGREES"]);
    expect(view.warnings.map((w: { code: string }) => w.code)).toEqual(["CROSS_CHECK_SKIPPED", "NO_STRUCTURED_OUTPUT_NATIVE"]);
    expect(view.usage.llmCalls).toBe(3);
    expect(await usage(u, "llm.requests")).toBe(3);
  });
});

describe("failures", () => {
  it.each([
    ["PROVIDER_RATE_LIMITED", { retry_after_seconds: 7 }],
    ["PROVIDER_AUTH_INVALID", {}],
    ["PROVIDER_TIMEOUT", {}],
    ["MODEL_NOT_FOUND", {}],
    ["GENERATION_FAILED", { reason: "INSUFFICIENT_SOURCES" }],
    ["GENERATION_FAILED", { reason: "INVALID_OUTPUT" }],
  ] as [string, Record<string, unknown>][])("maps %s to a safe error event and marks the run failed", async (code, extra) => {
    const u = await ready();
    fails(code, extra);
    const events = await readSse(await gen(u, "mcq", mcqBody()));
    const err = events.find((e) => e.event === "error")!;
    expect(err.data.code).toBe(code);
    expect(err.data.message).toBe(`safe message for ${code}`);
    if (code === "GENERATION_FAILED") expect(err.data.details.reason).toBe(extra.reason);
    const row = await db.generationRun.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe(code === "GENERATION_FAILED" ? (extra.reason as string) : code);
    if (code === "PROVIDER_AUTH_INVALID") expect((await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("INVALID");
  });

  it("handles the AI service being unreachable", async () => {
    const u = await ready();
    t.rag.generateScript = async function* () {
      throw new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service is unavailable right now.", true, null, 503);
      yield undefined as never;
    };
    const err = (await readSse(await gen(u, "mcq", mcqBody()))).find((e) => e.event === "error")!;
    expect(err.data).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
    expect((await db.generationRun.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("FAILED");
  });

  it("a user can stop a run: the provider call is aborted and the run is marked interrupted", async () => {
    const u = await ready();
    let sawAbort: Promise<void> = Promise.resolve();
    t.rag.generateScript = async function* (_k, _r, signal) {
      yield { event: "status", data: { stage: "generating" } };
      sawAbort = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      await sawAbort;
      throw new Error("aborted");
    };
    const res = await gen(u, "mcq", mcqBody());
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("status")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    await sawAbort;
    await new Promise((r) => setTimeout(r, 200));
    expect((await db.generationRun.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("INTERRUPTED");
    expect(await usage(u, "llm.requests")).toBe(0);
  });

  it("enforces the whole-run timeout", async () => {
    const u = await ready();
    await withEnv({ GEN_TIMEOUT_MS: "5000" }, async () => {
      t.rag.generateScript = async function* (_k, _r, signal) {
        yield { event: "status", data: { stage: "generating" } };
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      };
      const events = await readSse(await gen(u, "mcq", mcqBody()));
      expect(events.find((e) => e.event === "error")!.data).toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
    });
  }, 15_000);
});

describe("CQ generation", () => {
  it("builds the stimulus-based 4-part request with Bangla levels' marks and no time limit anywhere", async () => {
    const u = await ready();
    const { run: view } = await run(u, "cq", cqBody({ language: "bn", count: 2 }));
    expect(lastCall().kind).toBe("cq");
    expect(lastCall().body.spec).toEqual({ count: 2, mode: "WITH_ANSWERS", structure: "stimulus_4part", part_marks: [1, 2, 3, 4], total_marks: 10, stimulus: "required", difficulty: "MEDIUM", language: "bn", subject: null });
    expect(lastCall().body.cross_check).toBe(false);
    const q = view.questions[0];
    expect(q).toMatchObject({ kind: "CQ", language: "bn", marks: 10, options: [], correctOptionId: null });
    expect(q.stimulus).toBeTruthy();
    expect(q.parts.map((p: { label: string }) => p.label)).toEqual(["ক", "খ", "গ", "ঘ"]);
    expect(q.parts.map((p: { level: string }) => p.level)).toEqual(["KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER"]);
    expect(q.parts.map((p: { marks: number }) => p.marks)).toEqual([1, 2, 3, 4]);
    // CQ is study content: nothing about timers, durations or deadlines in the request, the run or the questions
    const timeKey = /timer|duration|time_?limit|minutes|countdown|deadline/i;
    const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    expect(keys(view).filter((k) => timeKey.test(k))).toEqual([]);
    expect(keys(lastCall().body.spec).filter((k) => timeKey.test(k))).toEqual([]);
  });

  it("questions-only mode asks for no answers and strips any that come back; with-answers keeps them with their basis", async () => {
    const u = await ready();
    const only = await run(u, "cq", cqBody({ mode: "QUESTIONS_ONLY", structure: "multipart", partCount: 3, totalMarks: 12 }));
    expect(lastCall().body.spec).toMatchObject({ mode: "QUESTIONS_ONLY", structure: "multipart", part_marks: [4, 4, 4], total_marks: 12 });
    expect(only.run.questions[0].parts.every((p: { answer: unknown }) => p.answer === null)).toBe(true);

    // rag_agent returning answers despite QUESTIONS_ONLY must not leak them through
    returns((req) => fakeQuestions("cq", { ...req, spec: { ...req.spec, mode: "WITH_ANSWERS" } }));
    const stripped = await run(u, "cq", cqBody({ mode: "QUESTIONS_ONLY" }));
    expect(stripped.run.questions[0].parts.every((p: { answer: unknown }) => p.answer === null)).toBe(true);

    t.rag.generateScript = (await import("../helpers/fake-generation.js")).defaultGenerateScript;
    const withAns = await run(u, "cq", cqBody({ mode: "WITH_ANSWERS" }));
    expect(withAns.run.questions[0].parts[0].answer).toMatchObject({ text: "Answer 1", basis: "GENERAL_REASONING", sources: [] });
  });

  it("descriptive CQs have no parts and a single model answer", async () => {
    const u = await ready();
    const { run: view } = await run(u, "cq", cqBody({ structure: "descriptive", totalMarks: 8, count: 1 }));
    expect(lastCall().body.spec).toMatchObject({ structure: "descriptive", part_marks: null, total_marks: 8, stimulus: "none" });
    expect(view.questions[0]).toMatchObject({ parts: [], marks: 8 });
    expect(view.questions[0].answer).toMatchObject({ text: "Model answer 1" });
  });

  it("distinguishes insufficient evidence from general reasoning and never invents text for unsupported answers", async () => {
    const u = await ready();
    returns((req) => {
      const q = fakeQuestions("cq", { ...req, spec: { ...req.spec, count: 1 } })[0]!;
      q.parts[0]!.answer = { text: "supported", basis: "SOURCE_SUPPORTED", sources: [{ document_id: null, document_name: "Pasted text", page: null, section: null, quote: "verbatim", quote_verified: true }] };
      q.parts[1]!.answer = { text: "I made this up", basis: "INSUFFICIENT_EVIDENCE", sources: [] };
      q.parts[2]!.answer = { text: "general knowledge", basis: "GENERAL_REASONING", sources: [] };
      q.parts[3]!.answer = { text: "claims support", basis: "SOURCE_SUPPORTED", sources: [] }; // no evidence → must not stay "supported"
      q.review_reasons = ["PART_INSUFFICIENT_EVIDENCE"];
      return [q];
    });
    const { run: view } = await run(u, "cq", cqBody({ pastedText: "Some pasted source text", grounding: "SOURCE_ONLY", count: 1 }));
    const a = view.questions[0].parts.map((p: { answer: { text: string; basis: string } }) => p.answer);
    expect(a[0]).toMatchObject({ text: "supported", basis: "SOURCE_SUPPORTED" });
    expect(a[1]).toEqual({ text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] });
    expect(a[2]).toEqual({ text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] }); // general reasoning is not permitted under SOURCE_ONLY
    expect(a[3]).toEqual({ text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] });
    expect(view.questions[0].reviewReasons).toEqual(["PART_INSUFFICIENT_EVIDENCE"]);
  });

  it("permits labelled general reasoning under SOURCE_PREFERRED", async () => {
    const u = await ready();
    returns((req) => {
      const q = fakeQuestions("cq", { ...req, spec: { ...req.spec, count: 1 } })[0]!;
      q.parts.forEach((p) => (p.answer = { text: "general knowledge", basis: "GENERAL_REASONING", sources: [] }));
      q.sources = [];
      return [q];
    });
    const { run: view } = await run(u, "cq", cqBody({ pastedText: "text", grounding: "SOURCE_PREFERRED", count: 1 }));
    expect(view.questions[0].parts[0].answer).toMatchObject({ text: "general knowledge", basis: "GENERAL_REASONING" });
    expect(view.questions[0].sourceSupport).toBe("MODEL_ONLY");
  });
});

describe("runs", () => {
  it("lists, reopens and deletes runs; other users can't see them; expired runs are purged", async () => {
    const [u, other] = [await ready(), await ready()];
    const a = await run(u, "mcq", mcqBody({ count: 2 }));
    await run(u, "cq", cqBody({ count: 1 }));
    const c = client(t, u);
    const all = (await (await c.get("/api/generation/runs")).json()).items;
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ kind: "CQ", questionCount: 1, topic: "Rivers" });
    expect((await (await c.get("/api/generation/runs?kind=MCQ")).json()).items).toHaveLength(1);
    expect((await (await c.get(`/api/generation/runs/${a.run.id}`)).json()).run.questions).toHaveLength(2);

    const co = client(t, other);
    expect((await co.get(`/api/generation/runs/${a.run.id}`)).status).toBe(404);
    expect((await co.delete(`/api/generation/runs/${a.run.id}`)).status).toBe(404);
    expect((await co.post(`/api/generation/runs/${a.run.id}/regenerate`, { questionId: a.run.questions[0].id })).status).toBe(404);
    expect((await (await co.get("/api/generation/runs")).json()).items).toEqual([]);

    await db.generationRun.update({ where: { id: a.run.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await c.get(`/api/generation/runs/${a.run.id}`)).status).toBe(404);
    expect((await (await c.get("/api/generation/runs")).json()).items).toHaveLength(1);
    expect(await db.generationRun.count({ where: { id: a.run.id } })).toBe(0);

    expect((await c.delete(`/api/generation/runs/${all[0].id}`)).status).toBe(200);
  });
});

describe("regenerating one question", () => {
  it("replaces it in place, keeps its id and difficulty, avoids the other stems and uses the run's own model", async () => {
    const u = await ready();
    const { run: view } = await run(u, "mcq", mcqBody({ count: 3 }));
    // the user later changes their default model; regeneration must still use the run's provider/model
    await client(t, u).put("/api/ai/preferences", { default: { provider: "mock", modelId: "mock-chat-plain" } });
    returns((req) => fakeQuestions("mcq", { ...req, spec: { ...req.spec, count: 1 } }).map((q) => ({ ...q, stem: "A brand new stem", id: "g_replacement1" })));
    const target = view.questions[1];
    const res = await client(t, u).post(`/api/generation/runs/${view.id}/regenerate`, { questionId: target.id, avoid: ["Something the user already has"] });
    expect(res.status).toBe(200);
    const q = (await res.json()).question;
    expect(q).toMatchObject({ id: target.id, stem: "A brand new stem", difficulty: target.difficulty });

    const call = lastCall().body;
    expect(call.chat.model).toBe("mock-chat"); // not mock-chat-plain
    expect(call.spec).toMatchObject({ count: 1, difficulty: target.difficulty });
    expect(call.avoid).toEqual(expect.arrayContaining(["Something the user already has", view.questions[0].stem, view.questions[2].stem]));
    expect(call.avoid).not.toContain(target.stem);

    const stored = (await (await client(t, u).get(`/api/generation/runs/${view.id}`)).json()).run.questions;
    expect(stored.map((s: { id: string }) => s.id)).toEqual(view.questions.map((s: { id: string }) => s.id));
    expect(stored[1].stem).toBe("A brand new stem");
    expect(stored[0].stem).toBe(view.questions[0].stem);
    expect(await usage(u, "llm.requests")).toBe(2);
  });

  it("validates the target, maps failures and counts against quota and the rate limit", async () => {
    const u = await ready();
    const { run: view } = await run(u, "mcq", mcqBody({ count: 2 }));
    const c = client(t, u);
    expect((await c.post(`/api/generation/runs/${view.id}/regenerate`, { questionId: "g_unknown" })).status).toBe(422);
    expect((await c.post(`/api/generation/runs/${view.id}/regenerate`, { questionId: view.questions[0].id, extra: 1 })).status).toBe(422);
    expect((await c.post(`/api/generation/runs/${view.id}/regenerate`, { questionId: view.questions[0].id, avoid: Array.from({ length: 61 }, () => "x") })).status).toBe(422);

    fails("PROVIDER_RATE_LIMITED", { retry_after_seconds: 4 });
    const limited = await c.post(`/api/generation/runs/${view.id}/regenerate`, { questionId: view.questions[0].id });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("4");
    fails("GENERATION_FAILED", { reason: "NO_VALID_QUESTIONS" });
    expect((await c.post(`/api/generation/runs/${view.id}/regenerate`, { questionId: view.questions[0].id })).status).toBe(502);
    returns(() => []);
    const invalid = await c.post(`/api/generation/runs/${view.id}/regenerate`, { questionId: view.questions[0].id });
    expect(invalid.status).toBe(502);
    expect((await invalid.json()).error.code).toBe("GENERATION_FAILED");

    await withEnv({ AI_DAILY_REQUEST_LIMIT: "1" }, async () => {
      expect((await c.post(`/api/generation/runs/${view.id}/regenerate`, { questionId: view.questions[0].id })).status).toBe(429);
    });
  });
});

describe("saving generated questions: provenance comes from the run, never from the client", () => {
  const input = (q: any, over: Record<string, unknown> = {}) => ({
    runQuestionId: q.id, kind: q.kind, language: q.language, stem: q.stem, stimulus: q.stimulus, difficulty: q.difficulty, topic: q.topic, subject: q.subject, tags: q.tags,
    options: q.options, correctOptionId: q.correctOptionId, explanation: q.explanation, shortNote: q.shortNote, marks: q.marks, negativeMarks: q.negativeMarks,
    parts: q.parts.map((p: any) => ({ id: p.id, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks, answerText: p.answer?.text ?? null })), answerText: q.answer?.text ?? null, ...over,
  });

  it("keeps evidence, source support and provenance for unchanged AI questions and flags edited ones", async () => {
    const u = await ready();
    const d = await readyDoc(u);
    const { run: view } = await run(u, "mcq", { documentIds: [d.id], grounding: "SOURCE_ONLY", count: 2 });
    const [q1, q2] = view.questions;
    returns((req) => fakeQuestions("mcq", req)); // (unused afterwards)
    const res = await client(t, u).post("/api/questions", { runId: view.id, questions: [input(q1), input(q2, { stem: `${q2.stem} (edited by me)` })] });
    expect(res.status).toBe(201);
    const [a, b] = (await res.json()).items.map((i: any) => i.question);
    expect(a).toMatchObject({ origin: "AI_GENERATED", sourceSupport: "SOURCE_QUOTED", modifiedByUser: false, provenance: { provider: "mock", model: "mock-chat", generationRunId: view.id } });
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0]).toMatchObject({ documentId: d.id, documentName: "notes.pdf", quoteVerified: true });
    expect(a.provenance.generatedAt).toBeTruthy();
    expect(b).toMatchObject({ origin: "AI_GENERATED", modifiedByUser: true, sourceSupport: "SOURCE_QUOTED" });
    // the correct answer, explanation and short note were persisted
    expect(a.correctOptionId).toBe(a.options[0].id);
    expect(a.explanation).toBe(q1.explanation);
    expect(a.shortNote).toBe(q1.shortNote);
  });

  it("changing only the metadata of an AI question is not a content modification", async () => {
    const u = await ready();
    const { run: view } = await run(u, "mcq", mcqBody({ count: 1 }));
    const res = await client(t, u).post("/api/questions", { runId: view.id, questions: [input(view.questions[0], { tags: ["mine"], topic: "Another topic", difficulty: "HARD" })] });
    expect((await res.json()).items[0].question).toMatchObject({ modifiedByUser: false, tags: ["mine"], difficulty: "HARD", sourceSupport: "MODEL_ONLY" });
  });

  it("answer basis: unchanged answers keep their basis and evidence; edited ones become USER_PROVIDED; 'insufficient evidence' is preserved", async () => {
    const u = await ready();
    returns((req) => {
      const q = fakeQuestions("cq", { ...req, spec: { ...req.spec, count: 1 } })[0]!;
      const ev = [{ document_id: null, document_name: "Pasted text", page: null, section: null, quote: "verbatim quote", quote_verified: true }];
      q.parts[0]!.answer = { text: "Supported answer", basis: "SOURCE_SUPPORTED", sources: ev };
      q.parts[1]!.answer = { text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] };
      q.parts[2]!.answer = { text: "Original answer", basis: "SOURCE_SUPPORTED", sources: ev };
      q.parts[3]!.answer = null;
      return [q];
    });
    const { run: view } = await run(u, "cq", cqBody({ pastedText: "verbatim quote here", grounding: "SOURCE_ONLY", count: 1 }));
    const q = view.questions[0];
    const edited = input(q);
    edited.parts[2].answerText = "My own rewritten answer";
    edited.parts[3].answerText = "I wrote this one";
    const saved = (await (await client(t, u).post("/api/questions", { runId: view.id, questions: [edited] })).json()).items[0].question;
    expect(saved.parts[0].answer).toMatchObject({ text: "Supported answer", basis: "SOURCE_SUPPORTED" });
    expect(saved.parts[0].answer.sources).toHaveLength(1);
    expect(saved.parts[1].answer).toEqual({ text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] });
    expect(saved.parts[2].answer).toEqual({ text: "My own rewritten answer", basis: "USER_PROVIDED", sources: [] });
    expect(saved.parts[3].answer).toEqual({ text: "I wrote this one", basis: "USER_PROVIDED", sources: [] });
    expect(saved.modifiedByUser).toBe(true);
    expect(saved.marks).toBe(10);
  });

  it("survives deletion of the run and of the source document", async () => {
    const u = await ready();
    const d = await readyDoc(u);
    const { run: view } = await run(u, "mcq", { documentIds: [d.id], grounding: "SOURCE_ONLY", count: 1 });
    const q = (await (await client(t, u).post("/api/questions", { runId: view.id, questions: [input(view.questions[0])] })).json()).items[0].question;
    await client(t, u).delete(`/api/generation/runs/${view.id}`);
    await db.document.delete({ where: { id: d.id } });
    const got = (await (await client(t, u).get(`/api/questions/${q.id}`)).json()).question;
    expect(got.provenance).toMatchObject({ provider: "mock", model: "mock-chat", generationRunId: null });
    expect(got.sources[0]).toMatchObject({ documentId: null, documentName: "notes.pdf", quoteVerified: true });
  });

  it("an expired run can no longer be used as a provenance source", async () => {
    const u = await ready();
    const { run: view } = await run(u, "mcq", mcqBody({ count: 1 }));
    await db.generationRun.update({ where: { id: view.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await client(t, u).post("/api/questions", { runId: view.id, questions: [input(view.questions[0])] });
    expect(res.status).toBe(422);
    expect((await res.json()).error.details.fields.runId).toMatch(/expired/);
  });
});
