import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { db } from "../../src/lib/db.js";
import { logger } from "../../src/lib/logger.js";
import { readVectorStorage, vectorStorageCheck } from "../../src/modules/ai/connection.js";
import { resolveModel, toWireParams, NO_PARAMS } from "../../src/modules/ai/preferences.js";
import { chatBlock } from "../../src/modules/analysis/model.js";
import { client, makeApp, readSse, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => vi.restoreAllMocks());

const KEY = "mock-valid-key";
const PARAMS = { temperature: 0.4, topP: 0.9, maxTokens: 2000, frequencyPenalty: 0.5, presencePenalty: -0.5, seed: 42 };
const good = (over: Record<string, unknown> = {}) => ({ apiKey: KEY, chatModelId: "mock-chat", embeddingModelId: "mock-embed", ...over });
const put = (u: TestUser, body: unknown) => client(t, u).put("/api/ai/connection", body);
const test = (u: TestUser, body: unknown) => client(t, u).post("/api/ai/connection/test", body);
const getConn = async (u: TestUser) => (await (await client(t, u).get("/api/ai/connection")).json()).connection;
const snapshot = async (u: TestUser) =>
  JSON.stringify({
    prefs: await db.modelPreference.findMany({ where: { userId: u.id }, orderBy: { task: "asc" } }),
    creds: await db.providerCredential.findMany({ where: { userId: u.id } }),
  });

describe("generation parameters: validation and persistence", () => {
  it("saves every parameter, returns them, and sends only the set ones to the provider test", async () => {
    const u = await createUser();
    const res = await put(u, good({ params: PARAMS }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connection.params).toEqual(PARAMS);
    expect(body.connection.paramLimits).toMatchObject({ temperature: { min: 0, max: 2 }, frequencyPenalty: { min: -2, max: 2 }, seed: { min: 0 } });
    expect(body.checks.chatParams).toMatchObject({ ok: true, verified: ["frequency_penalty", "max_tokens", "presence_penalty", "seed", "temperature", "top_p"] });
    expect(t.rag.validateCalls[0]!.chat_params).toEqual({ temperature: 0.4, top_p: 0.9, max_output_tokens: 2000, frequency_penalty: 0.5, presence_penalty: -0.5, seed: 42 });

    const row = await db.modelPreference.findUniqueOrThrow({ where: { userId_task: { userId: u.id, task: "DEFAULT" } } });
    expect(row).toMatchObject({ temperature: 0.4, topP: 0.9, maxTokens: 2000, extraParams: { frequencyPenalty: 0.5, presencePenalty: -0.5, seed: 42 } });
    expect(await getConn(u)).toMatchObject({ params: PARAMS });
    expect((await resolveModel(u.id, "CHAT"))?.params).toEqual(PARAMS);
  });

  it("an unset parameter is never sent: no params => no chat_params in the validation request", async () => {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    expect(t.rag.validateCalls[0]).not.toHaveProperty("chat_params");
    expect(toWireParams(NO_PARAMS)).toEqual({});
  });

  it("omitted params keep the saved ones; null clears a single one; an empty object resets to provider defaults", async () => {
    const u = await createUser();
    await put(u, good({ params: PARAMS }));
    await put(u, good({ chatModelId: "mock-chat-2" })); // models change, params omitted
    expect((await getConn(u)).params).toEqual(PARAMS);
    await put(u, good({ params: { ...PARAMS, seed: null, frequencyPenalty: null } }));
    expect((await getConn(u)).params).toEqual({ ...PARAMS, seed: null, frequencyPenalty: null });
    await put(u, good({ params: {} }));
    expect((await getConn(u)).params).toEqual(NO_PARAMS);
    const row = await db.modelPreference.findUniqueOrThrow({ where: { userId_task: { userId: u.id, task: "DEFAULT" } } });
    expect(row.extraParams).toBeNull();
  });

  it.each([
    ["temperature above 2", { temperature: 2.1 }], ["negative temperature", { temperature: -0.1 }], ["top-p above 1", { topP: 1.01 }], ["negative top-p", { topP: -1 }],
    ["zero max tokens", { maxTokens: 0 }], ["huge max tokens", { maxTokens: 1_000_000 }], ["fractional max tokens", { maxTokens: 10.5 }],
    ["frequency penalty above 2", { frequencyPenalty: 2.5 }], ["presence penalty below -2", { presencePenalty: -2.01 }],
    ["negative seed", { seed: -1 }], ["fractional seed", { seed: 1.5 }], ["huge seed", { seed: 2 ** 40 }],
    ["numbers as strings", { temperature: "0.5" }], ["NaN-like", { temperature: null, topP: "NaN" }], ["unknown parameter", { topK: 40 }],
  ])("rejects %s on the server, before any provider call, without changing anything", async (_name, params) => {
    const u = await createUser();
    await put(u, good());
    const before = await snapshot(u);
    t.rag.validateCalls.length = 0;
    const res = await put(u, good({ params }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION");
    expect(t.rag.validateCalls).toHaveLength(0);
    expect(await snapshot(u)).toBe(before);
    expect((await test(u, good({ params }))).status).toBe(422);
  });

  it("accepts the boundary values", async () => {
    const u = await createUser();
    const res = await put(u, good({ params: { temperature: 2, topP: 0, maxTokens: 32768, frequencyPenalty: -2, presencePenalty: 2, seed: 0 } }));
    expect(res.status).toBe(200);
  });

  it("a stored value that is corrupt or out of range is ignored at runtime, never forwarded", async () => {
    const u = await createUser();
    await put(u, good());
    await db.modelPreference.update({ where: { userId_task: { userId: u.id, task: "DEFAULT" } }, data: { extraParams: { frequencyPenalty: 99, seed: "x", evil: 1 } } });
    expect((await resolveModel(u.id, "CHAT"))?.params).toEqual(NO_PARAMS);
    await db.modelPreference.update({ where: { userId_task: { userId: u.id, task: "DEFAULT" } }, data: { extraParams: "not an object" } });
    expect((await resolveModel(u.id, "CHAT"))?.params).toEqual(NO_PARAMS);
  });
});

describe("unsupported parameters", () => {
  it("a model whose listing lacks a parameter cannot be saved with it; the last working settings stay active", async () => {
    const u = await createUser();
    await put(u, good({ params: PARAMS }));
    const before = await snapshot(u);
    const res = await put(u, good({ chatModelId: "limited-chat-free", params: { ...PARAMS, frequencyPenalty: 1 } }));
    expect(res.status).toBe(422);
    const err = (await res.json()).error;
    expect(err.code).toBe("AI_CONFIG_INVALID");
    expect(err.details.checks.chatParams).toMatchObject({ ok: false, code: "PARAMETER_UNSUPPORTED", unsupported: ["frequency_penalty", "presence_penalty"] });
    expect(err.details.checks.chat.ok).toBe(true); // the model exists; only the parameters are the problem
    expect(err.details.fields.params).toMatch(/frequency_penalty/);
    expect(err.details.fields.chatModelId).toBeUndefined();
    expect(await snapshot(u)).toBe(before);
  });

  it("the same model is fine without the unsupported parameters", async () => {
    const u = await createUser();
    const res = await put(u, good({ chatModelId: "limited-chat-free", params: { temperature: 0.3, seed: 5 } }));
    expect(res.status).toBe(200);
    expect((await res.json()).checks.chatParams).toMatchObject({ ok: true });
  });
});

describe("POST /api/ai/connection/test — explicit, no writes", () => {
  it("reports the six checks separately and writes nothing", async () => {
    const u = await createUser();
    await put(u, good());
    const before = await snapshot(u);
    const res = await test(u, good({ chatModelId: "limited-chat-x", params: { presencePenalty: 1, temperature: 0.2 } }));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.ok).toBe(false);
    expect(Object.keys(out.checks)).toEqual(["auth", "chat", "chatParams", "embedding", "dimension", "database"]);
    expect(out.checks).toMatchObject({ auth: { ok: true }, chat: { ok: true }, chatParams: { ok: false, code: "PARAMETER_UNSUPPORTED" }, embedding: { ok: true }, dimension: { ok: true, dimension: 1536 }, database: { ok: true } });
    expect(out).toMatchObject({ measuredDimension: 1536, nativeDimension: 1536, requestedDimension: 1536, dimensionSource: "database" }); // omitted = keep the saved size
    expect(out).not.toHaveProperty("expectedDimension");
    expect(await snapshot(u)).toBe(before);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("works before anything is saved (using the key typed into the form) and still saves nothing", async () => {
    const u = await createUser();
    const out = await (await test(u, good())).json();
    expect(out.ok).toBe(true);
    expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.providerCredential.count({ where: { userId: u.id } })).toBe(0);
  });

  it("a model whose own size is 3072 is simply a 3072-dimensional model; asking for 1536 it ignores is refused with both numbers", async () => {
    const u = await createUser();
    const auto = await (await test(u, good({ embeddingModelId: "wide-embed-big" }))).json();
    expect(auto).toMatchObject({ ok: true, measuredDimension: 3072, nativeDimension: 3072, requestedDimension: null, dimensionSource: "model" });
    expect(auto.checks.dimension).toMatchObject({ ok: true, dimension: 3072 });
    expect(auto.checks.database).toMatchObject({ ok: true });

    const asked = await (await test(u, good({ embeddingModelId: "wide-embed-big", embeddingDimension: 1536 }))).json();
    expect(asked.ok).toBe(false);
    expect(asked.checks.embedding).toMatchObject({ ok: true }); // the model itself works
    expect(asked.checks.dimension).toMatchObject({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", dimension: 3072, native_dimension: 3072 });
    expect(asked.checks.dimension.message).toMatch(/returned 3072-dimensional vectors when asked for 1536/);
    expect(asked.checks.dimension.message).toMatch(/never padded or truncated/);
    expect(asked.checks.database).toMatchObject({ skipped: true }); // nothing to store, so nothing to check
    expect(asked).toMatchObject({ measuredDimension: null, nativeDimension: 3072, requestedDimension: 1536, dimensionSource: "request" });
  });

  it("bad key: later checks are skipped; bad models are attributed to the right check", async () => {
    const u = await createUser();
    const bad = await (await test(u, good({ apiKey: "mock-wrong-key" }))).json();
    expect(bad.checks).toMatchObject({ auth: { ok: false, code: "PROVIDER_AUTH_INVALID" }, chat: { skipped: true }, chatParams: { skipped: true }, embedding: { skipped: true }, dimension: { skipped: true }, database: { skipped: true } });
    const models = await (await test(u, good({ chatModelId: "bad-chat-1", embeddingModelId: "bad-embed-1" }))).json();
    expect(models.checks.chat).toMatchObject({ ok: false, code: "MODEL_NOT_FOUND" });
    expect(models.checks.chatParams.skipped).toBe(true);
    expect(models.checks.embedding).toMatchObject({ ok: false, code: "MODEL_NOT_FOUND" });
    expect(models.checks.dimension.skipped).toBe(true);
  });

  it("requires sign-in and is rate limited", async () => {
    expect((await client(t).post("/api/ai/connection/test", good())).status).toBe(401);
    const u = await createUser();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await test(u, good())).status);
    expect(statuses).toContain(429);
  });

  it("nothing calls the provider unless a user explicitly asks (reading settings is free)", async () => {
    const u = await createUser();
    await put(u, good());
    t.rag.validateCalls.length = 0;
    await client(t, u).get("/api/ai/connection");
    await client(t, u).get("/api/ai/public-models?kind=chat");
    expect(t.rag.validateCalls).toHaveLength(0);
  });
});

describe("safe diagnostics and error handling", () => {
  it("shows sanitised diagnostics per failed check and logs them without the key", async () => {
    const u = await createUser();
    t.rag.validateScript = (req) => ({
      ok: false, provider: req.provider, embedding_dimension: null,
      checks: {
        auth: { ok: true }, chat: { ok: true }, chat_params: { ok: null, skipped: true },
        embedding: { ok: false, code: "PROVIDER_ERROR", message: "The AI provider returned an error. Please try again.", diagnostics: { endpoint: "POST /embeddings", http_status: 400, upstream_code: "400", upstream_provider: "Nvidia" } },
      },
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn"; // the suite runs at "error"; the diagnostic line is a warning
    let res: Response;
    try {
      res = await put(u, good({ apiKey: "mock-valid-key" }));
    } finally {
      process.env.LOG_LEVEL = level;
    }
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(res.status).toBe(422);
    const err = (await res.json()).error;
    expect(err.details.checks.embedding.diagnostics).toEqual({ endpoint: "POST /embeddings", http_status: 400, upstream_code: "400", upstream_provider: "Nvidia" });
    expect(logged).toContain("ai.connection.check_failed");
    expect(logged).toContain("POST /embeddings");
    expect(logged).not.toContain(KEY);
    void logger;
  });

  it("an out-of-date rag_agent (404/422 for the validate route) is reported as such, not as a provider error", async () => {
    const u = await createUser();
    const before = await snapshot(u);
    t.rag.validateError = new RagAgentError("VALIDATION", "Not found.", false, null, 404);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await put(u, good());
    expect(res.status).toBe(503);
    const err = (await res.json()).error;
    expect(err.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(err.details.providerCode).toBe("AI_SERVICE_OUTDATED");
    expect(err.message).toMatch(/Restart rag_agent/);
    expect((await test(u, good())).status).toBe(503);
    expect(await snapshot(u)).toBe(before);
  });

  it("a genuine provider error keeps its own code", async () => {
    const u = await createUser();
    t.rag.validateError = new RagAgentError("PROVIDER_RATE_LIMITED", "slow down", true, 5, 429);
    const res = await put(u, good());
    expect((await res.json()).error.details.providerCode).toBe("PROVIDER_RATE_LIMITED");
  });
});

describe("database / index compatibility check", () => {
  it("reads the real pgvector column of the test database", async () => {
    const s = await readVectorStorage();
    expect(s.extension).toBeTruthy();
    expect(s.column).toMatch(/^vector(\(\d+\))?$/);
  });

  it("decides compatibility from the column definition", () => {
    expect(vectorStorageCheck({ extension: "0.8.0", column: "vector(1536)" }, 1536)).toMatchObject({ ok: true });
    expect(vectorStorageCheck({ extension: "0.8.0", column: "vector(1536)" }, 2048)).toMatchObject({ ok: false, code: "DB_DIMENSION_MISMATCH", dimension: 1536 });
    expect(vectorStorageCheck({ extension: "0.8.0", column: "vector" }, 2048)).toMatchObject({ ok: true });
    expect(vectorStorageCheck({ extension: null, column: "vector(1536)" }, 1536)).toMatchObject({ ok: false, code: "DB_VECTOR_UNAVAILABLE" });
    expect(vectorStorageCheck({ extension: "0.8.0", column: null }, 1536)).toMatchObject({ ok: false, code: "DB_VECTOR_UNAVAILABLE" });
  });
});

describe("GET /api/ai/public-models — optional suggestions", () => {
  const get = (u: TestUser | undefined, qs = "") => client(t, u).get(`/api/ai/public-models${qs}`);

  it("requires sign-in", async () => {
    expect((await get(undefined)).status).toBe(401);
  });

  it("lists, filters by text and by free, and never needs an API key", async () => {
    const u = await createUser();
    const all = await (await get(u, "?kind=chat")).json();
    expect(all).toMatchObject({ available: true, total: 3 });
    expect((await (await get(u, "?kind=chat&free=1")).json()).models.map((m: { id: string }) => m.id)).toEqual(["acme/free-chat:free"]);
    expect((await (await get(u, "?kind=chat&q=PAID")).json()).models.map((m: { id: string }) => m.id)).toEqual(["acme/paid-chat"]);
    expect((await (await get(u, "?kind=embedding")).json()).models.map((m: { id: string }) => m.id)).toEqual(["acme/embed-small"]);
    expect(t.rag.publicModelCalls.map((c) => c.provider)).toEqual(["openrouter", "openrouter", "openrouter", "openrouter"]);
  });

  it("looks up one exact model to show which parameters it lists (null = the listing does not say)", async () => {
    const u = await createUser();
    const hit = await (await get(u, "?kind=chat&exact=acme/free-chat:free")).json();
    expect(hit.match).toMatchObject({ id: "acme/free-chat:free", free: true, supported_parameters: ["max_tokens", "seed", "temperature", "top_p"] });
    expect((await (await get(u, "?kind=chat&exact=acme/unknown-chat")).json()).match.supported_parameters).toBeNull();
    expect((await (await get(u, "?kind=chat&exact=nope/nothing")).json()).match).toBeNull();
  });

  it("providers without a public listing say so; unknown providers and bad queries are refused", async () => {
    const u = await createUser();
    expect((await (await get(u, "?provider=groq&kind=chat")).json())).toMatchObject({ available: false, models: [] });
    expect((await get(u, "?provider=evil")).status).toBe(422);
    expect((await get(u, "?kind=bogus")).status).toBe(422);
    expect((await get(u, `?q=${"x".repeat(101)}`)).status).toBe(422);
  });

  it("caps the result size", async () => {
    const u = await createUser();
    t.rag.publicModelsScript = (provider, kind) => ({ provider, kind, available: true, fetched_at: "now", models: Array.from({ length: 300 }, (_v, i) => ({ id: `m/${i}`, name: `M ${i}`, context_length: null, free: false, supported_parameters: null })) });
    const out = await (await get(u, "?kind=chat")).json();
    expect(out.models).toHaveLength(40);
    expect(out.total).toBe(300);
  });

  it("a rag_agent failure leaves manual entry usable and leaks nothing", async () => {
    const u = await createUser();
    t.rag.publicModelsScript = () => {
      throw new RagAgentError("PROVIDER_UNAVAILABLE", "upstream body with sk-secret", true, null, 502);
    };
    const res = await get(u, "?kind=chat");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toMatch(/type a model ID/);
    expect(text).not.toContain("sk-secret");
  });
});

describe("runtime integration: the saved settings are what every AI feature sends", () => {
  async function configured(params: Record<string, unknown> = PARAMS) {
    const u = await createUser();
    expect((await put(u, good({ params }))).status).toBe(200);
    return u;
  }

  it("chat conversations send exactly the saved parameters, and a changed setting takes effect on the next message with no restart", async () => {
    const u = await configured();
    const conv = (await (await client(t, u).post("/api/conversations", { mode: "GENERAL" })).json()).conversation.id as string;
    const send = async () => {
      const res = await client(t, u).post(`/api/conversations/${conv}/messages`, { content: "Hello there" });
      await readSse(res);
      return t.rag.chatCalls.at(-1)!;
    };
    expect((await send()).chat.params).toEqual({ temperature: 0.4, top_p: 0.9, max_output_tokens: 2000, frequency_penalty: 0.5, presence_penalty: -0.5, seed: 42 });
    expect((await put(u, good({ params: { temperature: 1.1 } }))).status).toBe(200);
    expect((await send()).chat.params).toEqual({ temperature: 1.1 });
  });

  it("MCQ and CQ generation use them (the output-token cap still applies)", async () => {
    const u = await configured({ ...PARAMS, maxTokens: 32768 });
    for (const [kind, body] of [["mcq", { topic: "Cells", grounding: "GENERAL", count: 2 }], ["cq", { topic: "Rivers", grounding: "GENERAL", mode: "WITH_ANSWERS", structure: "stimulus_4part", count: 1 }]] as const) {
      await readSse(await client(t, u).post(`/api/generation/${kind}`, body));
      const sent = t.rag.generateCalls.at(-1)!.body.chat;
      expect(sent.model).toBe("mock-chat");
      expect(sent.params).toMatchObject({ temperature: 0.4, top_p: 0.9, frequency_penalty: 0.5, presence_penalty: -0.5, seed: 42 });
      expect(sent.params.max_output_tokens).toBeLessThanOrEqual(32768);
    }
  });

  it("AI feedback / analysis requests use them too", async () => {
    const u = await configured();
    const model = { provider: "MOCK" as const, modelId: "mock-chat", key: KEY, credentialId: "c", params: (await resolveModel(u.id, "ANALYSIS"))!.params };
    expect(chatBlock(model).params).toMatchObject({ temperature: 0.4, top_p: 0.9, frequency_penalty: 0.5, presence_penalty: -0.5, seed: 42 });
  });

  it("ingestion and query embedding use the saved embedding model", async () => {
    const u = await configured();
    expect((await resolveModel(u.id, "EMBEDDING"))).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 });
  });
});
