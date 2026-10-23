import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RagAgentError, type ReindexParams, type ReindexResult } from "../../src/clients/rag-agent.js";
import { db, getDb } from "../../src/lib/db.js";
import { finalizeReindex, reindexHandlers } from "../../src/modules/ai/reindex.js";
import { ingestHandlers } from "../../src/modules/jobs/ingest.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { client, makeApp, readSse, type TestApp } from "../helpers/http.js";
import { defaultReindex } from "../helpers/fake-rag.js";
import { createUser, type TestUser } from "../helpers/users.js";
import { withEnv } from "../helpers/with-env.js";

/**
 * docs/EMBEDDING_SETTINGS_SPEC.md: a configurable embedding model + dimension, verified before activation, and a staged re-index that
 * keeps the old index serving until the new one is complete and verified.
 */
let t: TestApp;
beforeEach(async () => {
  t = makeApp();
  // the job table is shared by the whole run: drop work left over by earlier tests so only this test's jobs are processed
  await db.job.deleteMany({ where: { type: { in: ["reindex-document", "reindex-finalize", "ingest"] }, status: { in: ["PENDING", "RUNNING"] } } });
});
afterEach(() => vi.restoreAllMocks());

const KEY = "mock-valid-key";
const good = (over: Record<string, unknown> = {}) => ({ apiKey: KEY, chatModelId: "mock-chat", embeddingModelId: "mock-embed", ...over });
const put = (u: TestUser, body: unknown) => client(t, u).put("/api/ai/connection", body);
const test = (u: TestUser, body: unknown) => client(t, u).post("/api/ai/connection/test", body);
const getConn = async (u: TestUser) => (await (await client(t, u).get("/api/ai/connection")).json()).connection;
const prefRow = (u: TestUser, task: "EMBEDDING" | "DEFAULT" = "EMBEDDING") => db.modelPreference.findUnique({ where: { userId_task: { userId: u.id, task } } });
const snapshot = async (u: TestUser) =>
  JSON.stringify([await db.providerCredential.findMany({ where: { userId: u.id } }), await db.modelPreference.findMany({ where: { userId: u.id }, orderBy: { task: "asc" } }), await db.embeddingReindex.count({ where: { userId: u.id } })]);

// ---- fixtures ------------------------------------------------------------------------------------------------------------------
const oneHot = (dim: number) => `[${Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;

/** A READY document with real vectors, indexed under MOCK / mock-embed / 1536 (the identity `put(u, good())` activates). */
async function seedDoc(u: TestUser, chunks = 2, over: Record<string, unknown> = {}) {
  const doc = await db.document.create({
    data: { ownerId: u.id, name: `notes-${randomUUID().slice(0, 6)}.txt`, extension: "txt", mimeType: "text/plain", sizeBytes: 10, sha256: randomUUID(), storageKey: `u/${u.id}/${randomUUID()}`, status: "READY", embeddingProvider: "MOCK", embeddingModel: "mock-embed", embeddingDimension: 1536, processingVersion: 1, chunkCount: chunks, ...over },
  });
  const vec = oneHot(1536);
  for (let i = 0; i < chunks; i++) {
    await db.$executeRaw`INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding")
      VALUES (${randomUUID()}, ${doc.id}, ${u.id}, ${i}, 1, ${`chunk ${i} of ${doc.name}`}, 3, 'mock', 'mock-embed', ${vec}::vector)`;
  }
  return doc;
}
const chunkSets = async (docId: string) =>
  (await db.$queryRaw<{ model: string; dim: number | null; n: bigint }[]>`
    SELECT "embeddingModel" AS model, "embeddingDimension" AS dim, count(*) AS n FROM "DocumentChunk" WHERE "documentId" = ${docId} GROUP BY 1, 2 ORDER BY 1, 2`).map((r) => `${r.model}/${r.dim}x${Number(r.n)}`);

const handlers = () => ({ ...ingestHandlers(t.rag, t.storage), ...reindexHandlers(t.rag) });
/** Runs queued jobs now (the finalize poller normally waits seconds between rounds). Stops once nothing is left to run. */
async function pump(rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    await db.job.updateMany({ where: { type: { in: ["reindex-document", "reindex-finalize"] }, status: "PENDING" }, data: { runAt: new Date() } });
    if ((await runDueJobs(handlers())) === 0) break;
  }
}
const docOnlyConv = async (u: TestUser, documentIds: string[]) => (await (await client(t, u).post("/api/conversations", { mode: "DOCUMENT_ONLY", documentIds })).json()).conversation.id as string;
const send = (u: TestUser, id: string, content: string) => client(t, u).post(`/api/conversations/${id}/messages`, { content });
const latestReindex = (u: TestUser) => db.embeddingReindex.findFirst({ where: { userId: u.id }, orderBy: { createdAt: "desc" } });

// =====================================================================================================================================
describe("the dimension field: verified before anything is activated", () => {
  it("an explicit size the provider really produces is saved together with the request parameter that gets it", async () => {
    const u = await createUser();
    const res = await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.dimension).toMatchObject({ ok: true, dimension: 512, native_dimension: 1024, request_dimensions: 512 });
    expect(body.embeddingChange).toEqual({ status: "activated", documents: 0 });
    expect(body.connection).toMatchObject({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512, embeddingRequestDimensions: 512 });
    expect(t.rag.validateCalls[0]).toMatchObject({ embedding_model: "flex-embed-1024", embedding_dimension: 512 });
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024", embeddingDimension: 512, embeddingRequestDimensions: 512 });
  });

  it("Automatic saves the model's own (measured) size and sends no dimensions parameter", async () => {
    const u = await createUser();
    const res = await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: null }));
    expect(res.status).toBe(200);
    expect(t.rag.validateCalls[0]).not.toHaveProperty("embedding_dimension");
    expect(await prefRow(u)).toMatchObject({ embeddingDimension: 1024, embeddingRequestDimensions: null });
  });

  it("a model whose size is not 1536 is perfectly valid (no hidden 1536 assumption), including 3072 and 768", async () => {
    for (const [model, n] of [["wide-embed-big", 3072], ["small-embed-768", 768]] as const) {
      const u = await createUser();
      expect((await put(u, good({ embeddingModelId: model }))).status).toBe(200);
      expect(await prefRow(u)).toMatchObject({ embeddingDimension: n, embeddingRequestDimensions: null });
    }
  });

  it("a model that ignores the size we ask for is refused with the numbers that were measured, and nothing is saved", async () => {
    const u = await createUser();
    const before = await snapshot(u);
    const res = await put(u, good({ embeddingModelId: "plain-embed-1024", embeddingDimension: 512 }));
    expect(res.status).toBe(422);
    const err = (await res.json()).error;
    expect(err.details.checks.dimension).toMatchObject({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", dimension: 1024, native_dimension: 1024 });
    expect(err.details.fields.embeddingDimension).toMatch(/returned 1024-dimensional vectors when asked for 512/);
    expect(err.details.fields.embeddingDimension).toMatch(/never padded or truncated/);
    expect(err.details.fields.embeddingDimension).toMatch(/own size is 1024/);
    expect(await snapshot(u)).toBe(before);
  });

  it("a provider that rejects the size parameter is reported as such; asking for MORE than the model has is refused too", async () => {
    const u = await createUser();
    const rejected = (await (await put(u, good({ embeddingModelId: "strict-embed-1024", embeddingDimension: 512 }))).json()).error;
    expect(rejected.details.checks.dimension).toMatchObject({ ok: false, code: "EMBEDDING_DIMENSION_UNSUPPORTED", native_dimension: 1024 });
    expect(rejected.details.fields.embeddingDimension).toMatch(/doesn't let this model return 512-dimensional vectors/);
    const bigger = (await (await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 2048 }))).json()).error;
    expect(bigger.details.checks.dimension).toMatchObject({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH" });
    expect(await prefRow(u)).toBeNull();
  });

  it.each([[0], [7], [4097], [-1], [12.5], ["256"], [true]])("invalid size %j is rejected before any provider request is made", async (bad) => {
    const u = await createUser();
    const res = await put(u, good({ embeddingDimension: bad }));
    expect(res.status).toBe(422);
    const err = (await res.json()).error;
    expect(err.code).toBe("VALIDATION");
    expect(err.details.fields.embeddingDimension).toBeTruthy();
    expect(t.rag.validateCalls).toHaveLength(0);
    expect((await test(u, good({ embeddingDimension: bad }))).status).toBe(422);
    expect(t.rag.validateCalls).toHaveLength(0);
    expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
  });

  it("the limits are inclusive: 8 and 4096 are accepted by the schema (and still verified with the provider)", async () => {
    const u = await createUser();
    for (const n of [8, 4096]) {
      const out = await (await test(u, good({ embeddingModelId: "plain-embed-1024", embeddingDimension: n }))).json();
      expect(out.requestedDimension).toBe(n); // it passed validation and reached the provider check
    }
  });

  it("a failed model request is attributed to the model, not to the size", async () => {
    const u = await createUser();
    const err = (await (await put(u, good({ embeddingModelId: "bad-embed-1", embeddingDimension: 512 }))).json()).error;
    expect(err.details.fields).toEqual({ embeddingModelId: expect.stringMatching(/not found/) });
    expect(err.details.checks).toMatchObject({ embedding: { ok: false, code: "MODEL_NOT_FOUND" }, dimension: { skipped: true }, database: { skipped: true } });
    expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
  });

  it("an unreachable AI service changes nothing", async () => {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    const before = await snapshot(u);
    t.rag.validateError = new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service is unavailable right now. Please try again shortly.", true, null, 503);
    expect((await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }))).status).toBe(503);
    expect(await snapshot(u)).toBe(before);
  });

  it("a settings update that fails half-way rolls back the credential, the chat model AND the embedding model together", async () => {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    const before = await snapshot(u);
    const real = getDb().$transaction.bind(getDb()) as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    vi.spyOn(getDb(), "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>) =>
      real(async (tx) => {
        await fn(tx); // every write happens …
        throw new Error("simulated failure before commit"); // … and then the transaction dies
      })) as never);
    const res = await put(u, good({ chatModelId: "other-chat", embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await snapshot(u)).toBe(before);
    expect((await prefRow(u))?.modelId).toBe("mock-embed");
    expect((await prefRow(u, "DEFAULT"))?.modelId).toBe("mock-chat");
    // and the very next attempt works normally
    expect((await put(u, good({ chatModelId: "other-chat", embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }))).status).toBe(200);
  });

  it("the test endpoint reports the same numbers and writes nothing", async () => {
    const u = await createUser();
    const out = await (await test(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 256 }))).json();
    expect(out).toMatchObject({ ok: true, measuredDimension: 256, nativeDimension: 1024, requestedDimension: 256, dimensionSource: "request" });
    expect(out.checks.dimension).toMatchObject({ ok: true, dimension: 256, native_dimension: 1024, request_dimensions: 256 });
    expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
  });
});

// =====================================================================================================================================
describe("database settings override environment defaults", () => {
  it("the deployment default seeds a blank field, is verified like a typed value, and is then frozen in the database", async () => {
    await withEnv({ EMBEDDING_DIMENSIONS: "512" }, async () => {
      const u = await createUser();
      expect((await getConn(u)).defaultEmbeddingDimension).toBe(512);
      const tested = await (await test(u, good({ embeddingModelId: "flex-embed-1024" }))).json();
      expect(tested).toMatchObject({ requestedDimension: 512, dimensionSource: "environment", measuredDimension: 512 });
      expect((await put(u, good({ embeddingModelId: "flex-embed-1024" }))).status).toBe(200);
      expect(t.rag.validateCalls.at(-1)).toMatchObject({ embedding_dimension: 512 });
      expect(await prefRow(u)).toMatchObject({ embeddingDimension: 512, embeddingRequestDimensions: 512 });

      // the operator changes the default; the saved configuration neither changes nor is re-indexed
      await withEnv({ EMBEDDING_DIMENSIONS: "256" }, async () => {
        const again = await (await test(u, good({ embeddingModelId: "flex-embed-1024" }))).json();
        expect(again).toMatchObject({ requestedDimension: 512, dimensionSource: "database" });
        expect((await put(u, good({ embeddingModelId: "flex-embed-1024" }))).status).toBe(200);
        expect(await prefRow(u)).toMatchObject({ embeddingDimension: 512 });
        expect(await db.embeddingReindex.count({ where: { userId: u.id } })).toBe(0);
        // …but an explicit value always wins, and Automatic goes back to the (new) deployment default
        expect((await (await test(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 128 }))).json()).dimensionSource).toBe("request");
        expect(await (await test(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: null }))).json()).toMatchObject({ requestedDimension: 256, dimensionSource: "environment" });
      });
    });
  });

  it("a saved size belongs to its model: another model does not inherit it", async () => {
    await withEnv({ EMBEDDING_DIMENSIONS: "256" }, async () => {
      const u = await createUser();
      expect((await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }))).status).toBe(200);
      const other = await (await test(u, good({ embeddingModelId: "flex-embed-2048" }))).json();
      expect(other).toMatchObject({ requestedDimension: 256, dimensionSource: "environment" });
    });
  });

  it("a deployment default the model cannot produce fails with a message that names it and the model's own size", async () => {
    await withEnv({ EMBEDDING_DIMENSIONS: "2048" }, async () => {
      const u = await createUser();
      const err = (await (await put(u, good({ embeddingModelId: "plain-embed-1024" }))).json()).error;
      expect(err.details.fields.embeddingDimension).toMatch(/default size for this installation \(2048\)/);
      expect(err.details.fields.embeddingDimension).toMatch(/Enter 1024/);
      // typing the model's own size is the way out
      expect((await put(u, good({ embeddingModelId: "plain-embed-1024", embeddingDimension: 1024 }))).status).toBe(200);
    });
  });

  it("without a default and without a saved value, the native size is used", async () => {
    const u = await createUser();
    expect((await getConn(u)).defaultEmbeddingDimension).toBeNull();
    expect(await (await test(u, good({ embeddingModelId: "small-embed-768" }))).json()).toMatchObject({ requestedDimension: null, dimensionSource: "model", measuredDimension: 768 });
  });
});

// =====================================================================================================================================
describe("changing the embedding model or size: the old index keeps serving until the new one is verified", () => {
  async function setup(docs = 2) {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    const ds = [];
    for (let i = 0; i < docs; i++) ds.push(await seedDoc(u, 3));
    return { u, ds };
  }
  const change = (u: TestUser, over: Record<string, unknown> = {}) => put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512, ...over }));

  it("stages the new index; the saved embedding configuration and every document stay exactly as they were", async () => {
    const { u, ds } = await setup();
    const res = await change(u);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.embeddingChange).toEqual({ status: "reindexing", documents: 2 });
    expect(body.connection).toMatchObject({
      embeddingModelId: "mock-embed", embeddingDimension: 1536, embeddingRequestDimensions: null, configured: true,
      reindex: { status: "BUILDING", modelId: "flex-embed-1024", dimension: 512, progress: { total: 2, done: 0 }, errorCode: null },
    });
    expect(body.connection.documents).toEqual({ ready: 2, stale: 0, processing: 0 });
    expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 });
    for (const d of ds) expect(await chunkSets(d.id)).toEqual(["mock-embed/1536x3"]);
    expect(await db.job.count({ where: { type: "reindex-document", status: "PENDING", payload: { path: ["reindexId"], equals: body.connection.reindex.id } } })).toBe(2);
  });

  it("while it is being built, chat and retrieval still use the OLD embedding model against the OLD vectors", async () => {
    const { u, ds } = await setup(1);
    await change(u);
    const conv = await docOnlyConv(u, [ds[0]!.id]);
    expect((await readSse(await send(u, conv, "What is in my notes?"))).some((e) => e.event === "final")).toBe(true);
    expect(t.rag.chatCalls.at(-1)).toMatchObject({ document_ids: [ds[0]!.id], embedding: { provider: "mock", model: "mock-embed", dimension: 1536 } });
    expect(t.rag.chatCalls.at(-1)!.embedding).not.toHaveProperty("request_dimensions");
  });

  it("builds a second chunk set beside the first (never touching it), then switches everything in one step", async () => {
    const { u, ds } = await setup();
    await change(u);
    const key = (await getConn(u)).reindex.id as string;
    // run the per-document jobs only: park the finalize job so the half-way state can be inspected
    await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date(Date.now() + 3_600_000) } });
    await runDueJobs(handlers());
    expect(t.rag.reindexCalls).toHaveLength(2);
    for (const d of ds) expect(await chunkSets(d.id)).toEqual(["flex-embed-1024/512x3", "mock-embed/1536x3"]); // both sets exist now
    expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 }); // …and nothing was switched
    expect((await getConn(u)).reindex).toMatchObject({ id: key, status: "BUILDING", progress: { total: 2, done: 2 } });
    // the old index is still the one that answers
    const conv = await docOnlyConv(u, [ds[0]!.id]);
    await readSse(await send(u, conv, "still old?"));
    expect(t.rag.chatCalls.at(-1)!.embedding).toMatchObject({ model: "mock-embed", dimension: 1536 });

    await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date() } });
    await pump();
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024", embeddingDimension: 512, embeddingRequestDimensions: 512 });
    for (const d of ds) {
      expect(await chunkSets(d.id)).toEqual(["flex-embed-1024/512x3"]); // the old set is gone only now
      expect(await db.document.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: "READY", embeddingProvider: "MOCK", embeddingModel: "flex-embed-1024", embeddingDimension: 512 });
    }
    expect(await latestReindex(u)).toMatchObject({ status: "ACTIVATED", errorCode: null });
    const conn = await getConn(u);
    expect(conn).toMatchObject({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512, embeddingRequestDimensions: 512, reindex: null });
    expect(conn.documents).toEqual({ ready: 2, stale: 0, processing: 0 });
    // what rag_agent was asked to do: same key, old identity as the source, new identity as the target
    expect(t.rag.reindexCalls[0]).toMatchObject({ source: { provider: "mock", model: "mock-embed", dimension: 1536 }, target: { provider: "mock", api_key: KEY, model: "flex-embed-1024", dimension: 512, request_dimensions: 512 } });
    // and from now on queries use the NEW model, size and request parameter
    const conv2 = await docOnlyConv(u, [ds[0]!.id]);
    expect((await readSse(await send(u, conv2, "new index?"))).some((e) => e.event === "final")).toBe(true);
    expect(t.rag.chatCalls.at(-1)!.embedding).toMatchObject({ provider: "mock", model: "flex-embed-1024", dimension: 512, request_dimensions: 512 });
  });

  it("is audited without any secret", async () => {
    const { u } = await setup(1);
    await change(u);
    await pump();
    const actions = (await db.auditEvent.findMany({ where: { actorId: u.id }, orderBy: { createdAt: "asc" } })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["ai.connection_saved", "ai.embedding_reindex_started", "ai.embedding_reindex_activated"]));
    expect(JSON.stringify(await db.auditEvent.findMany({ where: { actorId: u.id } }))).not.toContain(KEY);
  });

  it("with nothing indexed, a different model is activated at once (nothing to re-embed)", async () => {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    const body = await (await change(u)).json();
    expect(body.embeddingChange).toEqual({ status: "activated", documents: 0 });
    expect(body.connection.reindex).toBeNull();
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024", embeddingDimension: 512 });
  });

  it("saving the already-active identity again changes nothing and starts no work", async () => {
    const { u } = await setup(1);
    const body = await (await put(u, good({ chatModelId: "another-chat" }))).json();
    expect(body.embeddingChange.status).toBe("unchanged");
    expect(body.connection.reindex).toBeNull();
    expect(t.rag.reindexCalls).toHaveLength(0);
  });

  it("saving the same pending target twice does not restart the build; switching target replaces it; going back to the active one cancels it", async () => {
    const { u } = await setup(1);
    const first = (await (await change(u)).json()).connection.reindex.id as string;
    const again = (await (await change(u)).json()).connection.reindex.id as string;
    expect(again).toBe(first);
    const other = (await (await change(u, { embeddingModelId: "flex-embed-2048", embeddingDimension: 256 })).json()).connection.reindex;
    expect(other).toMatchObject({ modelId: "flex-embed-2048", dimension: 256 });
    expect(other.id).not.toBe(first);
    expect((await db.embeddingReindex.findUniqueOrThrow({ where: { id: first } })).status).toBe("CANCELLED");
    const back = await (await put(u, good())).json();
    expect(back.embeddingChange.status).toBe("unchanged");
    expect(back.connection.reindex).toBeNull();
    expect((await latestReindex(u))?.status).toBe("CANCELLED");
    expect(await db.documentChunk.count({ where: { ownerId: u.id, embeddingModel: { not: "mock-embed" } } })).toBe(0);
  });

  it("cancelling discards the staged chunks and leaves the active index untouched; late jobs do nothing", async () => {
    const { u, ds } = await setup();
    await change(u);
    await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date(Date.now() + 3_600_000) } });
    await runDueJobs(handlers()); // staged sets now exist
    expect(await chunkSets(ds[0]!.id)).toHaveLength(2);
    const res = await client(t, u).post("/api/ai/embedding-reindex/cancel");
    expect(res.status).toBe(200);
    expect((await res.json()).connection.reindex).toBeNull();
    for (const d of ds) expect(await chunkSets(d.id)).toEqual(["mock-embed/1536x3"]);
    expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 });
    const calls = t.rag.reindexCalls.length;
    await pump();
    expect(t.rag.reindexCalls).toHaveLength(calls); // nothing resumed
    expect((await client(t, u).post("/api/ai/embedding-reindex/cancel")).status).toBe(200); // idempotent
  });

  it("a provider failure ends the build safely: staged chunks removed, old index untouched, a clear message, and retry works", async () => {
    const { u, ds } = await setup();
    await change(u);
    let n = 0;
    t.rag.reindexScript = async (p) => {
      if (++n === 2) throw new RagAgentError("MODEL_NOT_FOUND", "The selected model was not found or is not available for this key.", false, null, 404);
      return defaultReindex(p); // the first document succeeds, the second fails
    };
    await pump();
    const row = await latestReindex(u);
    expect(row).toMatchObject({ status: "FAILED", errorCode: "MODEL_NOT_FOUND" });
    expect(row?.errorMessage).toMatch(/new embedding model wasn't found/);
    for (const d of ds) expect(await chunkSets(d.id)).toEqual(["mock-embed/1536x3"]); // even the successful document's staged set is gone
    expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 });
    const conn = await getConn(u);
    expect(conn.reindex).toMatchObject({ status: "FAILED", errorCode: "MODEL_NOT_FOUND" });
    expect(conn.documents).toEqual({ ready: 2, stale: 0, processing: 0 });
    // the old index still answers
    const conv = await docOnlyConv(u, [ds[0]!.id]);
    expect((await readSse(await send(u, conv, "ok?"))).some((e) => e.event === "final")).toBe(true);

    t.rag.reindexScript = defaultReindex; // the problem is fixed → retry
    const retry = await client(t, u).post("/api/ai/embedding-reindex/retry");
    expect(retry.status).toBe(200);
    expect((await retry.json()).connection.reindex).toMatchObject({ status: "BUILDING", modelId: "flex-embed-1024", dimension: 512 });
    await pump();
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024", embeddingDimension: 512 });
  });

  it("retryable provider errors are retried, then give up with a message (the active index stays)", async () => {
    const { u } = await setup(1);
    await change(u);
    t.rag.reindexScript = async () => {
      throw new RagAgentError("PROVIDER_RATE_LIMITED", "The AI provider is rate limiting requests.", true, 1, 429);
    };
    await pump(40);
    expect(t.rag.reindexCalls.length).toBeGreaterThan(1); // retried
    expect(await latestReindex(u)).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_RATE_LIMITED" });
    expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed" });
  });

  it("a busy or restarting AI service only delays the build: it is not a failure and does not use up the attempts", async () => {
    const { u } = await setup(1);
    await change(u);
    let calls = 0;
    t.rag.reindexScript = async (p) => {
      if (++calls <= 7) throw new RagAgentError(calls % 2 ? "BUSY" : "UPSTREAM_UNAVAILABLE", "The service is busy.", true, 5, 503); // more than the 4 attempts a job has
      return defaultReindex(p);
    };
    await pump(60);
    expect(calls).toBe(8);
    expect(await latestReindex(u)).toMatchObject({ status: "ACTIVATED" });
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024", embeddingDimension: 512 });
  });

  it("an authentication failure marks the key invalid and fails the build", async () => {
    const { u } = await setup(1);
    await change(u);
    t.rag.reindexScript = async () => {
      throw new RagAgentError("PROVIDER_AUTH_INVALID", "The AI provider rejected the API key.", false, null, 401);
    };
    await pump();
    expect(await latestReindex(u)).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_AUTH_INVALID" });
    expect((await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("INVALID");
  });

  it("a result of the wrong size is never activated: claimed dimension, wrong-length vectors, or too few chunks", async () => {
    // 1. the service itself reports another length
    {
      const { u, ds } = await setup(1);
      await change(u);
      t.rag.reindexScript = async (p) => ({ ...(await defaultReindex(p)), embedding_dimension: 768 }) as ReindexResult;
      await pump();
      expect(await latestReindex(u)).toMatchObject({ status: "FAILED", errorCode: "EMBEDDING_DIMENSION_MISMATCH" });
      expect(await chunkSets(ds[0]!.id)).toEqual(["mock-embed/1536x3"]);
      expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed" });
    }
    // 2. it claims success but wrote vectors of another length (the database knows the real length)
    {
      const { u, ds } = await setup(1);
      await change(u);
      t.rag.reindexScript = async (p: ReindexParams) => {
        await db.$executeRaw`INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding")
          SELECT gen_random_uuid()::text, "documentId", "ownerId", "chunkIndex", "processingVersion", "content", "tokenCount", ${p.target.provider}, ${p.target.model}, '[1,2,3]'::vector
          FROM "DocumentChunk" WHERE "documentId" = ${p.document_id} AND "embeddingModel" = ${p.source.model}`;
        return { type: "result", status: "READY", chunk_count: 3, embedding_dimension: p.target.dimension };
      };
      await pump();
      expect(await latestReindex(u)).toMatchObject({ status: "FAILED", errorCode: "VERIFICATION_FAILED" });
      expect(await chunkSets(ds[0]!.id)).toEqual(["mock-embed/1536x3"]); // the bogus 3-d rows were purged too
      expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 });
    }
    // 3. it claims success but wrote fewer chunks than the document has
    {
      const { u, ds } = await setup(1);
      await change(u);
      t.rag.reindexScript = async (p) => {
        const r = await defaultReindex(p);
        await db.$executeRaw`DELETE FROM "DocumentChunk" WHERE "id" = (SELECT "id" FROM "DocumentChunk" WHERE "documentId" = ${p.document_id} AND "embeddingModel" = ${p.target.model} LIMIT 1)`;
        return r;
      };
      await pump();
      expect(await latestReindex(u)).toMatchObject({ status: "FAILED", errorCode: "VERIFICATION_FAILED" });
      expect(await chunkSets(ds[0]!.id)).toEqual(["mock-embed/1536x3"]);
      expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed" });
    }
  });

  it("source text that is gone fails clearly instead of looping", async () => {
    const { u } = await setup(1);
    await change(u);
    t.rag.reindexScript = async () => ({ type: "result", status: "STALE", chunk_count: 0, embedding_dimension: null });
    await pump();
    expect(await latestReindex(u)).toMatchObject({ status: "FAILED", errorCode: "SOURCE_MISSING" });
    expect(t.rag.reindexCalls).toHaveLength(1);
  });

  it("documents that appear or change during the build are picked up before the switch", async () => {
    const { u, ds } = await setup(1);
    await change(u);
    const late = await seedDoc(u, 2); // uploaded and processed (old identity) while the build runs
    await pump();
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024", embeddingDimension: 512 });
    for (const d of [ds[0]!, late]) {
      expect(await chunkSets(d.id)).toEqual([`flex-embed-1024/512x${d === late ? 2 : 3}`]);
      expect((await db.document.findUniqueOrThrow({ where: { id: d.id } })).embeddingModel).toBe("flex-embed-1024");
    }
    expect(new Set(t.rag.reindexCalls.map((c) => c.document_id))).toEqual(new Set([ds[0]!.id, late.id]));
  });

  it("is not switched while a document is still being processed; it waits and then completes", async () => {
    const { u, ds } = await setup(1);
    await change(u);
    const busy = await seedDoc(u, 1, { status: "PROCESSING" });
    await pump(6);
    expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 }); // not switched
    expect((await latestReindex(u))?.status).toBe("BUILDING");
    expect(await chunkSets(ds[0]!.id)).toEqual(["flex-embed-1024/512x3", "mock-embed/1536x3"]);
    await db.document.update({ where: { id: busy.id }, data: { status: "READY" } });
    await pump();
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024" });
    expect(await chunkSets(busy.id)).toEqual(["flex-embed-1024/512x1"]);
  });

  it("a document re-processed during the build (new version) invalidates its staged set instead of being mixed", async () => {
    const { u, ds } = await setup(1);
    await change(u);
    await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date(Date.now() + 3_600_000) } });
    await runDueJobs(handlers()); // staged set built for version 1
    // the document is re-ingested: version 2, new active chunks, version-1 chunks (both sets) dropped
    await db.documentChunk.deleteMany({ where: { documentId: ds[0]!.id } });
    await db.document.update({ where: { id: ds[0]!.id }, data: { processingVersion: 2 } });
    const vec = oneHot(1536);
    await db.$executeRaw`INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding")
      VALUES (${randomUUID()}, ${ds[0]!.id}, ${u.id}, 0, 2, 'new text', 2, 'mock', 'mock-embed', ${vec}::vector)`;
    await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date() } });
    await pump();
    expect(await chunkSets(ds[0]!.id)).toEqual(["flex-embed-1024/512x1"]);
    expect(t.rag.reindexCalls.map((c) => c.processing_version)).toEqual([1, 2]);
  });

  it("two finalizers racing activate exactly once", async () => {
    const { u } = await setup(1);
    await change(u);
    await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date(Date.now() + 3_600_000) } });
    await runDueJobs(handlers());
    const id = (await latestReindex(u))!.id;
    await Promise.all([finalizeReindex(id, { attempts: 1, maxAttempts: 5 }), finalizeReindex(id, { attempts: 1, maxAttempts: 5 })]);
    expect(await db.auditEvent.count({ where: { actorId: u.id, action: "ai.embedding_reindex_activated" } })).toBe(1);
    expect(await prefRow(u)).toMatchObject({ modelId: "flex-embed-1024" });
  });

  it("a build whose documents never settle ends with a clear timeout instead of hanging", async () => {
    const { u } = await setup(1);
    await change(u);
    await seedDoc(u, 1, { status: "QUEUED" });
    const id = (await latestReindex(u))!.id;
    await db.job.updateMany({ where: { type: "reindex-document" }, data: { status: "SUCCEEDED", dedupeKey: null } }); // no work left, only the stuck document
    await finalizeReindex(id, { attempts: 1, maxAttempts: 1 }).catch(() => undefined);
    expect(await latestReindex(u)).toMatchObject({ status: "FAILED", errorCode: expect.stringMatching(/BUILD_TIMEOUT|VERIFICATION_FAILED/) });
  });

  it("is isolated per user: nobody can see, cancel or retry another user's build, and other users' index is never touched", async () => {
    const { u, ds } = await setup(1);
    const { u: other, ds: otherDocs } = await setup(1);
    await change(u);
    expect((await getConn(other)).reindex).toBeNull();
    expect((await client(t, other).post("/api/ai/embedding-reindex/cancel")).status).toBe(200); // a no-op for them
    expect((await getConn(u)).reindex?.status).toBe("BUILDING");
    expect((await client(t, other).post("/api/ai/embedding-reindex/retry")).status).toBe(409);
    await pump();
    expect(await chunkSets(otherDocs[0]!.id)).toEqual(["mock-embed/1536x3"]);
    expect(await prefRow(other)).toMatchObject({ modelId: "mock-embed" });
    expect(await chunkSets(ds[0]!.id)).toEqual(["flex-embed-1024/512x3"]);
    expect((await client(t).post("/api/ai/embedding-reindex/cancel")).status).toBe(401);
    expect((await client(t).post("/api/ai/embedding-reindex/retry")).status).toBe(401);
  });

  it("two saves racing for the same user produce one build and a clean conflict, never a server error", async () => {
    const { u } = await setup(1);
    const results = await Promise.all([change(u), change(u, { embeddingModelId: "flex-embed-2048", embeddingDimension: 256 })]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    expect(statuses).toContain(200);
    expect(await db.embeddingReindex.count({ where: { userId: u.id, status: "BUILDING" } })).toBe(1);
  });

  it("retry is only valid after a failure", async () => {
    const { u } = await setup(1);
    await change(u);
    expect((await client(t, u).post("/api/ai/embedding-reindex/retry")).status).toBe(409); // still BUILDING
  });

  it("deleting the account removes the build with it", async () => {
    const { u } = await setup(1);
    await change(u);
    await db.user.delete({ where: { id: u.id } });
    expect(await db.embeddingReindex.count({ where: { userId: u.id } })).toBe(0);
  });
});

// =====================================================================================================================================
describe("the embedding model can only be changed through the verified flow", () => {
  it("PUT /api/ai/preferences refuses an embedding change but still allows removal (which ends a pending build)", async () => {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    const d = await seedDoc(u, 1);
    const refused = await client(t, u).put("/api/ai/preferences", { tasks: { EMBEDDING: { provider: "mock", modelId: "flex-embed-1024" } } });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.details.fields["EMBEDDING.modelId"]).toMatch(/AI connection/);
    expect(await prefRow(u)).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 });

    await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }));
    expect((await getConn(u)).reindex?.status).toBe("BUILDING");
    expect((await client(t, u).put("/api/ai/preferences", { tasks: { EMBEDDING: null } })).status).toBe(200);
    expect(await prefRow(u)).toBeNull();
    expect((await getConn(u)).reindex).toBeNull();
    expect(await chunkSets(d.id)).toEqual(["mock-embed/1536x3".replace("x3", "x1")]); // documents keep their (now unused) vectors
  });
});

// =====================================================================================================================================
describe("ingestion and retrieval use the configured size", () => {
  it("new documents are embedded with the active dimension and request parameter, and recorded with the measured size", async () => {
    const u = await createUser();
    expect((await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }))).status).toBe(200);
    const form = new FormData();
    form.set("files", new Blob(["Cells are the unit of life."], { type: "text/plain" }), "a.txt");
    const up = await client(t, u).raw("POST", "/api/documents", form);
    const id = (await up.json()).results[0].document.id as string;
    t.rag.ingestScript = async () => ({ type: "result", status: "READY", page_count: 1, text_length: 10, chunk_count: 1, embedding_model: "flex-embed-1024", embedding_dimension: 512, code: null, message: null });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(t.rag.ingestCalls.at(-1)?.params.embedding).toEqual({ provider: "mock", api_key: KEY, model: "flex-embed-1024", dimension: 512, request_dimensions: 512 });
    expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", embeddingModel: "flex-embed-1024", embeddingDimension: 512 });
  });

  it("a document result whose vectors have another length than the configured one is rejected, not indexed", async () => {
    const u = await createUser();
    expect((await put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }))).status).toBe(200);
    const form = new FormData();
    form.set("files", new Blob(["Cells are the unit of life."], { type: "text/plain" }), "b.txt");
    const id = (await (await client(t, u).raw("POST", "/api/documents", form)).json()).results[0].document.id as string;
    t.rag.ingestScript = async () => ({ type: "result", status: "READY", page_count: 1, text_length: 10, chunk_count: 1, embedding_model: "flex-embed-1024", embedding_dimension: 1536, code: null, message: null });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", statusCode: "EMBEDDING_DIMENSION_MISMATCH" });
  });

  it("documents indexed under a different size are never searched with this configuration", async () => {
    const u = await createUser();
    expect((await put(u, good())).status).toBe(200);
    const d = await seedDoc(u, 1);
    await db.document.update({ where: { id: d.id }, data: { embeddingDimension: 768 } }); // same provider + model, other size
    const conn = await getConn(u);
    expect(conn.documents).toEqual({ ready: 1, stale: 1, processing: 0 });
    const res = await send(u, await docOnlyConv(u, [d.id]), "hello?");
    expect(res.status).toBe(409);
    expect(t.rag.chatCalls).toHaveLength(0);
  });
});
