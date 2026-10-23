import type { AiProvider, DocumentStatus } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { resolveModel, type ResolvedModel } from "./preferences.js";
import { toWire } from "./providers.js";
import type { EmbeddingCredentials } from "../../clients/rag-agent.js";

/**
 * Embedding identity = provider + model + vector dimension (AI_CONNECTION_SPEC §3, EMBEDDING_SETTINGS_SPEC §1). Equal dimensions do NOT
 * make two models interchangeable, so a document is searchable only when its recorded identity equals the user's current embedding
 * configuration.
 *
 * Application limits for a configurable dimension. pgvector itself stores up to 16 000 per vector; the generated "embeddingDimension"
 * column and the EmbeddingReindex CHECK enforce 1..16000 in the database, these are the narrower caps the application accepts.
 */
export const MIN_EMBEDDING_DIMENSION = 8;
export const MAX_EMBEDDING_DIMENSION = 4096;
export const DIMENSION_LIMITS = { min: MIN_EMBEDDING_DIMENSION, max: MAX_EMBEDDING_DIMENSION } as const;
export const isValidDimension = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= MIN_EMBEDDING_DIMENSION && n <= MAX_EMBEDDING_DIMENSION;

/**
 * Rows written before the dimension was recorded are 1536-dimensional by construction: the column was vector(1536) and rag_agent
 * verified the length of every vector it stored. This is a historical fact used for those rows only, NOT a default for new ones.
 */
export const LEGACY_DIMENSION = 1536;

/** Where a candidate configuration's dimension came from (EMBEDDING_SETTINGS_SPEC §2). */
export type DimensionSource = "request" | "database" | "environment" | "model";

/**
 * Pure precedence rule. `input`: undefined = the field was omitted, null = "Automatic", number = typed value.
 * A value saved in the database wins over the deployment default, but only for the model it was verified for.
 */
export function resolveRequestedDimension(
  input: number | null | undefined,
  saved: { modelId: string; dimension: number | null } | null,
  candidateModelId: string,
  envDefault: number | null,
): { requested: number | null; source: DimensionSource } {
  if (typeof input === "number") return { requested: input, source: "request" };
  if (input === undefined && saved && saved.modelId === candidateModelId && saved.dimension !== null) return { requested: saved.dimension, source: "database" };
  if (envDefault !== null) return { requested: envDefault, source: "environment" };
  return { requested: null, source: "model" };
}

export type EmbeddingIdentity = { provider: AiProvider | null; model: string | null; dimension: number };
type DocIdentityFields = { embeddingProvider: AiProvider | null; embeddingModel: string | null; embeddingDimension: number | null };

export const docIdentity = (d: DocIdentityFields): EmbeddingIdentity => ({ provider: d.embeddingProvider, model: d.embeddingModel, dimension: d.embeddingDimension ?? LEGACY_DIMENSION });
export const sameIdentity = (a: EmbeddingIdentity, b: EmbeddingIdentity) => a.provider === b.provider && a.model === b.model && a.dimension === b.dimension;

/** The user's current embedding identity (null when no embedding model is configured). */
export async function currentEmbeddingIdentity(userId: string): Promise<EmbeddingIdentity | null> {
  const emb = await resolveModel(userId, "EMBEDDING");
  return emb ? { provider: emb.provider, model: emb.modelId, dimension: emb.embeddingDimension ?? LEGACY_DIMENSION } : null;
}

/** The ACTIVE identity of a resolved EMBEDDING preference. */
export const identityOf = (emb: Pick<ResolvedModel, "provider" | "modelId" | "embeddingDimension">): EmbeddingIdentity => ({ provider: emb.provider, model: emb.modelId, dimension: emb.embeddingDimension ?? LEGACY_DIMENSION });

/** Embedding credentials for rag_agent: always names the dimension, and the `dimensions` request parameter only when it was verified. */
export function embeddingCredentials(emb: Pick<ResolvedModel, "provider" | "modelId" | "embeddingDimension" | "embeddingRequestDimensions">, apiKey: string): EmbeddingCredentials {
  const dimension = emb.embeddingDimension ?? LEGACY_DIMENSION;
  return { provider: toWire(emb.provider), api_key: apiKey, model: emb.modelId, dimension, ...(emb.embeddingRequestDimensions ? { request_dimensions: emb.embeddingRequestDimensions } : {}) };
}

/** Searchable under `current`: processed (READY) and indexed with exactly this identity. */
export const isCompatible = (d: DocIdentityFields & { status: DocumentStatus }, current: EmbeddingIdentity): boolean => d.status === "READY" && sameIdentity(docIdentity(d), current);
/** Needs re-embedding: processed under a different identity. (Documents still processing/failed are not "stale".) */
export const isStale = (d: DocIdentityFields & { status: DocumentStatus }, current: EmbeddingIdentity | null): boolean =>
  current !== null && d.status === "READY" && !sameIdentity(docIdentity(d), current);

export const STALE_DOCUMENTS_MESSAGE =
  "Your documents were indexed with a different embedding model than the one in your AI connection settings. Open Documents and choose “Re-embed”, or switch your embedding model back in Settings.";
export const STALE_SOME_DOCUMENTS_WARNING = "Some documents were skipped because they were indexed with a different embedding model. Re-embed them from the Documents page to search them again.";
export const DIMENSION_MISMATCH_MESSAGE = "This embedding model returned vectors of a different size than the one saved in your AI connection settings. Open Settings → AI connection and test the configuration again; vectors are never padded or truncated.";

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
export const guidanceFor = (code: string, message: string): string => (code === "EMBEDDING_DIMENSION_MISMATCH" || code === "EMBEDDING_DIMENSION_UNSUPPORTED" ? DIMENSION_MISMATCH_MESSAGE : message);
