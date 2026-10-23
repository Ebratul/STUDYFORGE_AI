-- Configurable embedding dimensions with staged re-indexing.
--
-- Safe on existing data: every change is additive or a metadata-only widening, and nothing is deleted or rewritten except the
-- chunk-table backfills below, which record facts that are already true (each existing vector's own length and provider).
-- Existing vectors are NOT padded, truncated or re-computed.

-- 1. The vector column no longer fixes a length. vector(1536) -> vector keeps every stored value; all existing rows are 1536-d.
ALTER TABLE "DocumentChunk" ALTER COLUMN "embedding" TYPE vector;

-- 2. Chunk identity. The dimension is GENERATED from the vector itself, so it can never disagree with the data.
ALTER TABLE "DocumentChunk" ADD COLUMN "embeddingProvider" TEXT;
ALTER TABLE "DocumentChunk" ADD COLUMN "embeddingDimension" INTEGER GENERATED ALWAYS AS (vector_dims("embedding")) STORED;

-- Backfill the provider from the owning document (wire ids are the lower-cased AiProvider names). Chunks of documents that never
-- recorded a provider keep the explicit marker 'unknown': they can never match a real identity, so they are never searched silently.
UPDATE "DocumentChunk" c
SET "embeddingProvider" = COALESCE(lower(d."embeddingProvider"::text), 'unknown')
FROM "Document" d
WHERE d."id" = c."documentId";
UPDATE "DocumentChunk" SET "embeddingProvider" = 'unknown' WHERE "embeddingProvider" IS NULL;
ALTER TABLE "DocumentChunk" ALTER COLUMN "embeddingProvider" SET NOT NULL;

-- 3. Several identities may now coexist for one document version (active + staged), so the identity is part of the key.
DROP INDEX "DocumentChunk_documentId_processingVersion_chunkIndex_key";
CREATE UNIQUE INDEX "DocumentChunk_identity_chunk_key"
  ON "DocumentChunk"("documentId", "processingVersion", "embeddingProvider", "embeddingModel", "embeddingDimension", "chunkIndex");

-- 4. Documents indexed before the dimension was recorded: record the measured length (replaces the 1536 assumption by a fact).
UPDATE "Document" d
SET "embeddingDimension" = m."dim"
FROM (SELECT "documentId", min("embeddingDimension") AS "dim", max("embeddingDimension") AS "dim_max"
      FROM "DocumentChunk" GROUP BY "documentId") m
WHERE d."id" = m."documentId" AND d."embeddingDimension" IS NULL AND m."dim" = m."dim_max";

-- 5. Settings: the `dimensions` request parameter that produced the active dimension. Before this migration the service sent
--    dimensions=<dimension> for OpenAI text-embedding-3-* models (directly or through OpenRouter) and nothing for any other model.
ALTER TABLE "ModelPreference" ADD COLUMN "embeddingRequestDimensions" INTEGER;
-- An EMBEDDING preference saved before the dimension was recorded was, by construction, a 1536-d configuration: the old pipeline
-- stored only vector(1536) and rejected any other length. Record that explicitly (a model that really is another size now fails the
-- strict length check on first use and must be re-validated in Settings; nothing is padded or truncated).
UPDATE "ModelPreference" SET "embeddingDimension" = 1536 WHERE "task" = 'EMBEDDING' AND "embeddingDimension" IS NULL;
ALTER TABLE "ModelPreference" ADD CONSTRAINT "ModelPreference_request_dimensions_match" CHECK ("embeddingRequestDimensions" IS NULL OR "embeddingRequestDimensions" = "embeddingDimension");
UPDATE "ModelPreference"
SET "embeddingRequestDimensions" = "embeddingDimension"
WHERE "task" = 'EMBEDDING' AND "embeddingDimension" IS NOT NULL AND "modelId" ~ '^(openai/)?text-embedding-3';

-- 6. Staged re-index.
CREATE TYPE "EmbeddingReindexStatus" AS ENUM ('BUILDING', 'ACTIVATED', 'FAILED', 'CANCELLED');

CREATE TABLE "EmbeddingReindex" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "modelId" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "requestDimensions" INTEGER,
    "status" "EmbeddingReindexStatus" NOT NULL DEFAULT 'BUILDING',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EmbeddingReindex_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmbeddingReindex_dimension_range" CHECK ("dimension" BETWEEN 1 AND 16000),
    CONSTRAINT "EmbeddingReindex_request_dimensions_match" CHECK ("requestDimensions" IS NULL OR "requestDimensions" = "dimension")
);

CREATE INDEX "EmbeddingReindex_userId_status_idx" ON "EmbeddingReindex"("userId", "status");
-- At most one index under construction per user.
CREATE UNIQUE INDEX "EmbeddingReindex_one_building_per_user" ON "EmbeddingReindex"("userId") WHERE "status" = 'BUILDING';

ALTER TABLE "EmbeddingReindex" ADD CONSTRAINT "EmbeddingReindex_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
