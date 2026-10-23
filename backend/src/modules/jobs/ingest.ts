import type { RagAgentClient } from "../../clients/rag-agent.js";
import { recordProviderEvent } from "../../lib/metrics.js";
import { RagAgentError } from "../../clients/rag-agent.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { DIMENSION_MISMATCH_MESSAGE, embeddingCredentials, LEGACY_DIMENSION } from "../ai/embedding-identity.js";
import { getDecryptedKey, markCredentialInvalid } from "../ai/credentials.js";
import { resolveModel } from "../ai/preferences.js";
import { StorageError, type Storage } from "../documents/storage/types.js";
import { deleteStoredObject } from "../documents/service.js";
import { queueSupersededVectors } from "../vectors/store.js";
import type { Handlers } from "./worker.js";
import { RetryableJobError } from "./queue.js";

/** User-facing explanations for expected ingestion failures (never contain upstream bodies or keys). */
const MESSAGES: Record<string, string> = {
  EMBEDDING_NOT_CONFIGURED: "Choose an embedding model in Settings → AI connection, then retry.",
  PROVIDER_AUTH_INVALID: "Your embedding provider rejected the API key. Update it in Settings, then retry.",
  MODEL_NOT_FOUND: "The selected embedding model wasn't found for your key. Choose another in Settings, then retry.",
  PROVIDER_RATE_LIMITED: "The embedding provider is rate-limiting requests. Wait a few minutes, then retry.",
  PROVIDER_TIMEOUT: "The embedding provider timed out. Retry in a moment.",
  PROVIDER_UNAVAILABLE: "The embedding provider is unavailable right now. Retry in a moment.",
  UPSTREAM_UNAVAILABLE: "The document processing service is unavailable. Retry in a moment.",
  EMBEDDING_DIMENSION_MISMATCH: DIMENSION_MISMATCH_MESSAGE,
  EMBEDDING_DIMENSION_UNSUPPORTED: DIMENSION_MISMATCH_MESSAGE,
  BUSY: "Document processing is busy. It will be retried automatically.",
  VECTOR_DIMENSION_UNSUPPORTED: "This installation's document search index doesn't support this embedding size. Choose an embedding model or size it supports in Settings → AI connection, then retry.",
  VECTOR_STORE_UNAVAILABLE: "The document search index is temporarily unavailable. Retry in a moment.",
  VECTOR_STORE_RATE_LIMITED: "The document search index is busy. Retry in a moment.",
  VECTOR_STORE_AUTH: "Document indexing is not configured correctly on the server. Contact the administrator, then retry.",
  VECTOR_STORE_ERROR: "Document indexing is not configured correctly on the server. Contact the administrator, then retry.",
  VECTOR_STORE_SCHEMA_NOT_READY: "Document indexing is not configured correctly on the server. Contact the administrator, then retry.",
};

async function failDocument(id: string, code: string, message?: string | null) {
  await db.document.updateMany({
    where: { id },
    data: { status: "FAILED", progress: 0, statusCode: code, statusDetail: MESSAGES[code] ?? message ?? "This document could not be processed." },
  });
}

export function ingestHandlers(rag: RagAgentClient, storage: Storage): Handlers {
  return {
    "delete-object": async (job) => {
      const { key } = job.payload as { key: string };
      try {
        await deleteStoredObject(storage, key);
      } catch {
        throw new RetryableJobError("storage delete failed");
      }
    },

    ingest: async (job, signal) => {
      const { documentId } = job.payload as { documentId: string };
      const doc = await db.document.findUnique({ where: { id: documentId } });
      if (!doc) return; // deleted while queued: nothing to do

      const embedding = await resolveModel(doc.ownerId, "EMBEDDING");
      if (!embedding) return failDocument(doc.id, "EMBEDDING_NOT_CONFIGURED");
      const { key } = await getDecryptedKey(doc.ownerId, embedding.provider).catch(() => ({ key: "" }));
      if (!key) return failDocument(doc.id, "EMBEDDING_NOT_CONFIGURED");

      await db.document.update({ where: { id: doc.id }, data: { status: "PROCESSING", progress: 5, statusCode: null, statusDetail: null } });

      let bytes: Uint8Array;
      try {
        bytes = await storage.get(doc.storageKey);
      } catch (err) {
        logger.error("ingest.storage_read_failed", { documentId: doc.id, err });
        // Provider hiccups (rate limit, timeout, 5xx) are retried with the job's backoff instead of failing the document for good.
        if (err instanceof StorageError && err.retryable && job.attempts < job.maxAttempts) {
          await db.document.updateMany({ where: { id: doc.id }, data: { status: "QUEUED", progress: 0 } });
          throw new RetryableJobError(`STORAGE_${err.code}`);
        }
        return failDocument(doc.id, "STORAGE_ERROR", "The stored file could not be read. Please upload it again.");
      }

      try {
        const result = await rag.ingest(
          {
            document_id: doc.id,
            owner_id: doc.ownerId,
            filename: doc.name,
            mime_type: doc.mimeType,
            processing_version: doc.processingVersion + 1,
            embedding: embeddingCredentials(embedding, key),
          },
          bytes,
          (_stage, progress) => void db.document.updateMany({ where: { id: doc.id, status: "PROCESSING" }, data: { progress: Math.min(99, Math.max(0, progress)) } }).catch(() => undefined),
          signal,
        );

        recordProviderEvent(embedding.provider, "embedding", result.type !== "error", result.type === "error" ? result.code : null);
        if (result.type === "error") {
          if (result.code === "PROVIDER_AUTH_INVALID") await markCredentialInvalid(embedding.credentialId);
          if (result.retryable && job.attempts < job.maxAttempts) {
            await db.document.updateMany({ where: { id: doc.id }, data: { status: "QUEUED", progress: 0 } });
            throw new RetryableJobError(result.code, (result.retry_after_seconds ?? 0) * 1000 || undefined);
          }
          return failDocument(doc.id, result.code, result.message);
        }

        // rag_agent checks every vector against the dimension it was given; this keeps the invariant even if that contract ever changes.
        const configured = embedding.embeddingDimension ?? LEGACY_DIMENSION;
        const measured = result.type === "result" ? (result.embedding_dimension ?? configured) : configured;
        if (result.status === "READY" && measured !== configured) return failDocument(doc.id, "EMBEDDING_DIMENSION_MISMATCH");
        if (result.status === "READY") {
          // The previous version's rows are already gone from PostgreSQL; its vectors in a remote store are removed by a retried job that is
          // committed together with the READY status (so it exists exactly when the new version is live).
          await db.$transaction(async (tx) => {
            await tx.document.updateMany({
              where: { id: doc.id },
              data: {
                status: "READY",
                progress: 100,
                statusCode: null,
                statusDetail: null,
                pageCount: result.page_count ?? null,
                textLength: result.text_length ?? null,
                chunkCount: result.chunk_count ?? null,
                embeddingProvider: embedding.provider,
                embeddingModel: result.embedding_model ?? embedding.modelId,
                embeddingDimension: measured,
                processedAt: new Date(),
                processingVersion: doc.processingVersion + 1,
              },
            });
            await queueSupersededVectors(tx, doc.ownerId, result.superseded);
          });
        } else {
          await db.document.updateMany({
            where: { id: doc.id },
            data: { status: result.status, progress: 0, statusCode: result.code ?? result.status, statusDetail: result.message ?? "This document could not be processed." },
          });
        }
      } catch (err) {
        if (err instanceof RetryableJobError) throw err;
        if (err instanceof RagAgentError) {
          recordProviderEvent(embedding.provider, "embedding", false, err.code);
          if (err.retryable && job.attempts < job.maxAttempts) {
            await db.document.updateMany({ where: { id: doc.id }, data: { status: "QUEUED", progress: 0 } });
            throw new RetryableJobError(err.code, err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : undefined);
          }
          return failDocument(doc.id, err.code, err.message);
        }
        throw err;
      }
    },
  };
}
