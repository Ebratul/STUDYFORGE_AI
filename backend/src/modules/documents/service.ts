import { createHash } from "node:crypto";
import type { Document, DocumentStatus, Prisma } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { signToken, verifyToken } from "../../lib/crypto.js";
import { getEnv } from "../../config/env.js";
import type { SessionUser } from "../../auth/types.js";
import { currentEmbeddingIdentity, isStale, sameIdentity, docIdentity, type EmbeddingIdentity } from "../ai/embedding-identity.js";
import { enqueue } from "../jobs/queue.js";
import { queueDeleteDocumentVectors } from "../vectors/store.js";
import { getLimits } from "./limits.js";
import { StorageError, type Storage } from "./storage/types.js";
import { validateUpload } from "./validation.js";

export type DocumentView = {
  id: string;
  name: string;
  extension: string;
  sizeBytes: number;
  status: DocumentStatus;
  statusCode: string | null;
  statusDetail: string | null;
  progress: number;
  pageCount: number | null;
  chunkCount: number | null;
  embeddingModel: string | null;
  /** Measured length of the stored vectors (null while unprocessed). */
  embeddingDimension: number | null;
  /** READY but indexed with a different embedding model/provider/dimension than the current configuration: excluded from search until re-embedded. */
  embeddingStale: boolean;
  createdAt: string;
  processedAt: string | null;
};

export function toView(d: Document, current: EmbeddingIdentity | null = null): DocumentView {
  // storageKey / sha256 / owner id are deliberately not part of the view.
  return {
    id: d.id,
    name: d.name,
    extension: d.extension,
    sizeBytes: d.sizeBytes,
    status: d.status,
    statusCode: d.statusCode,
    statusDetail: d.statusDetail,
    progress: d.progress,
    pageCount: d.pageCount,
    chunkCount: d.chunkCount,
    embeddingModel: d.embeddingModel,
    embeddingDimension: d.embeddingDimension,
    embeddingStale: isStale(d, current),
    createdAt: d.createdAt.toISOString(),
    processedAt: d.processedAt?.toISOString() ?? null,
  };
}

export type UploadFile = { name: string; type: string; bytes: Uint8Array };
export type UploadResult = {
  filename: string;
  ok: boolean;
  duplicate?: boolean;
  document?: DocumentView;
  error?: { code: string; message: string };
};

export async function getUsage(user: SessionUser) {
  const agg = await db.document.aggregate({ where: { ownerId: user.id }, _sum: { sizeBytes: true }, _count: true });
  return { usedBytes: agg._sum.sizeBytes ?? 0, count: agg._count };
}

export async function listDocuments(user: SessionUser, opts: { ids?: string[] } = {}): Promise<DocumentView[]> {
  const rows = await db.document.findMany({
    where: { ownerId: user.id, ...(opts.ids ? { id: { in: opts.ids } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const current = await currentEmbeddingIdentity(user.id);
  return rows.map((r) => toView(r, current));
}

/** Ownership is part of the WHERE: foreign and missing ids are indistinguishable (404). */
async function ownedDocument(user: SessionUser, id: string): Promise<Document> {
  const doc = await db.document.findFirst({ where: { id, ownerId: user.id } });
  if (!doc) throw Errors.notFound();
  return doc;
}

export async function getDocument(user: SessionUser, id: string) {
  return toView(await ownedDocument(user, id), await currentEmbeddingIdentity(user.id));
}

export async function uploadDocuments(storage: Storage, user: SessionUser, files: UploadFile[]): Promise<UploadResult[]> {
  const limits = getLimits();
  if (files.length === 0) throw new AppError("VALIDATION", "Choose at least one file.");
  if (files.length > limits.maxFilesPerUpload) {
    throw new AppError("VALIDATION", `You can upload up to ${limits.maxFilesPerUpload} files at a time.`, { maxFilesPerUpload: limits.maxFilesPerUpload });
  }
  const results: UploadResult[] = [];
  for (const file of files) {
    try {
      results.push(await uploadOne(storage, user, file));
    } catch (err) {
      if (err instanceof AppError) results.push({ filename: file.name, ok: false, error: { code: err.code, message: err.message } });
      else if (err instanceof StorageError) {
        const e = storageFailure(err);
        results.push({ filename: file.name, ok: false, error: { code: e.code, message: e.message } });
      } else {
        logger.error("document.upload_failed", { err });
        results.push({ filename: file.name, ok: false, error: { code: "INTERNAL", message: "That file could not be saved. Please try again." } });
      }
    }
  }
  return results;
}

/** Storage backend failures as user-facing errors (StorageError messages are already sanitized). */
function storageFailure(err: StorageError): AppError {
  if (err.code === "FILE_TOO_LARGE") return new AppError("VALIDATION", "This file is larger than the file storage plan allows. Try a smaller file or contact the administrator.");
  return new AppError("STORAGE_UNAVAILABLE", err.message, { retryable: err.retryable });
}

async function uploadOne(storage: Storage, user: SessionUser, file: UploadFile): Promise<UploadResult> {
  const limits = getLimits();
  const v = validateUpload(file.name, file.type, file.bytes);

  const usage = await getUsage(user);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const existing = await db.document.findUnique({ where: { ownerId_sha256: { ownerId: user.id, sha256 } } });
  if (existing) return { filename: file.name, ok: true, duplicate: true, document: toView(existing) };

  if (usage.count >= limits.maxDocuments) throw new AppError("STORAGE_QUOTA_EXCEEDED", `You've reached the limit of ${limits.maxDocuments} documents. Delete some to upload more.`);
  if (usage.usedBytes + file.bytes.byteLength > limits.storageQuotaBytes) {
    throw new AppError("STORAGE_QUOTA_EXCEEDED", "This upload would exceed your storage quota. Delete some documents to free up space.", {
      usedBytes: usage.usedBytes,
      quotaBytes: limits.storageQuotaBytes,
    });
  }

  const storageKey = storage.newKey(user.id);
  try {
    await storage.put(storageKey, file.bytes, v.mimeType);
  } catch (err) {
    // A timeout can happen after the provider stored the object; the delete is idempotent, so queue it rather than risk an orphan.
    if (err instanceof StorageError && err.code === "UNAVAILABLE") await db.job.create({ data: { type: "delete-object", payload: { key: storageKey }, maxAttempts: 6 } }).catch(() => undefined);
    throw err;
  }
  try {
    const doc = await db.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: { ownerId: user.id, name: v.displayName, extension: v.ext, mimeType: v.mimeType, sizeBytes: file.bytes.byteLength, sha256, storageKey, status: "QUEUED" },
      });
      await enqueue(tx, { type: "ingest", payload: { documentId: created.id }, dedupeKey: `ingest:${created.id}`, maxAttempts: 4 });
      return created;
    });
    await recordAudit({ actorId: user.id, action: "document.uploaded", targetType: "document", targetId: doc.id, metadata: { ext: v.ext, bytes: file.bytes.byteLength } });
    return { filename: file.name, ok: true, document: toView(doc) };
  } catch (err) {
    // The row was never created, so nothing references this object: remove it now, or hand it to the retrying cleanup job.
    await storage.delete(storageKey).catch(() => db.job.create({ data: { type: "delete-object", payload: { key: storageKey }, maxAttempts: 6 } }).catch(() => undefined));
    if ((err as { code?: string }).code === "P2002") {
      // Lost a race with an identical concurrent upload: return the winner.
      const winner = await db.document.findUnique({ where: { ownerId_sha256: { ownerId: user.id, sha256 } } });
      if (winner) return { filename: file.name, ok: true, duplicate: true, document: toView(winner) };
    }
    throw err;
  }
}

/** Puts a document back in the ingestion queue (idempotent through the job dedupe key). Returns false when it is already queued/running. */
async function queueReprocess(tx: Prisma.TransactionClient, docId: string): Promise<boolean> {
  const jobId = await enqueue(tx, { type: "ingest", payload: { documentId: docId }, dedupeKey: `ingest:${docId}`, maxAttempts: 4 });
  if (!jobId) return false;
  await tx.document.update({ where: { id: docId }, data: { status: "QUEUED", progress: 0, statusCode: null, statusDetail: null } });
  return true;
}

export async function retryDocument(user: SessionUser, id: string): Promise<DocumentView> {
  const doc = await ownedDocument(user, id);
  // READY documents may be reprocessed (e.g. after changing the embedding model); in-flight ones may not.
  if (doc.status === "QUEUED" || doc.status === "PROCESSING") throw new AppError("CONFLICT", "This document is already being processed.");
  const updated = await db.$transaction(async (tx) => {
    if (!(await queueReprocess(tx, doc.id))) throw new AppError("CONFLICT", "This document is already being processed.");
    return tx.document.findUniqueOrThrow({ where: { id: doc.id } });
  });
  return toView(updated, await currentEmbeddingIdentity(user.id));
}

const REEMBED_MAX = 200;

/**
 * Re-embeds the caller's documents whose recorded embedding identity differs from the current configuration (AI_CONNECTION_SPEC §2).
 * Reuses the normal ingestion job: ids, owner, names and permissions are untouched, and rag_agent writes the new chunks under a new
 * `processingVersion` and switches atomically only when the new set is complete — the previous chunks stay until then.
 */
export async function reembedDocuments(user: SessionUser): Promise<{ queued: number; skipped: number }> {
  const current = await currentEmbeddingIdentity(user.id);
  if (!current) throw new AppError("NOT_CONFIGURED", "Set up your AI connection (API key and embedding model) in Settings first.");
  const docs = await db.document.findMany({ where: { ownerId: user.id, status: { in: ["READY", "FAILED"] } }, orderBy: { createdAt: "asc" }, take: 2000 });
  const todo = docs.filter((d) => !(d.status === "READY" && sameIdentity(docIdentity(d), current))).slice(0, REEMBED_MAX);
  let queued = 0;
  let skipped = 0;
  for (const d of todo) {
    const ok = await db.$transaction((tx) => queueReprocess(tx, d.id));
    if (ok) queued++;
    else skipped++;
  }
  return { queued, skipped };
}

export async function deleteDocument(storage: Storage, user: SessionUser, id: string): Promise<void> {
  const doc = await ownedDocument(user, id);
  await db.$transaction(async (tx) => {
    // Chunks + embeddings and conversation links go with the row (ON DELETE CASCADE).
    const { count } = await tx.document.deleteMany({ where: { id: doc.id, ownerId: user.id } });
    if (count === 0) throw Errors.notFound();
    // Citations keep their snapshot text but stop pointing at a document that no longer exists.
    await tx.messageCitation.updateMany({ where: { documentId: doc.id }, data: { documentId: null, chunkId: null } });
    await enqueue(tx, { type: "delete-object", payload: { key: doc.storageKey }, maxAttempts: 6 });
    // Vectors held outside PostgreSQL (dual / pinecone) have nothing to cascade: queue their removal in the same transaction.
    await queueDeleteDocumentVectors(tx, user.id, doc.id);
  });
  await recordAudit({ actorId: user.id, action: "document.deleted", targetType: "document", targetId: doc.id });
}

/** Cleanup job body: removes the stored object (retried with backoff by the worker). */
export async function deleteStoredObject(storage: Storage, key: string) {
  await storage.delete(key);
}

const DOWNLOAD_PURPOSE = "document-download";

/** Issues a short-lived link. Ownership is verified here AND again when the link is used. */
export async function createDownloadLink(storage: Storage, user: SessionUser, id: string): Promise<{ url: string; expiresAt: string }> {
  const doc = await ownedDocument(user, id);
  const ttl = getEnv().DOWNLOAD_LINK_TTL_SECONDS;
  const direct = await storage.signedDownloadUrl(doc.storageKey, doc.name, ttl);
  await recordAudit({ actorId: user.id, action: "document.downloaded", targetType: "document", targetId: doc.id });
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  if (direct) return { url: direct, expiresAt };
  const token = signToken({ d: doc.id, u: user.id, exp: Math.floor(Date.now() / 1000) + ttl }, DOWNLOAD_PURPOSE);
  return { url: `/api/documents/download/${token}`, expiresAt };
}

export async function openDownload(storage: Storage, token: string): Promise<{ bytes: Uint8Array; name: string; mimeType: string }> {
  const payload = verifyToken<{ d: string; u: string; exp: number }>(token, DOWNLOAD_PURPOSE);
  if (!payload) throw Errors.notFound();
  // Re-check ownership at use time: a deleted document (or a reassigned owner) invalidates outstanding links.
  const doc = await db.document.findFirst({ where: { id: payload.d, ownerId: payload.u } });
  if (!doc) throw Errors.notFound();
  return { bytes: await storage.get(doc.storageKey), name: doc.name, mimeType: doc.mimeType };
}
