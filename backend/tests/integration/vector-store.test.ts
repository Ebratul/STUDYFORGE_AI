import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RagAgentError, type IngestResult } from "../../src/clients/rag-agent.js";
import { getAuth } from "../../src/auth/auth.js";
import { resetEnvCache } from "../../src/config/env.js";
import { db } from "../../src/lib/db.js";
import { finalizeReindex, reindexHandlers } from "../../src/modules/ai/reindex.js";
import { ingestHandlers } from "../../src/modules/jobs/ingest.js";
import { enqueue } from "../../src/modules/jobs/queue.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { DELETE_VECTORS_JOB, queueSupersededVectors, vectorHandlers } from "../../src/modules/vectors/store.js";
import { defaultReindex } from "../helpers/fake-rag.js";
import { form, textFile } from "../helpers/files.js";
import { client, makeApp, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, TEST_PASSWORD, type TestUser } from "../helpers/users.js";

/**
 * docs/VECTOR_STORE_SPEC.md: with vectors outside PostgreSQL (dual / pinecone) every place that deletes chunk rows must also remove the
 * vectors, through a retried job committed in the same transaction. In pgvector mode (the default) nothing of this exists.
 */
let t: TestApp;
const setMode = (mode: "pgvector" | "dual" | "pinecone") => {
  process.env.VECTOR_STORE = mode;
  resetEnvCache();
};
beforeEach(async () => {
  setMode("pgvector");
  t = makeApp();
  await db.job.deleteMany({ where: { type: DELETE_VECTORS_JOB } }); // every status: assertions below count this test's jobs only
  await db.job.deleteMany({ where: { status: { in: ["PENDING", "RUNNING"] }, type: { in: ["ingest", "reindex-document", "reindex-finalize", "delete-object"] } } });
});
afterEach(() => {
  vi.restoreAllMocks();
  setMode("pgvector");
});

const KEY = "mock-valid-key";
const handlers = () => ({ ...ingestHandlers(t.rag, t.storage), ...reindexHandlers(t.rag), ...vectorHandlers(t.rag) });
const vecJobs = (where: Record<string, unknown> = {}) => db.job.findMany({ where: { type: DELETE_VECTORS_JOB, ...where }, orderBy: { createdAt: "asc" } });
const payloads = async (where: Record<string, unknown> = {}) => (await vecJobs(where)).map((j) => j.payload as Record<string, any>);

async function seedDoc(u: TestUser, chunks = 3, over: Record<string, unknown> = {}) {
  const doc = await db.document.create({
    data: { ownerId: u.id, name: `n-${randomUUID().slice(0, 6)}.txt`, extension: "txt", mimeType: "text/plain", sizeBytes: 10, sha256: randomUUID(), storageKey: `u/${u.id}/${randomUUID()}`, status: "READY", embeddingProvider: "MOCK", embeddingModel: "mock-embed", embeddingDimension: 1536, processingVersion: 1, chunkCount: chunks, ...over },
  });
  const ids: string[] = [];
  for (let i = 0; i < chunks; i++) {
    const id = randomUUID().replace(/-/g, "");
    ids.push(id);
    await db.$executeRaw`INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding","pineconeIndexedAt")
      VALUES (${id}, ${doc.id}, ${u.id}, ${i}, 1, ${`chunk ${i}`}, 3, 'mock', 'mock-embed', ${`[${Array.from({ length: 1536 }, (_, j) => (j === 0 ? 1 : 0)).join(",")}]`}::vector, now())`;
  }
  return { doc, ids };
}

// ======================================================================================================================================
describe("pgvector mode (the default): nothing is queued", () => {
  it("deleting a document queues no vector job", async () => {
    const u = await createUser();
    const { doc } = await seedDoc(u);
    expect((await client(t, u).delete(`/api/documents/${doc.id}`)).status).toBe(200);
    expect(await vecJobs()).toEqual([]);
    await runDueJobs(handlers());
    expect(t.rag.deleteVectorCalls).toEqual([]);
  });

  it("deleting an account queues no vector job", async () => {
    const u = await createUser();
    await seedDoc(u);
    await getAuth().api.deleteUser({ headers: u.headers, body: { password: TEST_PASSWORD } });
    expect(await vecJobs()).toEqual([]);
  });

  it("an ingest result that mentions superseded vectors is ignored here (a mode mismatch is logged, nothing is deleted)", async () => {
    const u = await createUser();
    await expect(db.$transaction((tx) => queueSupersededVectors(tx, u.id, [{ identity: { provider: "mock", model: "m", dimension: 1536 }, chunks: [["d", "c"]] }]))).resolves.toBeUndefined();
    expect(await vecJobs()).toEqual([]);
  });

  it("the connection check never asks rag_agent about a vector index", async () => {
    const u = await createUser();
    const res = await client(t, u).put("/api/ai/connection", { apiKey: KEY, chatModelId: "mock-chat", embeddingModelId: "mock-embed" });
    expect(res.status).toBe(200);
    expect(t.rag.vectorStatusCalls).toBe(0);
  });
});

// ======================================================================================================================================
describe.each(["dual", "pinecone"] as const)("%s mode", (mode) => {
  beforeEach(() => setMode(mode));

  describe("document and account deletion", () => {
    it("deleting a document queues one idempotent job in the same transaction; running it asks rag_agent to remove that document's vectors", async () => {
      const u = await createUser();
      const { doc } = await seedDoc(u);
      expect((await client(t, u).delete(`/api/documents/${doc.id}`)).status).toBe(200);
      expect(await db.document.count({ where: { id: doc.id } })).toBe(0);
      expect(await payloads()).toEqual([{ scope: "document", ownerId: u.id, documentId: doc.id }]);
      await runDueJobs(handlers());
      expect(t.rag.deleteVectorCalls).toEqual([{ scope: "document", owner_id: u.id, document_id: doc.id }]);
      expect((await vecJobs())[0]).toMatchObject({ status: "SUCCEEDED", dedupeKey: null });
    });

    it("a refused deletion (someone else's document) queues nothing", async () => {
      const a = await createUser();
      const b = await createUser();
      const { doc } = await seedDoc(a);
      expect((await client(t, b).delete(`/api/documents/${doc.id}`)).status).toBe(404);
      expect(await vecJobs()).toEqual([]);
      expect(await db.document.count({ where: { id: doc.id } })).toBe(1);
    });

    it("a transient vector-store failure is retried with backoff and then succeeds", async () => {
      const u = await createUser();
      const { doc } = await seedDoc(u);
      await client(t, u).delete(`/api/documents/${doc.id}`);
      let n = 0;
      t.rag.deleteVectorsScript = async () => {
        if (++n < 3) throw new RagAgentError("VECTOR_STORE_UNAVAILABLE", "down", true, null, 503);
        return { status: "ok", mode, deleted: 3 };
      };
      for (let round = 1; round <= 3; round++) {
        await runDueJobs(handlers());
        const job = (await vecJobs())[0]!;
        expect(job.attempts).toBe(round);
        expect(job.status).toBe(round < 3 ? "PENDING" : "SUCCEEDED");
        if (round < 3) {
          expect(job.lastError).toBe("VECTOR_STORE_UNAVAILABLE");
          await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
        }
      }
      expect(n).toBe(3);
    });

    it("a permanent failure (credentials rejected) is not retried and is visible to the operator", async () => {
      const u = await createUser();
      const { doc } = await seedDoc(u);
      await client(t, u).delete(`/api/documents/${doc.id}`);
      t.rag.deleteVectorsScript = async () => {
        throw new RagAgentError("VECTOR_STORE_AUTH", "rejected", false, null, 502);
      };
      await runDueJobs(handlers());
      expect((await vecJobs())[0]).toMatchObject({ status: "FAILED", attempts: 1, lastError: "delete-vectors failed: VECTOR_STORE_AUTH" });
    });

    it("deleting an account queues one user-level job listing the user's documents; it runs after the account is gone", async () => {
      const u = await createUser();
      const { doc: d1 } = await seedDoc(u);
      const { doc: d2 } = await seedDoc(u);
      await getAuth().api.deleteUser({ headers: u.headers, body: { password: TEST_PASSWORD } });
      const [p] = await payloads();
      expect(await vecJobs()).toHaveLength(1);
      expect(p).toMatchObject({ scope: "user", ownerId: u.id });
      expect([...p!.documentIds].sort()).toEqual([d1.id, d2.id].sort());
      await runDueJobs(handlers());
      expect(t.rag.deleteVectorCalls).toHaveLength(1);
      expect(t.rag.deleteVectorCalls[0]).toMatchObject({ scope: "user", owner_id: u.id });
    });

    it("never wipes the vectors of an account that still exists (the deletion hook runs before the deletion)", async () => {
      const u = await createUser();
      await enqueue(db, { type: DELETE_VECTORS_JOB, payload: { scope: "user", ownerId: u.id, documentIds: [] }, maxAttempts: 3 });
      await runDueJobs(handlers());
      expect(t.rag.deleteVectorCalls).toEqual([]);
      const job = (await vecJobs())[0]!;
      expect(job).toMatchObject({ status: "PENDING", attempts: 1, lastError: "account still exists" });
      expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000); // looked at again later, not hammered
      // out of attempts: give up quietly, still without deleting anything
      await db.job.update({ where: { id: job.id }, data: { runAt: new Date(), attempts: 2 } });
      await runDueJobs(handlers());
      expect(t.rag.deleteVectorCalls).toEqual([]);
      expect((await vecJobs())[0]).toMatchObject({ status: "SUCCEEDED" });
    });

    it("malformed or hostile job payloads are rejected before anything is sent", async () => {
      for (const payload of [{ scope: "user", ownerId: "a:b", documentIds: [] }, { scope: "document", ownerId: "ok", documentId: "../x" }, { scope: "chunks", ownerId: "ok", identity: { provider: "p", model: "m", dimension: 1536 }, chunks: [] }, { scope: "everything" }]) {
        await enqueue(db, { type: DELETE_VECTORS_JOB, payload, maxAttempts: 2 });
      }
      await runDueJobs(handlers());
      expect(t.rag.deleteVectorCalls).toEqual([]);
      expect((await vecJobs()).every((j) => j.status === "FAILED" && /malformed/.test(j.lastError ?? ""))).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("ingestion", () => {
    const ready = (over: Partial<Extract<IngestResult, { type: "result" }>> = {}): IngestResult => ({ type: "result", status: "READY", page_count: 1, text_length: 10, chunk_count: 3, embedding_model: "mock-embed", embedding_dimension: 1536, code: null, message: null, ...over });
    async function queued(u: TestUser) {
      const res = await client(t, u).raw("POST", "/api/documents", form([{ name: "n.txt", type: "text/plain", data: textFile(`Cells ${randomUUID()}`) }]));
      return (await res.json()).results[0].document.id as string;
    }

    it("the previous version's vectors are queued for removal together with the READY status, in batches of at most 500", async () => {
      const u = await createUser();
      await setupAi(t, u);
      const id = await queued(u);
      const chunks: [string, string][] = Array.from({ length: 1200 }, (_, i) => [id, `old${i}`.padEnd(32, "0")]);
      t.rag.ingestScript = async () => ready({ superseded: [{ identity: { provider: "mock", model: "mock-embed", dimension: 1536 }, chunks }] });
      await runDueJobs(handlers()); // the ingest job, then the cleanup jobs it queued
      expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "READY", processingVersion: 1 });
      const ps = await payloads();
      expect((await vecJobs()).map((j) => j.status)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
      expect(ps.map((p) => p.chunks.length)).toEqual([500, 500, 200]);
      expect(ps.every((p) => p.scope === "chunks" && p.ownerId === u.id && p.identity.dimension === 1536 && p.identity.model === "mock-embed")).toBe(true);
      expect(ps.flatMap((p) => p.chunks)).toEqual(chunks); // exactly the reported pairs, in order
      expect(t.rag.deleteVectorCalls.flatMap((c) => (c.scope === "chunks" ? c.chunks : []))).toEqual(chunks);
    });

    it("a first ingest (nothing superseded) and a failed ingest queue nothing", async () => {
      const u = await createUser();
      await setupAi(t, u);
      const id = await queued(u);
      t.rag.ingestScript = async () => ready({ superseded: [] });
      await runDueJobs(ingestHandlers(t.rag, t.storage));
      expect(await vecJobs()).toEqual([]);
      const id2 = await queued(u);
      t.rag.ingestScript = async () => ({ type: "result", status: "FAILED", code: "NO_TEXT", message: "No readable text." });
      await runDueJobs(ingestHandlers(t.rag, t.storage));
      expect(await db.document.findUniqueOrThrow({ where: { id: id2 } })).toMatchObject({ status: "FAILED" });
      expect(await vecJobs()).toEqual([]);
      expect(id).not.toBe(id2);
    });

    it("an unsupported embedding size fails the document at once with an actionable message (no retry loop)", async () => {
      const u = await createUser();
      await setupAi(t, u);
      const id = await queued(u);
      t.rag.ingestScript = async () => ({ type: "error", code: "VECTOR_DIMENSION_UNSUPPORTED", message: "x", retryable: false });
      await runDueJobs(ingestHandlers(t.rag, t.storage));
      const doc = await db.document.findUniqueOrThrow({ where: { id } });
      expect(doc).toMatchObject({ status: "FAILED", statusCode: "VECTOR_DIMENSION_UNSUPPORTED" });
      expect(doc.statusDetail).toMatch(/embedding size|Settings/);
      expect(await vecJobs()).toEqual([]);
    });

    it("a vector-store outage is retried by the ingestion job and ends with a clear message, not a stack trace", async () => {
      const u = await createUser();
      await setupAi(t, u);
      const id = await queued(u);
      t.rag.ingestScript = async () => ({ type: "error", code: "VECTOR_STORE_UNAVAILABLE", message: "upstream said something internal", retryable: true });
      const hs = ingestHandlers(t.rag, t.storage);
      for (let attempt = 1; attempt <= 4; attempt++) {
        await runDueJobs(hs);
        const job = await db.job.findFirstOrThrow({ where: { type: "ingest", payload: { path: ["documentId"], equals: id } } });
        if (attempt < 4) {
          expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "QUEUED" });
          await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
        }
      }
      const doc = await db.document.findUniqueOrThrow({ where: { id } });
      expect(doc).toMatchObject({ status: "FAILED", statusCode: "VECTOR_STORE_UNAVAILABLE" });
      expect(doc.statusDetail).toBe("The document search index is temporarily unavailable. Retry in a moment.");
      expect(doc.statusDetail).not.toMatch(/upstream/);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("embedding re-index", () => {
    const good = (over: Record<string, unknown> = {}) => ({ apiKey: KEY, chatModelId: "mock-chat", embeddingModelId: "mock-embed", ...over });
    const put = (u: TestUser, body: unknown) => client(t, u).put("/api/ai/connection", body);
    const change = (u: TestUser) => put(u, good({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }));
    const sets = async (docId: string) =>
      (await db.$queryRaw<{ model: string; dim: number | null; n: bigint }[]>`SELECT "embeddingModel" AS model, "embeddingDimension" AS dim, count(*) AS n FROM "DocumentChunk" WHERE "documentId" = ${docId} GROUP BY 1, 2 ORDER BY 1, 2`).map((r) => `${r.model}/${r.dim}x${Number(r.n)}`);
    /** Like rag_agent in this mode: the staged set exists in PostgreSQL and (marker) in the vector store. */
    const withMarker = (marked: boolean) => async (p: Parameters<typeof defaultReindex>[0]) => {
      const out = await defaultReindex(p);
      if (marked) await db.$executeRaw`UPDATE "DocumentChunk" SET "pineconeIndexedAt" = now() WHERE "documentId" = ${p.document_id} AND "embeddingModel" = ${p.target.model}`;
      return out;
    };
    const pump = async (rounds = 25) => {
      for (let i = 0; i < rounds; i++) {
        await db.job.updateMany({ where: { type: { in: ["reindex-document", "reindex-finalize"] }, status: "PENDING" }, data: { runAt: new Date() } });
        if ((await runDueJobs(handlers())) === 0) break;
      }
    };
    async function setup() {
      t.rag.vectorStatusScript = async () => ({ mode, dimensions: [1536, 1024, 512] });
      const u = await createUser();
      expect((await put(u, good())).status).toBe(200);
      const d = await seedDoc(u);
      return { u, d };
    }

    it("cancelling a build queues removal of exactly the staged vectors and never the active ones", async () => {
      const { u, d } = await setup();
      t.rag.reindexScript = withMarker(true);
      await change(u);
      await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date(Date.now() + 3_600_000) } });
      await runDueJobs({ ...reindexHandlers(t.rag) });
      expect(await sets(d.doc.id)).toEqual(["flex-embed-1024/512x3", "mock-embed/1536x3"]);
      const staged = (await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "DocumentChunk" WHERE "documentId" = ${d.doc.id} AND "embeddingModel" = 'flex-embed-1024'`).map((r) => r.id).sort();
      expect((await client(t, u).post("/api/ai/embedding-reindex/cancel")).status).toBe(200);
      expect(await sets(d.doc.id)).toEqual(["mock-embed/1536x3"]);
      const ps = await payloads();
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({ scope: "chunks", ownerId: u.id, identity: { provider: "mock", model: "flex-embed-1024", dimension: 512 } });
      expect(ps[0]!.chunks.map((c: string[]) => c[1]).sort()).toEqual(staged);
      expect(ps[0]!.chunks.every((c: string[]) => c[0] === d.doc.id)).toBe(true);
      for (const id of d.ids) expect(JSON.stringify(ps)).not.toContain(id); // the active set's ids appear nowhere
    });

    it("activating the new index queues removal of the OLD identity's vectors, only after the switch", async () => {
      const { u, d } = await setup();
      t.rag.reindexScript = withMarker(true);
      await change(u);
      await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date(Date.now() + 3_600_000) } });
      await runDueJobs({ ...reindexHandlers(t.rag) });
      expect(await vecJobs()).toHaveLength(0); // nothing is removed while the new index is only being built
      await db.job.updateMany({ where: { type: "reindex-finalize" }, data: { runAt: new Date() } });
      await pump();
      expect(await sets(d.doc.id)).toEqual(["flex-embed-1024/512x3"]);
      const ps = await payloads();
      expect(ps).toHaveLength(1);
      expect(ps[0]).toMatchObject({ scope: "chunks", ownerId: u.id, identity: { provider: "mock", model: "mock-embed", dimension: 1536 } });
      expect(ps[0]!.chunks.map((c: string[]) => c[1]).sort()).toEqual([...d.ids].sort());
      expect((await vecJobs()).map((j) => j.status)).toEqual(["SUCCEEDED"]); // the pump ran it
      expect(t.rag.deleteVectorCalls).toHaveLength(1);
      expect(t.rag.deleteVectorCalls[0]).toMatchObject({ scope: "chunks", owner_id: u.id });
    });

    it("a staged set that is not marked as stored in the vector index is never activated", async () => {
      const { u, d } = await setup();
      t.rag.reindexScript = withMarker(false); // rag_agent reported success, but the database does not show the vectors as indexed
      await change(u);
      await pump();
      const row = await db.embeddingReindex.findFirstOrThrow({ where: { userId: u.id }, orderBy: { createdAt: "desc" } });
      expect(row).toMatchObject({ status: "FAILED", errorCode: "VERIFICATION_FAILED" });
      expect(await db.modelPreference.findUniqueOrThrow({ where: { userId_task: { userId: u.id, task: "EMBEDDING" } } })).toMatchObject({ modelId: "mock-embed", embeddingDimension: 1536 });
      expect(await sets(d.doc.id)).toEqual(["mock-embed/1536x3"]); // active index untouched, failed staged set cleaned up
      expect(row.finishedAt).not.toBeNull();
    });

    it("a re-index that the vector index cannot hold fails with the vector-store message, active index untouched", async () => {
      const { u, d } = await setup();
      t.rag.reindexScript = async () => {
        throw new RagAgentError("VECTOR_DIMENSION_UNSUPPORTED", "x", false, null, 422);
      };
      await change(u);
      await pump();
      const row = await db.embeddingReindex.findFirstOrThrow({ where: { userId: u.id }, orderBy: { createdAt: "desc" } });
      expect(row).toMatchObject({ status: "FAILED", errorCode: "VECTOR_DIMENSION_UNSUPPORTED" });
      expect(row.errorMessage).toMatch(/doesn't support the new embedding size/);
      expect(await sets(d.doc.id)).toEqual(["mock-embed/1536x3"]);
      void finalizeReindex;
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("connection check", () => {
    const body = (over: Record<string, unknown> = {}) => ({ apiKey: KEY, chatModelId: "mock-chat", embeddingModelId: "mock-embed", ...over });

    it("accepts a size the vector index holds, and asks rag_agent about it", async () => {
      const u = await createUser();
      const res = await client(t, u).put("/api/ai/connection", body());
      expect(res.status).toBe(200);
      expect(t.rag.vectorStatusCalls).toBeGreaterThan(0);
      expect((await res.json()).checks.database).toMatchObject({ ok: true, dimension: 1536 });
    });

    it("refuses a size the index does not hold, explains it on the size field, and saves nothing", async () => {
      const u = await createUser();
      const res = await client(t, u).put("/api/ai/connection", body({ embeddingModelId: "flex-embed-1024", embeddingDimension: 512 }));
      expect(res.status).toBe(422);
      const err = (await res.json()).error;
      expect(err.details.checks.database).toMatchObject({ ok: false, code: "VECTOR_DIMENSION_UNSUPPORTED", dimension: 512 });
      expect(err.details.fields.embeddingDimension).toMatch(/supports 1536-dimensional vectors only.*512.*never padded or truncated/);
      expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
    });

    it("reports a mode mismatch between the two services as an installation problem, not a user error", async () => {
      const u = await createUser();
      t.rag.vectorStatusScript = async () => ({ mode: "pgvector", dimensions: null });
      const res = await client(t, u).put("/api/ai/connection", body());
      expect(res.status).toBe(422);
      const err = (await res.json()).error;
      expect(err.details.checks.database).toMatchObject({ ok: false, code: "VECTOR_STORE_MISCONFIGURED" });
      expect(err.details.fields.embeddingModelId).toMatch(/different vector stores/);
      expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
    });

    it("an unreachable vector index fails the check with a retry hint and saves nothing", async () => {
      const u = await createUser();
      t.rag.vectorStatusScript = async () => {
        throw new RagAgentError("UPSTREAM_UNAVAILABLE", "down", true, null, 503);
      };
      const res = await client(t, u).put("/api/ai/connection", body());
      expect(res.status).toBe(422);
      expect((await res.json()).error.details.checks.database).toMatchObject({ ok: false, code: "VECTOR_STORE_UNAVAILABLE" });
      expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
    });

    it("in pinecone mode the pgvector column's limits no longer apply", async () => {
      if (mode !== "pinecone") return;
      const { vectorStorageCheck } = await import("../../src/modules/ai/connection.js");
      const remote = { mode: "pinecone" as const, remote: { mode: "pinecone" as const, dimensions: [2048] } };
      expect(vectorStorageCheck({ extension: "0.8", column: "vector(1536)", ...remote }, 2048)).toMatchObject({ ok: true });
      expect(vectorStorageCheck({ extension: "0.8", column: "vector(1536)", ...remote, mode: "dual" }, 2048)).toMatchObject({ ok: false, code: "VECTOR_STORE_MISCONFIGURED" });
      expect(vectorStorageCheck({ extension: "0.8", column: "vector(1536)", mode: "dual", remote: { mode: "dual", dimensions: [2048] } }, 2048)).toMatchObject({ ok: false, code: "DB_DIMENSION_MISMATCH" });
    });
  });
});
