-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "embeddingDimension" INTEGER;

-- AlterTable
ALTER TABLE "ModelPreference" ADD COLUMN     "embeddingDimension" INTEGER,
ADD COLUMN     "validatedAt" TIMESTAMP(3);


-- Backfill: every vector stored so far has exactly 1536 dimensions (the column is vector(1536) and rag_agent verifies the length of
-- each vector before storing it), so this records a measured fact, not a guess. Documents without vectors stay NULL.
UPDATE "Document" SET "embeddingDimension" = 1536 WHERE "status" = 'READY' AND "embeddingModel" IS NOT NULL AND "embeddingDimension" IS NULL;
