"""PostgreSQL / pgvector backend. The vector lives in the DocumentChunk row itself ("embedding"), next to the chunk text.

`search_chunks` (app/retrieval/search.py) keeps its single hybrid SQL statement for serving; this class is the VectorStore view of the
same table, used by the shared contract tests, the backfill and the dual-mode comparison.
"""

from __future__ import annotations

from collections.abc import Sequence

from pgvector import Vector
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.config import MAX_EMBEDDING_DIMENSION, MIN_EMBEDDING_DIMENSION
from app.errors import AppError, ErrorCode
from app.vectorstore.base import Candidate, Identity, VectorRecord, VectorStore

QUERY_SQL = """
SELECT c."id" AS chunk_id, (1 - (c."embedding" <=> %(qvec)s::vector))::float8 AS score
FROM "DocumentChunk" c
WHERE c."ownerId" = %(owner)s
  AND c."documentId" = ANY(%(docs)s)
  AND c."embeddingProvider" = %(provider)s AND c."embeddingModel" = %(model)s AND c."embeddingDimension" = %(dim)s
  AND (%(versions)s::int[] IS NULL OR c."processingVersion" = ANY(%(versions)s::int[]))
  AND c."embedding" IS NOT NULL AND vector_dims(c."embedding") = %(dim)s
ORDER BY c."embedding" <=> %(qvec)s::vector, c."id"
LIMIT %(n)s
"""


class PgVectorStore(VectorStore):
    name = "pgvector"

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self.pool = pool

    def supports(self, dimension: int) -> bool:
        return MIN_EMBEDDING_DIMENSION <= dimension <= MAX_EMBEDDING_DIMENSION

    async def upsert(self, records: Sequence[VectorRecord]) -> None:
        """Sets the vector of chunk rows that already exist (the ingest pipeline inserts text and vector together instead)."""
        async with self.pool.connection() as conn:
            async with conn.transaction():
                async with conn.cursor() as cur:
                    for r in records:
                        if len(r.values) != r.identity.dimension:
                            raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
                        await cur.execute(
                            'UPDATE "DocumentChunk" SET "embedding" = %s WHERE "id" = %s AND "ownerId" = %s AND "documentId" = %s',
                            (Vector(list(r.values)), r.id, r.owner_id, r.document_id),
                        )
                        if cur.rowcount != 1:
                            raise AppError(ErrorCode.VALIDATION, "Chunk not found for this owner.")

    async def query(self, *, owner_id, document_ids, vector, identity: Identity, top_k, versions=None) -> list[Candidate]:
        if len(vector) != identity.dimension:
            raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
        params = {"qvec": Vector(list(vector)), "owner": owner_id, "docs": sorted(set(document_ids)), "provider": identity.provider,
                  "model": identity.model, "dim": identity.dimension, "versions": list(versions) if versions is not None else None, "n": top_k}
        async with self.pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(QUERY_SQL, params)
                return [Candidate(r["chunk_id"], float(r["score"])) for r in await cur.fetchall()]

    async def _delete(self, sql: str, params: tuple) -> int:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                cur = await conn.execute(sql, params)
                return cur.rowcount

    async def delete_document(self, *, owner_id, document_id) -> int:
        return await self._delete('DELETE FROM "DocumentChunk" WHERE "ownerId" = %s AND "documentId" = %s', (owner_id, document_id))

    async def delete_user(self, *, owner_id, document_ids=()) -> int:
        return await self._delete('DELETE FROM "DocumentChunk" WHERE "ownerId" = %s', (owner_id,))

    async def delete_identity(self, *, owner_id, identity: Identity, chunks, verify: bool = True) -> int:
        return await self._delete(
            'DELETE FROM "DocumentChunk" WHERE "ownerId" = %s AND "id" = ANY(%s) AND "documentId" = ANY(%s) AND "embeddingProvider" = %s '
            'AND "embeddingModel" = %s AND "embeddingDimension" = %s',
            (owner_id, [c for _d, c in chunks], sorted({d for d, _c in chunks}), identity.provider, identity.model, identity.dimension),
        )

    async def count_document(self, *, owner_id, document_id, dimension) -> int | None:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                'SELECT count(*) FROM "DocumentChunk" WHERE "ownerId" = %s AND "documentId" = %s AND "embeddingDimension" = %s AND "embedding" IS NOT NULL',
                (owner_id, document_id, dimension),
            )
            row = await cur.fetchone()
            return int(row[0])
