import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { db } from "../../src/lib/db.js";
import { decryptSecret } from "../../src/lib/crypto.js";
import { deriveProvider } from "../../src/modules/ai/providers.js";
import { resolveModel } from "../../src/modules/ai/preferences.js";
import { ingestHandlers } from "../../src/modules/jobs/ingest.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { DOCX, form, textFile } from "../helpers/files.js";
import { client, makeApp, readSse, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => vi.restoreAllMocks());

const KEY = "mock-valid-key";
const OR_KEY = "sk-or-v1-SuperSecretOpenRouterKey1234567890wxyz";
const good = (over: Record<string, unknown> = {}) => ({ apiKey: KEY, chatModelId: "mock-chat", embeddingModelId: "mock-embed", ...over });
const put = (u: TestUser, body: unknown) => client(t, u).put("/api/ai/connection", body);
const getConn = async (u: TestUser, app: TestApp = t) => (await (await client(app, u).get("/api/ai/connection")).json()).connection;
const credRow = (u: TestUser, provider = "MOCK") => db.providerCredential.findUniqueOrThrow({ where: { userId_provider: { userId: u.id, provider: provider as "MOCK" } } });

async function readyDoc(u: TestUser, over: Record<string, unknown> = {}) {
  const storageKey = `u/${u.id}/${randomUUID().replaceAll("-", "")}`;
  await t.storage.put(storageKey, new TextEncoder().encode("Cells are the unit of life.")); // so a re-embed can read the file back
  return db.document.create({
    data: { ownerId: u.id, name: "notes.txt", extension: "txt", mimeType: "text/plain", sizeBytes: 100, sha256: randomUUID(), storageKey, status: "READY", embeddingModel: "mock-embed", embeddingProvider: "MOCK", processingVersion: 1, ...over },
  });
}
async function insertChunk(documentId: string, ownerId: string, model = "mock-embed", version = 1) {
  await db.$executeRaw`INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingModel")
    VALUES (${randomUUID()}, ${documentId}, ${ownerId}, 0, ${version}, 'Cells are the unit of life', 5, ${model})`;
}
const docOnlyConv = async (u: TestUser, documentIds: string[]) => (await (await client(t, u).post("/api/conversations", { mode: "DOCUMENT_ONLY", documentIds })).json()).conversation.id as string;
const send = (u: TestUser, id: string, content: string) => client(t, u).post(`/api/conversations/${id}/messages`, { content });

describe("PUT /api/ai/connection — saving", () => {
  it("validates with the provider, then saves the key (encrypted), both model ids and the measured dimension", async () => {
    const u = await createUser();
    const res = await put(u, good({ chatModelId: " mock-chat-custom ", embeddingModelId: "mock-embed" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text);
    expect(body.checks).toMatchObject({ auth: { ok: true }, chat: { ok: true }, embedding: { ok: true, dimension: 1536 } });
    expect(body).toMatchObject({ reembedRequired: false, documentsAffected: 0 });
    expect(body.connection).toMatchObject({
      configured: true, provider: "mock", providerLabel: "Mock (testing only)", apiKey: { configured: true, masked: "••••-key", status: "VALID" },
      chatModelId: "mock-chat-custom", embeddingModelId: "mock-embed", embeddingDimension: 1536, expectedDimension: 1536, mixedProviders: false,
    });
    expect(body.connection.validatedAt).toBeTruthy();
    expect(body.connection.costNote).toMatch(/two tiny paid requests/);

    // the exact ids and key went to the AI service, server-to-server
    expect(t.rag.validateCalls).toEqual([{ provider: "mock", api_key: KEY, chat_model: "mock-chat-custom", embedding_model: "mock-embed" }]);
    // stored encrypted, bound to user + provider
    const row = await credRow(u);
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(decryptSecret(row, `${u.id}:MOCK`)).toBe(KEY);
    const prefs = await db.modelPreference.findMany({ where: { userId: u.id }, orderBy: { task: "asc" } });
    expect(prefs.map((p) => [p.task, p.modelId, p.credentialId === row.id, p.validatedAt !== null])).toEqual([["DEFAULT", "mock-chat-custom", true, true], ["EMBEDDING", "mock-embed", true, true]]);
    expect(prefs.find((p) => p.task === "EMBEDDING")?.embeddingDimension).toBe(1536);
  });

  it("derives the provider from the key (OpenRouter is the default) and never accepts a provider or URL", async () => {
    const u = await createUser();
    t.rag.validKeys.add(OR_KEY);
    const res = await put(u, { apiKey: OR_KEY, chatModelId: "deepseek/deepseek-chat", embeddingModelId: "openai/text-embedding-3-small" });
    expect(res.status).toBe(200);
    expect((await res.json()).connection).toMatchObject({ provider: "openrouter", providerLabel: "OpenRouter", apiKey: { masked: "••••wxyz" } });
    expect(t.rag.validateCalls[0]).toMatchObject({ provider: "openrouter", chat_model: "deepseek/deepseek-chat", embedding_model: "openai/text-embedding-3-small" });
    for (const extra of [{ provider: "openai" }, { baseUrl: "http://169.254.169.254" }, { dimensions: 768 }]) expect((await put(u, { ...good(), ...extra })).status).toBe(422);
    expect(t.rag.validateCalls).toHaveLength(1); // rejected before any provider call
  });

  it("rejects empty, malformed and over-long inputs on the server with field errors", async () => {
    const u = await createUser();
    const fields = async (body: unknown) => {
      const res = await put(u, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      return (await res.json()).error.details.fields as Record<string, string>;
    };
    expect(await fields(good({ chatModelId: "" }))).toHaveProperty("chatModelId");
    expect(await fields(good({ chatModelId: "   " }))).toHaveProperty("chatModelId");
    expect(await fields(good({ embeddingModelId: "has space" }))).toHaveProperty("embeddingModelId");
    expect(await fields(good({ embeddingModelId: "x".repeat(201) }))).toHaveProperty("embeddingModelId");
    expect(await fields(good({ chatModelId: "bad;id&drop" }))).toHaveProperty("chatModelId");
    expect(await fields(good({ chatModelId: "../etc/passwd" }))).toHaveProperty("chatModelId");
    expect(await fields(good({ apiKey: "short" }))).toHaveProperty("apiKey");
    expect(await fields(good({ apiKey: "has a space inside" }))).toHaveProperty("apiKey");
    expect(await fields(good({ apiKey: "k".repeat(1001) }))).toHaveProperty("apiKey");
    expect((await put(u, { chatModelId: "m" })).status).toBe(422); // missing embedding id
    expect(t.rag.validateCalls).toHaveLength(0);
    expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
  });

  it("a blank or missing key keeps the saved key; with no saved key it is a field error", async () => {
    const u = await createUser();
    const none = await put(u, good({ apiKey: "" }));
    expect(none.status).toBe(422);
    expect((await none.json()).error.details.fields.apiKey).toMatch(/Enter your API key/);
    expect(await put(u, good())).toHaveProperty("status", 200);
    const before = await credRow(u);
    for (const variant of [{ apiKey: "" }, { apiKey: "   " }, { apiKey: undefined }]) {
      const res = await put(u, good({ ...variant, chatModelId: `mock-chat-${randomUUID().slice(0, 4)}` }));
      expect(res.status).toBe(200);
    }
    // validation used the decrypted saved key; the credential row itself was not rewritten
    expect(t.rag.validateCalls.slice(1).every((c) => c.api_key === KEY)).toBe(true);
    const after = await credRow(u);
    expect(after.ciphertext).toBe(before.ciphertext);
    expect(after.rotatedAt).toBeNull();
    expect((await getConn(u)).apiKey.masked).toBe("••••-key");
  });

  it("changing only the models keeps the key and replaces the models", async () => {
    const u = await createUser();
    await put(u, good());
    const res = await put(u, { chatModelId: "mock-chat-plain", embeddingModelId: "mock-embed" });
    expect(res.status).toBe(200);
    expect((await getConn(u)).chatModelId).toBe("mock-chat-plain");
  });
});

describe("PUT /api/ai/connection — failures never change the active configuration", () => {
  async function configured() {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    const snapshot = async () => JSON.stringify([await db.providerCredential.findMany({ where: { userId: u.id } }), await db.modelPreference.findMany({ where: { userId: u.id }, orderBy: { task: "asc" } })]);
    return { u, before: await snapshot(), snapshot };
  }

  it("a rejected API key: 422 AI_CONFIG_INVALID, nothing written, previous config intact", async () => {
    const { u, before, snapshot } = await configured();
    const res = await put(u, good({ apiKey: "mock-wrong-key-123" }));
    expect(res.status).toBe(422);
    const err = (await res.json()).error;
    expect(err.code).toBe("AI_CONFIG_INVALID");
    expect(err.details.checks).toMatchObject({ auth: { ok: false, code: "PROVIDER_AUTH_INVALID" }, chat: { skipped: true }, embedding: { skipped: true } });
    expect(err.details.fields.apiKey).toMatch(/rejected the API key/);
    expect(JSON.stringify(err)).not.toContain("mock-wrong-key-123");
    expect(await snapshot()).toBe(before);
    expect(await getConn(u)).toMatchObject({ configured: true, chatModelId: "mock-chat", apiKey: { masked: "••••-key", status: "VALID" } });
  });

  it("an unsupported chat model and an unsupported embedding model are rejected on their own fields", async () => {
    const { u, before, snapshot } = await configured();
    const chat = await (await put(u, good({ chatModelId: "bad-chat-model" }))).json();
    expect(chat.error.details.fields).toEqual({ chatModelId: expect.stringMatching(/not found/) });
    const emb = await (await put(u, good({ embeddingModelId: "bad-embed-model" }))).json();
    expect(emb.error.details.fields).toEqual({ embeddingModelId: expect.stringMatching(/not found/) });
    const both = await (await put(u, good({ chatModelId: "bad-chat-x", embeddingModelId: "bad-embed-x" }))).json();
    expect(Object.keys(both.error.details.fields).sort()).toEqual(["chatModelId", "embeddingModelId"]);
    expect(await snapshot()).toBe(before);
  });

  it("an embedding model with the wrong dimension is refused with the measured number", async () => {
    const { u, before, snapshot } = await configured();
    const err = (await (await put(u, good({ embeddingModelId: "wide-embed-3072" }))).json()).error;
    expect(err.details.checks.embedding).toMatchObject({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", dimension: 3072 });
    expect(err.details.fields.embeddingModelId).toMatch(/3072/);
    expect(await snapshot()).toBe(before);
    // defence in depth: even if the AI service reported "ok" with another length, the backend refuses to activate it
    t.rag.validateScript = (req) => ({ ok: true, provider: req.provider, embedding_dimension: 768, checks: { auth: { ok: true }, chat: { ok: true }, embedding: { ok: true, dimension: 768 } } });
    const res = await put(u, good({ embeddingModelId: "narrow-embed" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.details.fields.embeddingModelId).toMatch(/768/);
    expect(await snapshot()).toBe(before);
  });

  it("non-finite or malformed provider answers are surfaced safely (no activation)", async () => {
    const { u, before, snapshot } = await configured();
    t.rag.validateScript = (req) => ({ ok: false, provider: req.provider, embedding_dimension: null, checks: { auth: { ok: true }, chat: { ok: true }, embedding: { ok: false, code: "PROVIDER_ERROR", message: "The AI provider returned an unexpected response." } } });
    const res = await put(u, good({ embeddingModelId: "nan-embed" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.details.fields.embeddingModelId).toMatch(/unexpected response/);
    expect(await snapshot()).toBe(before);
  });

  it("provider outages and rate limits become safe errors with no stored changes and no upstream text", async () => {
    const { u, before, snapshot } = await configured();
    t.rag.validateError = new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service is unavailable right now. Please try again shortly.", true, null, 503);
    const down = await put(u, good({ chatModelId: "mock-chat-2" }));
    expect(down.status).toBe(503);
    t.rag.validateError = new RagAgentError("PROVIDER_RATE_LIMITED", "The AI provider is rate limiting requests. Please wait a moment and try again.", true, 12, 429);
    const limited = await put(u, good({ chatModelId: "mock-chat-3" }));
    expect(limited.status).toBe(502);
    const e = (await limited.json()).error;
    expect(e).toMatchObject({ code: "PROVIDER_ERROR", details: { providerCode: "PROVIDER_RATE_LIMITED", retryable: true } });
    expect(e.message).not.toMatch(/Bearer|sk-|<html/i);
    expect(await snapshot()).toBe(before);
  });

  it("is rate limited per user (5 per minute)", async () => {
    const [u, other] = [await createUser(), await createUser()];
    for (let i = 0; i < 5; i++) expect((await put(u, good())).status).toBe(200);
    const res = await put(u, good());
    expect(res.status).toBe(429);
    expect((await put(other, good())).status).toBe(200); // another user is unaffected
  });
});

describe("GET /api/ai/connection and secrecy", () => {
  it("is unconfigured for a new user and requires authentication", async () => {
    const u = await createUser();
    expect(await getConn(u)).toMatchObject({ configured: false, provider: null, apiKey: { configured: false, masked: null, status: null }, chatModelId: null, embeddingModelId: null, documents: { ready: 0, stale: 0, processing: 0 } });
    expect((await client(t).get("/api/ai/connection")).status).toBe(401);
    expect((await client(t).put("/api/ai/connection", good())).status).toBe(401);
  });

  it("never returns the key, ciphertext, iv or tag; never logs or audits them", async () => {
    const u = await createUser();
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a) => void logs.push(a.join(" ")));
    t.rag.validKeys.add(OR_KEY);
    const ok = await put(u, { apiKey: OR_KEY, chatModelId: "m/chat", embeddingModelId: "m/embed" });
    const bad = await put(u, { apiKey: "sk-or-v1-NotAValidKeyAtAll99999999", chatModelId: "m/chat", embeddingModelId: "m/embed" });
    const get = await client(t, u).get("/api/ai/connection");
    const exportRes = await client(t, u).get("/api/account/export");
    const row = await credRow(u, "OPENROUTER");
    const blob = [await ok.text(), await bad.text(), await get.text(), await exportRes.text()].join("\n");
    for (const secret of [OR_KEY, "NotAValidKeyAtAll99999999", row.ciphertext, row.iv, row.authTag]) expect(blob).not.toContain(secret);
    expect(logs.join("\n")).not.toContain("SuperSecretOpenRouterKey");
    const audits = JSON.stringify(await db.auditEvent.findMany({ where: { actorId: u.id } }));
    expect(audits).not.toContain("SuperSecretOpenRouterKey");
    expect(audits).toContain("ai.connection_saved");
  });

  it("isolates users: nobody can read, reuse or overwrite another user's configuration", async () => {
    const [a, b] = [await createUser(), await createUser()];
    expect((await put(a, good())).status).toBe(200);
    expect(await getConn(b)).toMatchObject({ configured: false, apiKey: { configured: false } });
    // B has no saved key of their own: a blank key must NOT pick up A's key
    const res = await put(b, good({ apiKey: "" }));
    expect(res.status).toBe(422);
    expect(t.rag.validateCalls).toHaveLength(1);
    expect(await db.modelPreference.count({ where: { userId: b.id } })).toBe(0);
    expect((await put(b, good({ chatModelId: "b-chat" }))).status).toBe(200);
    expect((await getConn(a)).chatModelId).toBe("mock-chat"); // A untouched
  });

  it("persists across a restart (a brand-new app instance reads the same configuration)", async () => {
    const u = await createUser();
    await put(u, good({ chatModelId: "mock-chat-persist" }));
    const restarted = makeApp();
    expect(await getConn(u, restarted)).toMatchObject({ configured: true, chatModelId: "mock-chat-persist", embeddingModelId: "mock-embed", apiKey: { masked: "••••-key" } });
  });
});

describe("the saved configuration drives the real features", () => {
  it("chat uses the configured chat model id; MCQ/CQ/analysis fall back to it", async () => {
    const u = await createUser();
    await put(u, good({ chatModelId: "my-vendor/chat-model-v1" }));
    const conv = (await (await client(t, u).post("/api/conversations", { mode: "GENERAL" })).json()).conversation.id as string;
    const events = await readSse(await send(u, conv, "hello"));
    expect(events.some((e) => e.event === "final")).toBe(true);
    expect(t.rag.chatCalls.at(-1)?.chat).toMatchObject({ provider: "mock", api_key: KEY, model: "my-vendor/chat-model-v1" });
    const gen = await readSse(await client(t, u).post("/api/generation/mcq", { topic: "Cells", grounding: "GENERAL", count: 1 }));
    expect(gen.some((e) => e.event === "result")).toBe(true);
    expect(t.rag.generateCalls.at(-1)?.body.chat.model).toBe("my-vendor/chat-model-v1");
    expect((await resolveModel(u.id, "CQ"))?.modelId).toBe("my-vendor/chat-model-v1");
    expect((await resolveModel(u.id, "ANALYSIS"))?.modelId).toBe("my-vendor/chat-model-v1");
  });

  it("document embeddings use the configured embedding model and record provider, model and measured dimension", async () => {
    const u = await createUser();
    await put(u, good({ embeddingModelId: "mock-embed" }));
    const res = await client(t, u).raw("POST", "/api/documents", form([{ name: "a.txt", type: "text/plain", data: textFile(`Cells ${randomUUID()}`) }]));
    const id = (await res.json()).results[0].document.id as string;
    t.rag.ingestScript = async (_p, onProgress) => {
      onProgress("embed", 70);
      return { type: "result", status: "READY", page_count: 1, text_length: 10, chunk_count: 1, embedding_model: "mock-embed", embedding_dimension: 1536, code: null, message: null };
    };
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(t.rag.ingestCalls.at(-1)?.params.embedding).toMatchObject({ provider: "mock", api_key: KEY, model: "mock-embed" });
    expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", embeddingProvider: "MOCK", embeddingModel: "mock-embed", embeddingDimension: 1536 });
  });

  it("a result with another vector length fails the document instead of indexing it", async () => {
    const u = await createUser();
    await put(u, good());
    const res = await client(t, u).raw("POST", "/api/documents", form([{ name: "w.docx", type: "", data: DOCX }]));
    const id = (await res.json()).results[0].document.id as string;
    t.rag.ingestScript = async () => ({ type: "result", status: "READY", page_count: 1, text_length: 10, chunk_count: 1, embedding_model: "mock-embed", embedding_dimension: 3072 });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    expect(doc).toMatchObject({ status: "FAILED", statusCode: "EMBEDDING_DIMENSION_MISMATCH" });
    expect(doc.statusDetail).toMatch(/1536/);
  });

  it("an EMBEDDING_DIMENSION_MISMATCH from the AI service becomes clear guidance in chat", async () => {
    const u = await createUser();
    await put(u, good());
    const d = await readyDoc(u);
    t.rag.chatScript = async function* () {
      yield { event: "error", data: { code: "EMBEDDING_DIMENSION_MISMATCH", message: "The selected embedding model does not produce 1536-dimensional vectors.", retryable: false } };
    };
    const conv = await docOnlyConv(u, [d.id]);
    const events = await readSse(await send(u, conv, "What are cells?"));
    expect(events.find((e) => e.event === "error")!.data.message).toMatch(/expects 1536 dimensions/);
  });
});

describe("embedding identity: changing the model never silently reuses old vectors", () => {
  it("documents indexed with another model become stale, are excluded with a clear message, and the save reports it", async () => {
    const u = await createUser();
    await put(u, good());
    const d = await readyDoc(u); // indexed with MOCK / mock-embed, legacy dimension (null ⇒ 1536)
    const conv = await docOnlyConv(u, [d.id]);
    expect((await readSse(await send(u, conv, "What are cells?"))).some((e) => e.event === "final")).toBe(true);
    expect(t.rag.chatCalls.at(-1)).toMatchObject({ embedding: { model: "mock-embed" }, document_ids: [d.id] });

    const changed = await (await put(u, good({ embeddingModelId: "mock-embed-v2" }))).json();
    expect(changed).toMatchObject({ reembedRequired: true, documentsAffected: 1 });
    expect(changed.connection.documents).toEqual({ ready: 1, stale: 1, processing: 0 });
    const docs = (await (await client(t, u).get("/api/documents")).json()).items;
    expect(docs[0]).toMatchObject({ embeddingStale: true, embeddingModel: "mock-embed", embeddingDimension: null });

    const calls = t.rag.chatCalls.length;
    const res = await send(u, conv, "And now?");
    expect(res.status).toBe(409);
    const err = (await res.json()).error;
    expect(err.message).toMatch(/different embedding model/);
    expect(err.message).toMatch(/Re-embed/);
    expect(t.rag.chatCalls.length).toBe(calls); // no search against mismatched vectors
    // MCQ/CQ generation from the same document refuses too (when retrieval is needed)
    const gen = await client(t, u).post("/api/generation/mcq", { documentIds: [d.id], topic: "Cells", grounding: "SOURCE_ONLY", count: 1 });
    expect(gen.status).toBe(422);
    expect((await gen.json()).error.details.fields.documentIds).toMatch(/different embedding model/);
    // general mode skips stale documents with a warning instead of failing
    const g = (await (await client(t, u).post("/api/conversations", { mode: "GENERAL", documentIds: [d.id] })).json()).conversation.id as string;
    const ev = await readSse(await send(u, g, "hi"));
    expect(ev.find((e) => e.event === "message_start")!.data.warnings.join(" ")).toMatch(/different embedding model/);
  });

  it("the same model id from another provider, or another dimension, is a different identity", async () => {
    const u = await createUser();
    await put(u, good());
    const wrongProvider = await readyDoc(u, { embeddingProvider: "OPENROUTER" });
    const wrongDim = await readyDoc(u, { embeddingDimension: 768 });
    const legacy = await readyDoc(u);
    const conn = await getConn(u);
    expect(conn.documents).toEqual({ ready: 3, stale: 2, processing: 0 });
    const stale = (await (await client(t, u).get("/api/documents")).json()).items.filter((x: { embeddingStale: boolean }) => x.embeddingStale).map((x: { id: string }) => x.id);
    expect(stale.sort()).toEqual([wrongProvider.id, wrongDim.id].sort());
    expect(stale).not.toContain(legacy.id);
  });

  it("re-embed queues only the owner's stale documents, once (idempotent), and keeps ids, owner and names", async () => {
    const [u, other] = [await createUser(), await createUser()];
    await put(u, good());
    await put(other, good());
    const stale = await readyDoc(u, { embeddingModel: "old-embed", name: "keep-my-name.txt" });
    const fresh = await readyDoc(u);
    const failed = await readyDoc(u, { status: "FAILED", embeddingModel: null, embeddingProvider: null });
    const foreign = await readyDoc(other, { embeddingModel: "old-embed" });
    const c = client(t, u);
    const first = await (await c.post("/api/documents/reembed", {})).json();
    expect(first).toEqual({ queued: 2, skipped: 0 });
    const docs = await db.document.findMany({ where: { id: { in: [stale.id, fresh.id, failed.id, foreign.id] } } });
    const by = Object.fromEntries(docs.map((d) => [d.id, d]));
    expect([by[stale.id]!.status, by[failed.id]!.status, by[fresh.id]!.status, by[foreign.id]!.status]).toEqual(["QUEUED", "QUEUED", "READY", "READY"]);
    expect(by[stale.id]).toMatchObject({ ownerId: u.id, name: "keep-my-name.txt" });
    const again = await (await c.post("/api/documents/reembed", {})).json();
    expect(again).toEqual({ queued: 0, skipped: 0 });
    expect(await db.job.count({ where: { type: "ingest", status: "PENDING", dedupeKey: { in: [`ingest:${stale.id}`, `ingest:${failed.id}`] } } })).toBe(2);
    expect(await db.job.count({ where: { dedupeKey: `ingest:${foreign.id}` } })).toBe(0);

    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(await getConn(u)).toMatchObject({ documents: { ready: 3, stale: 0, processing: 0 } });
    expect(await db.document.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: "READY", embeddingModel: "mock-embed", embeddingProvider: "MOCK", processingVersion: 2 });
  });

  it("re-embed needs a configured embedding model, authentication and is rate limited", async () => {
    const u = await createUser();
    expect((await client(t, u).post("/api/documents/reembed", {})).status).toBe(422);
    expect((await client(t).post("/api/documents/reembed", {})).status).toBe(401);
    await put(u, good());
    for (let i = 0; i < 4; i++) expect((await client(t, u).post("/api/documents/reembed", {})).status).toBe(200); // (the 422 above counted too)
    expect((await client(t, u).post("/api/documents/reembed", {})).status).toBe(429);
  });

  it("the previous chunks and version stay until a re-embed succeeds; after it, queries use the new identity", async () => {
    const u = await createUser();
    await put(u, good());
    const d = await readyDoc(u, { embeddingModel: "old-embed" });
    await insertChunk(d.id, u.id, "old-embed", 1);
    await client(t, u).post("/api/documents/reembed", {});

    // failed attempt: nothing is replaced (the swap is rag_agent's atomic version switch; the backend never deletes chunks)
    t.rag.ingestScript = async () => ({ type: "result", status: "FAILED", code: "NO_TEXT", message: "No text could be extracted." });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(await db.documentChunk.count({ where: { documentId: d.id, processingVersion: 1 } })).toBe(1);
    expect(await db.document.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ processingVersion: 1, embeddingModel: "old-embed" });

    // retry succeeds: the new version is recorded with the new identity; the ingest call carried the CONFIGURED embedding model and the next version number
    await client(t, u).post("/api/documents/reembed", {});
    t.rag.ingestScript = async () => ({ type: "result", status: "READY", page_count: 1, text_length: 10, chunk_count: 1, embedding_model: "mock-embed", embedding_dimension: 1536 });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(t.rag.ingestCalls.at(-1)?.params).toMatchObject({ document_id: d.id, owner_id: u.id, processing_version: 2, embedding: { provider: "mock", model: "mock-embed" } });
    expect(await db.document.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "READY", processingVersion: 2, embeddingModel: "mock-embed", embeddingDimension: 1536 });

    // chat now searches it, embedding the query with the very same configuration
    const conv = await docOnlyConv(u, [d.id]);
    expect((await readSse(await send(u, conv, "What are cells?"))).some((e) => e.event === "final")).toBe(true);
    expect(t.rag.chatCalls.at(-1)).toMatchObject({ embedding: { provider: "mock", model: "mock-embed" }, document_ids: [d.id] });
  });
});

describe("providers and the mock provider", () => {
  it("derives the provider from the key shape; mock only when explicitly enabled", () => {
    expect(deriveProvider("sk-or-v1-abc", false)).toBe("OPENROUTER");
    expect(deriveProvider("gsk_abc", false)).toBe("GROQ");
    expect(deriveProvider("sk-proj-abc", false)).toBe("OPENAI");
    expect(deriveProvider("anything-else-123", false)).toBe("OPENROUTER");
    expect(deriveProvider("mock-valid-key", true)).toBe("MOCK");
    // production (mock disabled): a mock-looking key is just an OpenRouter key that the provider will reject — never the mock provider
    expect(deriveProvider("mock-valid-key", false)).toBe("OPENROUTER");
  });

  it("production never derives or enables the mock provider", async () => {
    const { parseEnv } = await import("../../src/config/env.js");
    const base = { NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@h/db", APP_URL: "https://app.example.com", BETTER_AUTH_SECRET: "x".repeat(40), CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"), RAG_AGENT_TOKEN: "t".repeat(30) };
    expect(() => parseEnv({ ...base, ALLOW_MOCK_PROVIDER: "true" })).toThrow(/ALLOW_MOCK_PROVIDER/);
    expect(parseEnv(base).ALLOW_MOCK_PROVIDER).toBe(false);
    const prev = process.env.ALLOW_MOCK_PROVIDER;
    delete process.env.ALLOW_MOCK_PROVIDER;
    const { resetEnvCache } = await import("../../src/config/env.js");
    resetEnvCache();
    try {
      expect(deriveProvider("mock-valid-key")).toBe("OPENROUTER"); // default argument reads the environment: mock disabled
    } finally {
      if (prev !== undefined) process.env.ALLOW_MOCK_PROVIDER = prev;
      resetEnvCache();
    }
  });
});
