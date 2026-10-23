import { Prisma, type AiProvider, type EmbeddingReindex } from "../../generated/prisma/client.js";
import { RagAgentError, type RagAgentClient } from "../../clients/rag-agent.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { recordProviderEvent } from "../../lib/metrics.js";
import { enqueue, RetryableJobError } from "../jobs/queue.js";
import type { Handlers } from "../jobs/worker.js";
import { getDecryptedKey, markCredentialInvalid } from "./credentials.js";
import { docIdentity, DIMENSION_MISMATCH_MESSAGE, LEGACY_DIMENSION, sameIdentity, type EmbeddingIdentity } from "./embedding-identity.js";
import { toWire } from "./providers.js";
import { queueDeleteChunkVectors, remoteVectorsEnabled, type ChunkRef } from "../vectors/store.js";
import { getEnv } from "../../config/env.js";

/**
 * Staged re-indexing (docs/EMBEDDING_SETTINGS_SPEC.md §5).
 *
 * The user's saved embedding configuration (ModelPreference EMBEDDING) is the ACTIVE index and keeps serving while the new one is built
 * as a second chunk set. It is switched in ONE transaction, and only after the database itself confirms that every READY document has a
 * complete staged set of exactly the target dimension. Anything that goes wrong leaves the active index untouched.
 */

type Tx = Prisma.TransactionClient;

export type ReindexTarget = { provider: AiProvider; modelId: string; dimension: number; requestDimensions: number | null };

export type ReindexView = {
  id: string;
  status: "BUILDING" | "FAILED";
  provider: "openrouter" | "openai" | "groq" | "mock";
  modelId: string;
  dimension: number;
  progress: { total: number; done: number };
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
};

/** Safe, user-facing explanations (never contain upstream bodies, ids or keys). */
const FAILURE_MESSAGES: Record<string, string> = {
  PROVIDER_AUTH_INVALID: "Your embedding provider rejected the API key. Update the key in Settings, then retry.",
  MODEL_NOT_FOUND: "The new embedding model wasn't found for your key. Choose another model, then save again.",
  PROVIDER_RATE_LIMITED: "The embedding provider kept rate-limiting requests. Wait a few minutes, then retry.",
  PROVIDER_TIMEOUT: "The embedding provider timed out. Retry in a moment.",
  PROVIDER_UNAVAILABLE: "The embedding provider is unavailable right now. Retry in a moment.",
  QUOTA_EXCEEDED: "The embedding provider reports that the quota or billing limit for this key has been reached.",
  UPSTREAM_UNAVAILABLE: "The document processing service is unavailable. Retry in a moment.",
  EMBEDDING_DIMENSION_MISMATCH: DIMENSION_MISMATCH_MESSAGE,
  EMBEDDING_DIMENSION_UNSUPPORTED: DIMENSION_MISMATCH_MESSAGE,
  BUILD_TIMEOUT: "Building the new index took too long (documents kept changing or processing). Your previous index is unchanged. Retry when your documents are idle.",
  VERIFICATION_FAILED: "The new index failed its completeness check, so it was not activated. Your previous index is unchanged. Retry; if it happens again, contact support.",
  INTERNAL: "The new index could not be built because of an internal error. Your previous index is unchanged. Retry in a moment.",
  VECTOR_DIMENSION_UNSUPPORTED: "This installation's document search index doesn't support the new embedding size. Choose a model or size it supports, then save again. Your previous index is unchanged.",
  VECTOR_STORE_UNAVAILABLE: "The document search index was unavailable for too long. Your previous index is unchanged. Retry in a moment.",
  VECTOR_STORE_RATE_LIMITED: "The document search index kept rate-limiting requests. Your previous index is unchanged. Retry in a few minutes.",
  VECTOR_STORE_AUTH: "Document indexing is not configured correctly on the server. Your previous index is unchanged. Contact the administrator.",
  VECTOR_STORE_ERROR: "Document indexing is not configured correctly on the server. Your previous index is unchanged. Contact the administrator.",
  VECTOR_STORE_SCHEMA_NOT_READY: "Document indexing is not configured correctly on the server. Your previous index is unchanged. Contact the administrator.",
  KEY_MISSING: "The API key for the new embedding model is no longer saved. Add it in Settings, then save again.",
  SOURCE_MISSING: "A document's stored text could not be found, so it could not be re-indexed. Re-process that document, then retry.",
};
const failureMessage = (code: string) => FAILURE_MESSAGES[code] ?? "The new index could not be built. Your previous index is unchanged. Retry in a moment.";

const targetOf = (r: Pick<EmbeddingReindex, "provider" | "modelId" | "dimension">): EmbeddingIdentity => ({ provider: r.provider, model: r.modelId, dimension: r.dimension });

// ---------------------------------------------------------------------------------------------------------------------------------
// Database facts (all verification is done by the database, not by what rag_agent reported)
// ---------------------------------------------------------------------------------------------------------------------------------
type CoverageRow = { id: string; status: string; processingVersion: number; done: boolean };

/**
 * One row per document of the user that could be searched (READY) or is about to become so (QUEUED/PROCESSING).
 * `done` = the document is already in the target identity, OR it has a staged set with exactly as many vectors of the target length as its
 * active set has chunks (and at least one). Chunk identity is the generated vector length, so a wrong-sized vector can never count.
 */
/**
 * What proves a STAGED chunk is stored where retrieval will look for it: its local vector (pgvector), the Pinecone marker that rag_agent sets
 * only after it saw the vector in the index (pinecone), or both (dual, which serves PostgreSQL but must be ready to switch).
 */
function stagedStored(): Prisma.Sql {
  const mode = getEnv().VECTOR_STORE; // fixed fragments chosen by an enum: nothing user-controlled is ever spliced into the SQL
  if (mode === "pinecone") return Prisma.sql`n."pineconeIndexedAt" IS NOT NULL`;
  if (mode === "dual") return Prisma.sql`n."embedding" IS NOT NULL AND n."pineconeIndexedAt" IS NOT NULL`;
  return Prisma.sql`n."embedding" IS NOT NULL`;
}

async function coverage(tx: Pick<Tx, "$queryRaw">, userId: string, t: EmbeddingIdentity): Promise<CoverageRow[]> {
  const provider = toWire(t.provider!);
  return tx.$queryRaw<CoverageRow[]>`
    SELECT d."id", d."status"::text AS "status", d."processingVersion",
      (
        (d."embeddingModel" = ${t.model} AND lower(d."embeddingProvider"::text) = ${provider} AND COALESCE(d."embeddingDimension", ${LEGACY_DIMENSION}) = ${t.dimension})
        OR (
          (SELECT count(*) FROM "DocumentChunk" o
             WHERE o."documentId" = d."id" AND o."processingVersion" = d."processingVersion" AND o."embeddingModel" = d."embeddingModel"
               AND o."embeddingProvider" = COALESCE(lower(d."embeddingProvider"::text), 'unknown')
               AND o."embeddingDimension" = COALESCE(d."embeddingDimension", ${LEGACY_DIMENSION})) > 0
          AND (SELECT count(*) FROM "DocumentChunk" n
                 WHERE n."documentId" = d."id" AND n."processingVersion" = d."processingVersion" AND n."embeddingModel" = ${t.model}
                   AND n."embeddingProvider" = ${provider} AND n."embeddingDimension" = ${t.dimension} AND ${stagedStored()})
              = (SELECT count(*) FROM "DocumentChunk" o
                   WHERE o."documentId" = d."id" AND o."processingVersion" = d."processingVersion" AND o."embeddingModel" = d."embeddingModel"
                     AND o."embeddingProvider" = COALESCE(lower(d."embeddingProvider"::text), 'unknown')
                     AND o."embeddingDimension" = COALESCE(d."embeddingDimension", ${LEGACY_DIMENSION}))
        )
      ) AS "done"
    FROM "Document" d
    WHERE d."ownerId" = ${userId} AND d."status" IN ('READY', 'QUEUED', 'PROCESSING')`;
}

/**
 * Removes everything staged for the target provider + model, at ANY vector length (so even rows a faulty writer left with the wrong
 * length are cleaned up). A document's active set is never removed: chunks that carry the document's own recorded identity are skipped.
 */
async function purgeStaged(tx: Pick<Tx, "$executeRaw" | "$queryRaw" | "job">, userId: string, t: EmbeddingIdentity): Promise<number> {
  const provider = toWire(t.provider!);
  return deleteChunks(tx, userId, Prisma.sql`
    DELETE FROM "DocumentChunk" c USING "Document" d
    WHERE c."documentId" = d."id" AND d."ownerId" = ${userId}
      AND c."embeddingModel" = ${t.model} AND c."embeddingProvider" = ${provider}
      AND NOT (c."embeddingModel" = d."embeddingModel" AND c."embeddingProvider" = COALESCE(lower(d."embeddingProvider"::text), 'unknown')
               AND c."embeddingDimension" = COALESCE(d."embeddingDimension", ${LEGACY_DIMENSION}))`);
}

/**
 * Deletes chunk rows (`stmt` aliases the table as `c`). With a remote vector store the same transaction also queues the removal of exactly
 * the deleted rows' vectors, so a rolled-back transaction queues nothing and a committed one always does. pgvector mode: unchanged.
 */
async function deleteChunks(tx: Pick<Tx, "$executeRaw" | "$queryRaw" | "job">, userId: string, stmt: Prisma.Sql): Promise<number> {
  if (!remoteVectorsEnabled()) return tx.$executeRaw(stmt);
  const rows = await tx.$queryRaw<ChunkRef[]>(Prisma.sql`${stmt} RETURNING c."id", c."documentId", c."embeddingProvider", c."embeddingModel", c."embeddingDimension"`);
  await queueDeleteChunkVectors(tx, userId, rows);
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Starting / switching
// ---------------------------------------------------------------------------------------------------------------------------------
export type ApplyResult = { status: "unchanged" | "activated" | "reindexing"; documents: number };

/** The finalize job is a poller (it also guarantees progress if a wake-up from a finished document job is ever deduplicated away). */
const FINALIZE_MAX_ATTEMPTS = 3000;
const FINALIZE_POLL_MS = 10_000;
const jobKey = (reindexId: string, docId: string, version: number) => `reindex-doc:${reindexId}:${docId}:${version}`;
const finalizeKey = (reindexId: string) => `reindex-final:${reindexId}`;

/** Ends every build of this user that has not finished (BUILDING or FAILED) and removes its staged chunks. */
async function supersede(tx: Tx, userId: string, status: "CANCELLED" | "ACTIVATED" = "CANCELLED"): Promise<EmbeddingReindex[]> {
  const open = await tx.embeddingReindex.findMany({ where: { userId, status: { in: ["BUILDING", "FAILED"] } } });
  for (const r of open) {
    await tx.embeddingReindex.update({ where: { id: r.id }, data: { status, finishedAt: new Date() } });
    await purgeStaged(tx, userId, targetOf(r));
  }
  return open;
}

/**
 * The single place that decides what saving an embedding configuration means. Runs inside the caller's transaction, so the credential,
 * chat preference and this decision commit or roll back together.
 *  - same identity            -> keep serving; just refresh the credential / validation time ("unchanged")
 *  - nothing to re-embed      -> switch the active configuration right away ("activated")
 *  - READY documents exist    -> keep the active configuration, build the new index in the background ("reindexing")
 */
export async function applyEmbeddingTarget(tx: Tx, userId: string, credentialId: string, target: ReindexTarget, now: Date): Promise<ApplyResult> {
  const activeRow = await tx.modelPreference.findUnique({ where: { userId_task: { userId, task: "EMBEDDING" } }, include: { credential: { select: { provider: true } } } });
  const targetId: EmbeddingIdentity = { provider: target.provider, model: target.modelId, dimension: target.dimension };
  const activeId: EmbeddingIdentity | null = activeRow ? { provider: activeRow.credential.provider, model: activeRow.modelId, dimension: activeRow.embeddingDimension ?? LEGACY_DIMENSION } : null;
  const activate = (data: { credentialId: string }) =>
    tx.modelPreference.upsert({
      where: { userId_task: { userId, task: "EMBEDDING" } },
      create: { userId, task: "EMBEDDING", credentialId: data.credentialId, modelId: target.modelId, validatedAt: now, embeddingDimension: target.dimension, embeddingRequestDimensions: target.requestDimensions },
      update: { credentialId: data.credentialId, modelId: target.modelId, validatedAt: now, embeddingDimension: target.dimension, embeddingRequestDimensions: target.requestDimensions },
    });

  const docs = await tx.document.findMany({
    where: { ownerId: userId, status: "READY" },
    select: { id: true, processingVersion: true, embeddingProvider: true, embeddingModel: true, embeddingDimension: true },
    take: 5000,
  });
  const needing = docs.filter((d) => !sameIdentity(docIdentity(d), targetId));

  if (activeId && sameIdentity(activeId, targetId) && activeRow?.embeddingRequestDimensions === target.requestDimensions) {
    await supersede(tx, userId); // switching back to what is already active abandons any pending build
    await activate({ credentialId });
    return { status: "unchanged", documents: needing.length };
  }
  if (needing.length === 0) {
    await supersede(tx, userId);
    await activate({ credentialId });
    return { status: "activated", documents: 0 };
  }

  // Same target already being built: leave it running (a second save must not restart hours of embedding work).
  const building = await tx.embeddingReindex.findFirst({ where: { userId, status: "BUILDING" } });
  if (building && sameIdentity(targetOf(building), targetId) && building.requestDimensions === target.requestDimensions) {
    return { status: "reindexing", documents: needing.length };
  }
  await supersede(tx, userId);
  const row = await tx
    .embeddingReindex.create({ data: { userId, provider: target.provider, modelId: target.modelId, dimension: target.dimension, requestDimensions: target.requestDimensions } })
    .catch((err: unknown) => {
      // The partial unique index (one BUILDING per user) fired: another save for this user committed first.
      if ((err as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "Another change to your embedding settings is being applied. Wait a moment and try again.");
      throw err;
    });
  for (const d of needing) {
    await enqueue(tx, { type: "reindex-document", payload: { reindexId: row.id, documentId: d.id, version: d.processingVersion }, dedupeKey: jobKey(row.id, d.id, d.processingVersion), maxAttempts: 4 });
  }
  await enqueue(tx, { type: "reindex-finalize", payload: { reindexId: row.id }, dedupeKey: finalizeKey(row.id), maxAttempts: FINALIZE_MAX_ATTEMPTS, runAt: new Date(Date.now() + 2000) });
  return { status: "reindexing", documents: needing.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// User actions + view
// ---------------------------------------------------------------------------------------------------------------------------------
export async function getReindexView(userId: string): Promise<ReindexView | null> {
  const r = await db.embeddingReindex.findFirst({ where: { userId, status: { in: ["BUILDING", "FAILED"] } }, orderBy: { createdAt: "desc" } });
  if (!r) return null;
  const rows = await coverage(db, userId, targetOf(r));
  const ready = rows.filter((x) => x.status === "READY");
  return {
    id: r.id,
    status: r.status as "BUILDING" | "FAILED",
    provider: toWire(r.provider),
    modelId: r.modelId,
    dimension: r.dimension,
    progress: { total: ready.length, done: ready.filter((x) => x.done).length },
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Abandons an unfinished build (BUILDING or FAILED) and deletes its staged chunks. The active index is never touched. Idempotent. */
export async function cancelEmbeddingReindex(userId: string): Promise<boolean> {
  const done = await db.$transaction((tx) => supersede(tx, userId));
  if (done.length) await recordAudit({ actorId: userId, action: "ai.embedding_reindex_cancelled", targetType: "user", targetId: userId, metadata: { provider: done[0]!.provider, dimension: done[0]!.dimension } });
  return done.length > 0;
}

/** Starts a new build with the failed one's target. Only valid while a FAILED build exists. */
export async function retryEmbeddingReindex(userId: string): Promise<ApplyResult> {
  const failed = await db.embeddingReindex.findFirst({ where: { userId, status: "FAILED" }, orderBy: { createdAt: "desc" } });
  if (!failed) throw new AppError("CONFLICT", "There is no failed re-index to retry.");
  const cred = await db.providerCredential.findUnique({ where: { userId_provider: { userId, provider: failed.provider } }, select: { id: true } });
  if (!cred) throw new AppError("NOT_CONFIGURED", failureMessage("KEY_MISSING"));
  const result = await db.$transaction((tx) => applyEmbeddingTarget(tx, userId, cred.id, { provider: failed.provider, modelId: failed.modelId, dimension: failed.dimension, requestDimensions: failed.requestDimensions }, new Date()));
  await recordAudit({ actorId: userId, action: "ai.embedding_reindex_started", targetType: "user", targetId: userId, metadata: { provider: failed.provider, dimension: failed.dimension, status: result.status, count: result.documents } });
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------------------------------------------
async function failReindex(reindexId: string, code: string): Promise<void> {
  const r = await db.embeddingReindex.findUnique({ where: { id: reindexId } });
  if (!r || r.status !== "BUILDING") return;
  await db.$transaction(async (tx) => {
    await tx.embeddingReindex.update({ where: { id: r.id }, data: { status: "FAILED", errorCode: code, errorMessage: failureMessage(code), finishedAt: new Date() } });
    await purgeStaged(tx, r.userId, targetOf(r));
  });
  logger.warn("ai.reindex.failed", { reindexId, code });
  await recordAudit({ actorId: r.userId, action: "ai.embedding_reindex_failed", targetType: "user", targetId: r.userId, metadata: { provider: r.provider, dimension: r.dimension, reason: code } });
}

async function requestFinalize(reindexId: string): Promise<void> {
  await enqueue(db, { type: "reindex-finalize", payload: { reindexId }, dedupeKey: finalizeKey(reindexId), maxAttempts: 40 });
}

type JobLike = { id?: string; attempts: number; maxAttempts: number };

/** Errors that mean "the service is busy / restarting", not "this build is wrong": waiting must not use up the attempt budget. */
const WAIT_CODES = new Set(["BUSY", "UPSTREAM_UNAVAILABLE"]);

/** Re-embeds one document's stored chunk texts into the staged set. */
export async function reindexDocument(rag: RagAgentClient, reindexId: string, documentId: string, job: JobLike, signal?: AbortSignal): Promise<void> {
  const r = await db.embeddingReindex.findUnique({ where: { id: reindexId } });
  if (!r || r.status !== "BUILDING") return; // cancelled, failed or finished meanwhile
  const doc = await db.document.findFirst({ where: { id: documentId, ownerId: r.userId } });
  if (!doc || doc.status !== "READY") return void (await requestFinalize(reindexId)); // deleted/changed: finalize re-plans
  const target = targetOf(r);
  if (sameIdentity(docIdentity(doc), target)) return void (await requestFinalize(reindexId));

  const key = await getDecryptedKey(r.userId, r.provider).then((k) => k.key).catch(() => "");
  if (!key) return failReindex(reindexId, "KEY_MISSING");
  const source = docIdentity(doc);
  try {
    const res = await rag.reindex(
      {
        document_id: doc.id,
        owner_id: r.userId,
        processing_version: doc.processingVersion,
        source: { provider: source.provider ? toWire(source.provider) : "unknown", model: source.model ?? "", dimension: source.dimension },
        target: { provider: toWire(r.provider), api_key: key, model: r.modelId, dimension: r.dimension, ...(r.requestDimensions ? { request_dimensions: r.requestDimensions } : {}) },
      },
      signal,
    );
    recordProviderEvent(r.provider, "embedding", true, null);
    if (res.status === "READY" && res.embedding_dimension !== null && res.embedding_dimension !== r.dimension) return failReindex(reindexId, "EMBEDDING_DIMENSION_MISMATCH");
    if (res.status === "STALE") {
      // Nothing was written. If the document moved to a new version, finalize queues it again for that version; if it did NOT change,
      // its stored chunks are gone and trying again could never succeed, so say so instead of looping.
      const now = await db.document.findFirst({ where: { id: doc.id, ownerId: r.userId }, select: { processingVersion: true, status: true } });
      if (now && now.status === "READY" && now.processingVersion === doc.processingVersion) return failReindex(reindexId, "SOURCE_MISSING");
    }
  } catch (err) {
    if (!(err instanceof RagAgentError)) throw err;
    recordProviderEvent(r.provider, "embedding", false, err.code);
    if (err.code === "PROVIDER_AUTH_INVALID") {
      const cred = await db.providerCredential.findUnique({ where: { userId_provider: { userId: r.userId, provider: r.provider } }, select: { id: true } });
      if (cred) await markCredentialInvalid(cred.id);
    }
    if (err.retryable && WAIT_CODES.has(err.code)) {
      // Not counted against the attempts: the whole build is bounded by finalize's own timeout, and a busy/restarting service is not a failure.
      if (job.id) await db.job.update({ where: { id: job.id }, data: { attempts: { decrement: 1 } } }).catch(() => undefined);
      throw new RetryableJobError(err.code, Math.max(err.retryAfterSeconds ?? 0, 10) * 1000);
    }
    if (err.retryable && job.attempts < job.maxAttempts) throw new RetryableJobError(err.code, err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : undefined);
    return failReindex(reindexId, err.code);
  }
  await requestFinalize(reindexId);
}

/** Plans the remaining work or, when the database confirms the new index is complete, switches to it. Polls while work is outstanding. */
export async function finalizeReindex(reindexId: string, job: JobLike): Promise<void> {
  const r = await db.embeddingReindex.findUnique({ where: { id: reindexId } });
  if (!r || r.status !== "BUILDING") return;
  const wait = async (why: string): Promise<void> => {
    if (job.attempts >= job.maxAttempts) return failReindex(reindexId, "BUILD_TIMEOUT");
    throw new RetryableJobError(why, FINALIZE_POLL_MS);
  };

  // A document job that died for a reason nobody handled would otherwise leave this build waiting forever.
  const crashed = await db.job.count({ where: { type: "reindex-document", status: "FAILED", payload: { path: ["reindexId"], equals: reindexId } } });
  if (crashed > 0) return failReindex(reindexId, "INTERNAL");

  const rows = await coverage(db, r.userId, targetOf(r));
  const missing = rows.filter((x) => x.status === "READY" && !x.done);
  if (missing.length) {
    // Documents added or re-processed during the build: give each its own job (deduplicated per document version).
    for (const d of missing) {
      // A job for exactly this document version already reported success, yet the database does not show a complete set: embedding it
      // again would only repeat (and bill) the same outcome. Stop and say so.
      const reported = await db.job.count({
        where: { type: "reindex-document", status: "SUCCEEDED", AND: [{ payload: { path: ["reindexId"], equals: reindexId } }, { payload: { path: ["documentId"], equals: d.id } }, { payload: { path: ["version"], equals: d.processingVersion } }] },
      });
      if (reported > 0) return failReindex(reindexId, "VERIFICATION_FAILED");
      await enqueue(db, { type: "reindex-document", payload: { reindexId, documentId: d.id, version: d.processingVersion }, dedupeKey: jobKey(reindexId, d.id, d.processingVersion), maxAttempts: 4 });
    }
    return wait("documents still being re-indexed");
  }
  if (rows.some((x) => x.status !== "READY")) return wait("documents still processing");
  if ((await activate(reindexId)) === "retry") return wait("documents changed during activation");
}

/** The atomic switch. Re-verifies everything under a lock; returns "retry" (nothing changed) if the world moved. */
async function activate(reindexId: string): Promise<"activated" | "retry" | "skipped"> {
  const result = await db.$transaction(async (tx): Promise<"activated" | "retry" | "skipped"> => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "EmbeddingReindex" WHERE "id" = ${reindexId} AND "status" = 'BUILDING' FOR UPDATE`;
    if (locked.length === 0) return "skipped";
    const r = await tx.embeddingReindex.findUniqueOrThrow({ where: { id: reindexId } });
    // Serialise with status changes of this user's documents (retry / delete) for the duration of the switch.
    await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "ownerId" = ${r.userId} FOR UPDATE`;
    const t = targetOf(r);
    const rows = await coverage(tx, r.userId, t);
    if (rows.some((x) => x.status !== "READY" || !x.done)) return "retry";
    const cred = await tx.providerCredential.findUnique({ where: { userId_provider: { userId: r.userId, provider: r.provider } }, select: { id: true } });
    if (!cred) return "skipped";

    const now = new Date();
    await tx.modelPreference.upsert({
      where: { userId_task: { userId: r.userId, task: "EMBEDDING" } },
      create: { userId: r.userId, task: "EMBEDDING", credentialId: cred.id, modelId: r.modelId, validatedAt: now, embeddingDimension: r.dimension, embeddingRequestDimensions: r.requestDimensions },
      update: { credentialId: cred.id, modelId: r.modelId, validatedAt: now, embeddingDimension: r.dimension, embeddingRequestDimensions: r.requestDimensions },
    });
    const provider = toWire(r.provider);
    // The documents' recorded identity moves to the target, and only then do the old identity's chunks go.
    await tx.document.updateMany({ where: { ownerId: r.userId, status: "READY" }, data: { embeddingProvider: r.provider, embeddingModel: r.modelId, embeddingDimension: r.dimension } });
    await deleteChunks(tx, r.userId, Prisma.sql`
      DELETE FROM "DocumentChunk" c USING "Document" d
      WHERE c."documentId" = d."id" AND d."ownerId" = ${r.userId} AND d."status" = 'READY'
        AND NOT (c."embeddingModel" = ${r.modelId} AND c."embeddingProvider" = ${provider} AND c."embeddingDimension" = ${r.dimension})`);
    await tx.embeddingReindex.update({ where: { id: r.id }, data: { status: "ACTIVATED", finishedAt: now, errorCode: null, errorMessage: null } });
    return "activated";
  });
  if (result === "activated") {
    const r = await db.embeddingReindex.findUnique({ where: { id: reindexId }, select: { userId: true, provider: true, dimension: true } });
    if (r) await recordAudit({ actorId: r.userId, action: "ai.embedding_reindex_activated", targetType: "user", targetId: r.userId, metadata: { provider: r.provider, dimension: r.dimension } });
  }
  return result;
}

export function reindexHandlers(rag: RagAgentClient): Handlers {
  return {
    "reindex-document": async (job, signal) => {
      const { reindexId, documentId } = job.payload as { reindexId: string; documentId: string };
      await reindexDocument(rag, reindexId, documentId, { id: job.id, attempts: job.attempts, maxAttempts: job.maxAttempts }, signal);
    },
    "reindex-finalize": async (job) => {
      const { reindexId } = job.payload as { reindexId: string };
      await finalizeReindex(reindexId, job);
    },
  };
}
