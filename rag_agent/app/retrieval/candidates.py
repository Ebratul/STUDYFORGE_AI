"""Hybrid retrieval where the semantic side comes from a remote VectorStore (Pinecone) and PostgreSQL keeps the final say.

Pinecone only proposes chunk ids. Every proposal is re-validated in PostgreSQL with the same rules the pgvector query uses: owner on the
chunk AND the document, the authorised document ids, the document's current processingVersion, READY, the embedding identity, and the
Pinecone marker. A proposal that fails any rule (foreign, unknown, stale, orphaned, unauthorised) is dropped silently, so a wrong or
compromised vector store can never widen what a user sees. Chunk text, pages and sections are read from PostgreSQL only.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from psycopg import AsyncConnection
from psycopg.rows import dict_row

from app.errors import AppError, ErrorCode
from app.vectorstore import Candidate, Identity, VectorStore

RRF_K = 60

AUTHORISED_SQL = """
SELECT "id", "processingVersion" FROM "Document"
WHERE "ownerId" = %(owner)s AND "id" = ANY(%(doc_ids)s) AND "status" = 'READY'
"""

# One statement: the keyword ranking (tsvector, as in the pgvector query) and the validation of the vector candidates share one scope CTE.
VALIDATE_SQL = """
WITH q AS (
  SELECT plainto_tsquery('simple', %(qtext)s) AS tsq
),
base AS MATERIALIZED (
  SELECT c."id", c."documentId", c."page", c."section", c."content", c."search", c."pineconeIndexedAt"
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
),
kw AS (
  SELECT b."id", row_number() OVER (ORDER BY ts_rank(b."search", q.tsq) DESC, b."id") AS rnk
  FROM base b, q
  WHERE b."search" @@ q.tsq
  ORDER BY ts_rank(b."search", q.tsq) DESC, b."id"
  LIMIT %(n)s
)
SELECT b."id" AS chunk_id,
       b."documentId" AS document_id,
       d."name" AS document_name,
       b."page" AS page,
       b."section" AS section,
       b."content" AS content,
       kw.rnk AS kw_rank,
       (b."id" = ANY(%(cand_ids)s) AND b."pineconeIndexedAt" IS NOT NULL) AS is_candidate
FROM base b
JOIN "Document" d ON d."id" = b."documentId" AND d."ownerId" = %(owner)s
LEFT JOIN kw ON kw."id" = b."id"
WHERE (b."id" = ANY(%(cand_ids)s) AND b."pineconeIndexedAt" IS NOT NULL) OR kw."id" IS NOT NULL
"""


async def search_via_store(
    conn: AsyncConnection,
    store: VectorStore,
    *,
    owner_id: str,
    document_ids: Sequence[str],
    query_embedding: Sequence[float],
    query_text: str,
    identity: Identity,
    top_k: int,
    query_timeout: float | None = None,
) -> list[dict]:
    """Rows shaped like the pgvector query's output (chunk_id, document_id, document_name, page, section, content, similarity, score),
    best first, at most top_k. Raises AppError for store failures; `query_timeout` bounds ONLY the remote call (never a database query)."""
    ids = sorted({d for d in document_ids if isinstance(d, str) and d})
    if not ids:
        return []
    if len(query_embedding) != identity.dimension:
        raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH)
    top_k = max(1, min(int(top_k), 50))
    n = max(top_k * 4, 20)

    # 1. Which of the requested documents may be searched at all? Nothing is sent to the vector store for documents that may not.
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(AUTHORISED_SQL, {"owner": owner_id, "doc_ids": ids})
        authorised = await cur.fetchall()
    if not authorised:
        return []
    allowed = sorted(r["id"] for r in authorised)
    versions = sorted({int(r["processingVersion"]) for r in authorised})

    # 2. Semantic candidates (ids + scores only).
    call = store.query(owner_id=owner_id, document_ids=allowed, vector=query_embedding, identity=identity, top_k=n, versions=versions)
    found: list[Candidate] = await (asyncio.wait_for(call, query_timeout) if query_timeout else call)
    score_of: dict[str, float] = {}
    order: list[str] = []
    for c in found:
        if c.chunk_id not in score_of:  # first (best) occurrence wins
            score_of[c.chunk_id] = c.score
            order.append(c.chunk_id)

    # 3. Validate against PostgreSQL + keyword ranking, in one statement.
    params = {"qtext": query_text.replace("\x00", "")[:2000], "owner": owner_id, "doc_ids": allowed, "embedding_provider": identity.provider,
              "embedding_model": identity.model, "dim": identity.dimension, "cand_ids": order, "n": n}
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(VALIDATE_SQL, params)
        rows = await cur.fetchall()

    # 4. Rank fusion (Reciprocal Rank Fusion, as in the pgvector query). The vector rank counts only candidates that survived validation.
    valid = {r["chunk_id"]: r for r in rows}
    vec_rank = {cid: i for i, cid in enumerate([c for c in order if c in valid and valid[c]["is_candidate"]], start=1)}
    out: list[dict] = []
    for cid, r in valid.items():
        v, k = vec_rank.get(cid), r["kw_rank"]
        if v is None and k is None:
            continue  # defensive: the statement already guarantees one of the two
        out.append({
            "chunk_id": cid, "document_id": r["document_id"], "document_name": r["document_name"], "page": r["page"], "section": r["section"],
            "content": r["content"],
            # A keyword-only hit has no vector score from the store: 0.0, so it ranks by its keyword rank and never passes the similarity gate alone.
            "similarity": float(score_of[cid]) if v is not None else 0.0,
            "score": (1.0 / (RRF_K + v) if v is not None else 0.0) + (1.0 / (RRF_K + int(k)) if k is not None else 0.0),
            "vector_ranked": v is not None,
        })
    out.sort(key=lambda r: (-r["score"], -r["similarity"], r["chunk_id"]))
    return out[:top_k]
