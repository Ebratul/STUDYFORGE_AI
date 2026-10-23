-- Vector store tracking for the optional Pinecone backend (docs/VECTOR_STORE_SPEC.md).
--
-- Additive and backward compatible: nothing is dropped or rewritten, every existing value is kept, and application code from before this
-- migration keeps working against the new schema (see the trigger below). The pgvector "embedding" column and all stored vectors stay.

-- 1. Which chunks have a verified copy in Pinecone. NULL = not (yet) indexed there; in pgvector mode it is simply never set.
ALTER TABLE "DocumentChunk" ADD COLUMN "pineconeIndexedAt" TIMESTAMP(3);

-- 2. "embeddingDimension" was GENERATED ALWAYS AS (vector_dims("embedding")). With Pinecone the local vector may be absent, so the
--    dimension must be able to exist on its own. DROP EXPRESSION keeps every stored value and turns the column into a plain one.
ALTER TABLE "DocumentChunk" ALTER COLUMN "embeddingDimension" DROP EXPRESSION;

-- 3. Code from before this migration inserts only the vector and relies on the generated column. This trigger gives it the same result,
--    so a rolling deploy (or a rollback of the application) cannot leave rows with an empty dimension. When a vector is present the
--    dimension is always its real length: it can still never disagree with the data. Rows without a vector (Pinecone mode) must say
--    their own dimension, which rag_agent verifies against the provider's real output before it writes anything.
CREATE OR REPLACE FUNCTION studyforge_chunk_dimension() RETURNS trigger AS $$
BEGIN
  IF NEW."embedding" IS NOT NULL THEN
    IF TG_OP = 'INSERT' AND NEW."embeddingDimension" IS NOT NULL AND NEW."embeddingDimension" <> vector_dims(NEW."embedding") THEN
      RAISE EXCEPTION 'DocumentChunk.embeddingDimension must equal the length of the embedding';
    END IF;
    NEW."embeddingDimension" := vector_dims(NEW."embedding");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentChunk_dimension_check" BEFORE INSERT OR UPDATE ON "DocumentChunk"
  FOR EACH ROW EXECUTE FUNCTION studyforge_chunk_dimension();
