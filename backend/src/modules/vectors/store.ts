import { z } from "zod";
import { RagAgentError, type ProviderId, type RagAgentClient, type ReindexIdentity, type SupersededVectors, type VectorDeleteRequest } from "../../clients/rag-agent.js";
import { getEnv } from "../../config/env.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { enqueue, RetryableJobError } from "../jobs/queue.js";
import type { Handlers } from "../jobs/worker.js";

/**
 * Removal of vectors that live outside PostgreSQL (VECTOR_STORE=dual|pinecone; docs/VECTOR_STORE_SPEC.md §6).
 *
 * PostgreSQL deletes its own chunk rows by cascade; a remote vector store has nothing to cascade. So every place that deletes chunk rows
 * also queues a `delete-vectors` job IN THE SAME TRANSACTION, and the retried job asks rag_agent (the only service holding the vector
 * store's credentials) to remove them. Jobs are idempotent: deleting what is already gone succeeds.
 *
 * If a cleanup is ever lost, the leftover vectors have no PostgreSQL row and can never be returned (retrieval validates every candidate
 * against PostgreSQL); `python -m app.tools.reconcile_pinecone` in rag_agent removes them.
 */
export const DELETE_VECTORS_JOB = "delete-vectors";
const CHUNKS_PER_JOB = 500;
const MAX_ATTEMPTS = 8;
const USER_STILL_THERE_DELAY_MS = 2 * 60_000;

/** True when vectors exist outside PostgreSQL, so deleting rows is not enough. */
export const remoteVectorsEnabled = (): boolean => getEnv().VECTOR_STORE !== "pgvector";

type Queue = Parameters<typeof enqueue>[0];

export type ChunkRef = { id: string; documentId: string; embeddingProvider: string; embeddingModel: string; embeddingDimension: number | null };

export async function queueDeleteDocumentVectors(tx: Queue, ownerId: string, documentId: string): Promise<void> {
  if (!remoteVectorsEnabled()) return;
  await enqueue(tx, { type: DELETE_VECTORS_JOB, payload: { scope: "document", ownerId, documentId }, dedupeKey: `${DELETE_VECTORS_JOB}:doc:${documentId}`, maxAttempts: MAX_ATTEMPTS });
}

/** `documentIds` lets a shared-namespace index delete document by document; a per-user namespace is removed in one call. */
export async function queueDeleteUserVectors(tx: Queue, ownerId: string, documentIds: string[]): Promise<void> {
  if (!remoteVectorsEnabled()) return;
  await enqueue(tx, { type: DELETE_VECTORS_JOB, payload: { scope: "user", ownerId, documentIds }, dedupeKey: `${DELETE_VECTORS_JOB}:user:${ownerId}`, maxAttempts: MAX_ATTEMPTS });
}

/** Exact `(document, chunk)` pairs of one identity each, in jobs of at most 500. Chunks without a recorded dimension never reached a vector store. */
export async function queueDeleteChunkVectors(tx: Queue, ownerId: string, chunks: ChunkRef[]): Promise<number> {
  if (!remoteVectorsEnabled()) return 0;
  const groups = new Map<string, { identity: ReindexIdentity; chunks: [string, string][] }>();
  for (const c of chunks) {
    if (c.embeddingDimension === null) continue;
    const key = `${c.embeddingProvider}\u0000${c.embeddingModel}\u0000${c.embeddingDimension}`;
    const g = groups.get(key) ?? { identity: { provider: c.embeddingProvider as ProviderId | "unknown", model: c.embeddingModel, dimension: c.embeddingDimension }, chunks: [] };
    g.chunks.push([c.documentId, c.id]);
    groups.set(key, g);
  }
  let jobs = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.chunks.length; i += CHUNKS_PER_JOB) {
      await enqueue(tx, { type: DELETE_VECTORS_JOB, payload: { scope: "chunks", ownerId, identity: g.identity, chunks: g.chunks.slice(i, i + CHUNKS_PER_JOB) }, maxAttempts: MAX_ATTEMPTS });
      jobs++;
    }
  }
  return jobs;
}

/** The previous version's vectors, as reported by rag_agent after it replaced them in PostgreSQL (see IngestResult.superseded). */
export async function queueSupersededVectors(tx: Queue, ownerId: string, superseded: SupersededVectors | undefined): Promise<void> {
  if (!superseded?.length) return;
  if (!remoteVectorsEnabled()) {
    logger.warn("vectors.mode_mismatch", { detail: "rag_agent reported remote vectors but VECTOR_STORE=pgvector here; set both services to the same mode" });
    return;
  }
  for (const g of superseded) {
    for (let i = 0; i < g.chunks.length; i += CHUNKS_PER_JOB) {
      await enqueue(tx, { type: DELETE_VECTORS_JOB, payload: { scope: "chunks", ownerId, identity: g.identity, chunks: g.chunks.slice(i, i + CHUNKS_PER_JOB) }, maxAttempts: MAX_ATTEMPTS });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------------------------------------------
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const identity = z.object({ provider: z.string().min(1).max(32), model: z.string().min(1).max(200), dimension: z.number().int().min(8).max(4096) });
const payloadSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("document"), ownerId: id, documentId: id }),
  z.object({ scope: z.literal("user"), ownerId: id, documentIds: z.array(id).max(5000) }),
  z.object({ scope: z.literal("chunks"), ownerId: id, identity, chunks: z.array(z.tuple([id, id])).min(1).max(CHUNKS_PER_JOB) }),
]);

function toRequest(p: z.infer<typeof payloadSchema>): VectorDeleteRequest {
  if (p.scope === "document") return { scope: "document", owner_id: p.ownerId, document_id: p.documentId };
  if (p.scope === "user") return { scope: "user", owner_id: p.ownerId, document_ids: p.documentIds };
  return { scope: "chunks", owner_id: p.ownerId, identity: p.identity as ReindexIdentity, chunks: p.chunks };
}

export function vectorHandlers(rag: RagAgentClient): Handlers {
  return {
    [DELETE_VECTORS_JOB]: async (job, signal) => {
      const parsed = payloadSchema.safeParse(job.payload);
      if (!parsed.success) throw new Error("delete-vectors: malformed payload"); // permanent: retrying cannot fix it
      const p = parsed.data;

      if (p.scope === "user" && (await db.user.count({ where: { id: p.ownerId } })) > 0) {
        // The deletion hook queues this BEFORE the account is removed. If the account is still there the deletion has not happened (yet,
        // or at all): never wipe a live user's index. Look again later; after the last attempt give up without deleting anything.
        if (job.attempts >= job.maxAttempts) return void logger.warn("vectors.user_delete_skipped", { reason: "account still exists" });
        throw new RetryableJobError("account still exists", USER_STILL_THERE_DELAY_MS);
      }

      try {
        await rag.deleteVectors(toRequest(p), signal);
      } catch (err) {
        if (!(err instanceof RagAgentError)) throw err;
        if (err.retryable) throw new RetryableJobError(err.code, err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : undefined);
        throw new Error(`delete-vectors failed: ${err.code}`, { cause: err }); // permanent (e.g. the vector store rejects our credentials): the job shows as FAILED for the operator
      }
    },
  };
}
