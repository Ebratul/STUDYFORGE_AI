"""Hybrid retrieval (vector + keyword, Reciprocal Rank Fusion) with strict owner isolation.

ONE parameterised SQL path. No user data is ever interpolated into the SQL text. Every query is scoped by
owner on BOTH the chunk and the document row, to the authorised document ids, to the document's current
processingVersion, to READY documents, and to the embedding identity (provider, model, dimension) that produced the stored vectors.
The identity filter is evaluated in a MATERIALIZED CTE before any distance operator, so vectors of different lengths are never compared.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from pgvector import Vector
from psycopg import AsyncConnection
from psycopg.rows import dict_row

from app.errors import AppError, ErrorCode
from app.logging import log_event
from app.retrieval.candidates import search_via_store
from app.vectorstore import Identity, VectorRuntime

log = logging.getLogger("rag.retrieval")

RRF_K = 60

SQL = """
WITH q AS (
  SELECT %(qvec)s::vector AS v, plainto_tsquery('simple', %(qtext)s) AS tsq
),
base AS MATERIALIZED (
  SELECT c."id", c."documentId", c."page", c."section", c."content", c."embedding", c."search"
  FROM "DocumentChunk" c
  JOIN "Document" d ON d."id" = c."documentId"
  WHERE c."ownerId" = %(owner)s
    AND d."ownerId" = %(owner)s
    AND c."documentId" = ANY(%(doc_ids)s)
    AND c."processingVersion" = d."processingVersion"
    AND d."status" = 'READY'
    AND c."embeddingProvider" = %(embedding_provider)s
    AND c."embeddingModel" = %(embedding_model)s
    AND c."embeddingDimension" = %(dim)s
    AND vector_dims(c."embedding") = %(dim)s
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
    embedding_provider: str,
    embedding_model: str,
    embedding_dimension: int,
    top_k: int,
    min_similarity: float | None = None,  # accepted for API symmetry; the gate is applied by the caller on the returned similarities
    max_context_chars: int | None = None,
    vectors: VectorRuntime | None = None,  # None = pgvector mode (the original behaviour)
) -> list[RetrievedChunk]:
    if not owner_id or not isinstance(owner_id, str):
        raise AppError(ErrorCode.VALIDATION, "owner_id is required.")
    ids = sorted({d for d in document_ids if isinstance(d, str) and d})
    if not ids:
        return []
    # Only vectors of exactly this identity are compared (provider + model + dimension); a query vector of any other length is an error.
    if len(query_embedding) != embedding_dimension:
        raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH)
    top_k = max(1, min(int(top_k), 50))
    mode = vectors.mode if vectors is not None else "pgvector"
    identity = Identity(embedding_provider, embedding_model, embedding_dimension)

    if mode == "pinecone":
        await vectors.check_schema(conn)  # type: ignore[union-attr]
        rows = await search_via_store(conn, vectors.pinecone, owner_id=owner_id, document_ids=ids, query_embedding=query_embedding,  # type: ignore[union-attr]
                                      query_text=query_text, identity=identity, top_k=top_k)
        return _finish(rows, max_context_chars)

    served = await _search_pgvector(conn, owner_id, ids, query_embedding, query_text, identity, top_k, max_context_chars)
    if mode == "dual":
        await _shadow_compare(conn, vectors, served, owner_id, ids, query_embedding, query_text, identity, top_k, max_context_chars)  # type: ignore[arg-type]
    return served


async def _search_pgvector(conn, owner_id, ids, query_embedding, query_text, identity: Identity, top_k, max_context_chars) -> list[RetrievedChunk]:
    params = {
        "qvec": Vector(query_embedding),
        "qtext": query_text.replace("\x00", "")[:2000],
        "owner": owner_id,
        "doc_ids": ids,
        "embedding_provider": identity.provider,
        "embedding_model": identity.model,
        "dim": identity.dimension,
        "n": max(top_k * 4, 20),
        "limit": top_k,
        "rrf_k": RRF_K,
    }
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(SQL, params)
        rows = await cur.fetchall()
    return _finish(rows, max_context_chars)


def _finish(rows: list[dict], max_context_chars: int | None) -> list[RetrievedChunk]:
    out: list[RetrievedChunk] = []
    used = 0
    for r in rows:
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


async def _shadow_compare(conn, runtime: VectorRuntime, served: list[RetrievedChunk], owner_id, ids, query_embedding, query_text,
                          identity: Identity, top_k, max_context_chars) -> None:
    """Dual mode: PostgreSQL results are what the user gets; Pinecone's are only compared. NEVER raises and never changes `served`.
    Logs counts, ids and scores, never chunk text or secrets."""
    try:
        await runtime.check_schema(conn)
        rows = await search_via_store(conn, runtime.pinecone, owner_id=owner_id, document_ids=ids, query_embedding=query_embedding,  # type: ignore[arg-type]
                                      query_text=query_text, identity=identity, top_k=top_k, query_timeout=runtime.settings.vector_shadow_timeout_seconds)
    except asyncio.CancelledError:
        raise
    except BaseException as exc:  # noqa: BLE001  includes TimeoutError and AppError: the comparison is best effort
        log_event(log, "vector_shadow_failed", logging.WARNING, code=getattr(getattr(exc, "code", None), "value", None), exc_type=type(exc).__name__)
        return
    alt = _finish(rows, max_context_chars)
    a, b = [c.chunk_id for c in served], [c.chunk_id for c in alt]
    common = set(a) & set(b)
    union = set(a) | set(b)
    vec_ranked = {r["chunk_id"] for r in rows if r.get("vector_ranked")}
    sims_a = {c.chunk_id: c.similarity for c in served}
    deltas = [abs(sims_a[c.chunk_id] - c.similarity) for c in alt if c.chunk_id in sims_a and c.chunk_id in vec_ranked]
    same_set = set(a) == set(b)
    log_event(log, "vector_shadow_compare", logging.INFO if same_set else logging.WARNING,
              served=len(a), shadow=len(b), overlap=len(common), jaccard=round(len(common) / len(union), 4) if union else 1.0,
              top1_same=bool(a and b and a[0] == b[0]), only_pgvector=len(set(a) - set(b)), only_pinecone=len(set(b) - set(a)),
              max_similarity_delta=round(max(deltas), 6) if deltas else None, same_order=(a == b))
