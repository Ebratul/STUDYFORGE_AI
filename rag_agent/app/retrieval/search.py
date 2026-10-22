"""Hybrid retrieval (vector + keyword, Reciprocal Rank Fusion) with strict owner isolation.

ONE parameterised SQL path. No user data is ever interpolated into the SQL text. Every query is scoped by
owner on BOTH the chunk and the document row, to the authorised document ids, to the document's current
processingVersion, to READY documents, and to the embedding model that produced the stored vectors.
"""

from __future__ import annotations

from dataclasses import dataclass

from pgvector import Vector
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from app.errors import AppError, ErrorCode

EMBEDDING_DIMS = 1536
RRF_K = 60

SQL = """
WITH q AS (
  SELECT %(qvec)s::vector AS v, plainto_tsquery('simple', %(qtext)s) AS tsq
),
base AS (
  SELECT c."id", c."documentId", c."page", c."section", c."content", c."embedding", c."search"
  FROM "DocumentChunk" c
  JOIN "Document" d ON d."id" = c."documentId"
  WHERE c."ownerId" = %(owner)s
    AND d."ownerId" = %(owner)s
    AND c."documentId" = ANY(%(doc_ids)s)
    AND c."processingVersion" = d."processingVersion"
    AND d."status" = 'READY'
    AND c."embeddingModel" = %(embedding_model)s
    AND c."embedding" IS NOT NULL
),
vec AS (
  SELECT b."id", row_number() OVER (ORDER BY b."embedding" <=> q.v, b."id") AS rnk
  FROM base b, q
  ORDER BY b."embedding" <=> q.v, b."id"
  LIMIT %(n)s
),
kw AS (
  SELECT b."id", row_number() OVER (ORDER BY ts_rank(b."search", q.tsq) DESC, b."id") AS rnk
  FROM base b, q
  WHERE b."search" @@ q.tsq
  ORDER BY ts_rank(b."search", q.tsq) DESC, b."id"
  LIMIT %(n)s
),
cand AS (
  SELECT "id" FROM vec UNION SELECT "id" FROM kw
)
SELECT b."id" AS chunk_id,
       b."documentId" AS document_id,
       d."name" AS document_name,
       b."page" AS page,
       b."section" AS section,
       b."content" AS content,
       (1 - (b."embedding" <=> q.v))::float8 AS similarity,
       (COALESCE(1.0 / (%(rrf_k)s + vec.rnk), 0) + COALESCE(1.0 / (%(rrf_k)s + kw.rnk), 0))::float8 AS score
FROM cand
JOIN base b ON b."id" = cand."id"
JOIN "Document" d ON d."id" = b."documentId" AND d."ownerId" = %(owner)s
CROSS JOIN q
LEFT JOIN vec ON vec."id" = b."id"
LEFT JOIN kw ON kw."id" = b."id"
ORDER BY score DESC, similarity DESC, b."id"
LIMIT %(limit)s
"""


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    document_id: str
    document_name: str
    page: int | None
    section: str | None
    content: str
    similarity: float
    rank: int


async def search_chunks(
    conn: AsyncConnection,
    *,
    owner_id: str,
    document_ids: list[str],
    query_embedding: list[float],
    query_text: str,
    embedding_model: str,
    top_k: int,
    min_similarity: float | None = None,  # accepted for API symmetry; the gate is applied by the caller on the returned similarities
    max_context_chars: int | None = None,
) -> list[RetrievedChunk]:
    if not owner_id or not isinstance(owner_id, str):
        raise AppError(ErrorCode.VALIDATION, "owner_id is required.")
    ids = sorted({d for d in document_ids if isinstance(d, str) and d})
    if not ids:
        return []
    if len(query_embedding) != EMBEDDING_DIMS:
        raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH)
    top_k = max(1, min(int(top_k), 50))
    params = {
        "qvec": Vector(query_embedding),
        "qtext": query_text.replace("\x00", "")[:2000],
        "owner": owner_id,
        "doc_ids": ids,
        "embedding_model": embedding_model,
        "n": max(top_k * 4, 20),
        "limit": top_k,
        "rrf_k": RRF_K,
    }
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(SQL, params)
        rows = await cur.fetchall()

    out: list[RetrievedChunk] = []
    used = 0
    for i, r in enumerate(rows, start=1):
        length = len(r["content"])
        if max_context_chars is not None and out and used + length > max_context_chars:
            continue  # drop lowest-ranked chunks that do not fit; the first (best) one is always kept
        used += length
        out.append(
            RetrievedChunk(
                chunk_id=r["chunk_id"],
                document_id=r["document_id"],
                document_name=r["document_name"],
                page=r["page"],
                section=r["section"],
                content=r["content"],
                similarity=float(r["similarity"]),
                rank=len(out) + 1,
            )
        )
    return out
