import type { AiProvider, DocumentStatus } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { resolveModel } from "./preferences.js";

/**
 * Embedding identity = provider + model + vector dimension (AI_CONNECTION_SPEC §3). Equal dimensions do NOT make two models
 * interchangeable, so a document is searchable only when its recorded identity equals the user's current embedding configuration.
 * Legacy rows (before the dimension was recorded) are 1536-dimensional by construction: the column is vector(1536) and rag_agent
 * verifies the length of every vector it stores.
 */
export const EXPECTED_DIMENSION = 1536;

export type EmbeddingIdentity = { provider: AiProvider | null; model: string | null; dimension: number };
type DocIdentityFields = { embeddingProvider: AiProvider | null; embeddingModel: string | null; embeddingDimension: number | null };

export const docIdentity = (d: DocIdentityFields): EmbeddingIdentity => ({ provider: d.embeddingProvider, model: d.embeddingModel, dimension: d.embeddingDimension ?? EXPECTED_DIMENSION });
export const sameIdentity = (a: EmbeddingIdentity, b: EmbeddingIdentity) => a.provider === b.provider && a.model === b.model && a.dimension === b.dimension;

/** The user's current embedding identity (null when no embedding model is configured). */
export async function currentEmbeddingIdentity(userId: string): Promise<EmbeddingIdentity | null> {
  const emb = await resolveModel(userId, "EMBEDDING");
  return emb ? { provider: emb.provider, model: emb.modelId, dimension: emb.embeddingDimension ?? EXPECTED_DIMENSION } : null;
}

/** Searchable under `current`: processed (READY) and indexed with exactly this identity. */
export const isCompatible = (d: DocIdentityFields & { status: DocumentStatus }, current: EmbeddingIdentity): boolean => d.status === "READY" && sameIdentity(docIdentity(d), current);
/** Needs re-embedding: processed under a different identity. (Documents still processing/failed are not "stale".) */
export const isStale = (d: DocIdentityFields & { status: DocumentStatus }, current: EmbeddingIdentity | null): boolean =>
  current !== null && d.status === "READY" && !sameIdentity(docIdentity(d), current);

export const STALE_DOCUMENTS_MESSAGE =
  "Your documents were indexed with a different embedding model than the one in your AI connection settings. Open Documents and choose “Re-embed”, or switch your embedding model back in Settings.";
export const STALE_SOME_DOCUMENTS_WARNING = "Some documents were skipped because they were indexed with a different embedding model. Re-embed them from the Documents page to search them again.";
export const DIMENSION_MISMATCH_MESSAGE = `This embedding model produces vectors that this installation can't store (it expects ${EXPECTED_DIMENSION} dimensions). Choose a ${EXPECTED_DIMENSION}-dimension embedding model in your AI connection settings.`;

export const documentIdentitySelect = { id: true, status: true, embeddingProvider: true, embeddingModel: true, embeddingDimension: true } as const;

/** Counts for the connection summary: stale = READY with another identity; processing = queued or running. */
export async function documentCounts(userId: string, current: EmbeddingIdentity | null) {
  const rows = await db.document.findMany({ where: { ownerId: userId }, select: documentIdentitySelect, take: 2000 });
  return {
    ready: rows.filter((r) => r.status === "READY").length,
    stale: rows.filter((r) => isStale(r, current)).length,
    processing: rows.filter((r) => r.status === "QUEUED" || r.status === "PROCESSING").length,
  };
}

/** User-facing text for rag_agent error codes that need app-specific guidance (the code itself is unchanged). */
export const guidanceFor = (code: string, message: string): string => (code === "EMBEDDING_DIMENSION_MISMATCH" ? DIMENSION_MISMATCH_MESSAGE : message);
