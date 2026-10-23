"""Staged re-index of ONE document: re-embed its stored chunk texts under a new embedding identity (provider + model + dimension).

The existing (source) chunk set is only read, never modified, so the document keeps working while this runs. The new (target) set is
written in a single transaction that is rolled back unless it is complete and every vector has exactly the target length. Switching the
user over to the new set is the backend's job, after it has verified every document.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pgvector import Vector
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, Field

from app.errors import AppError, ErrorCode
from app.ingest.pipeline import EMBED_BATCH, INSERT_EXT_SQL, INSERT_SQL
from app.logging import log_event
from app.providers.base import EmbedRequest
from app.providers.registry import ProviderRegistry
from app.redact import bind_secrets
from app.schemas import EmbeddingConfigIn, EmbeddingIdentityIn
from app.vectorstore import Identity, VectorRecord, VectorRuntime, chunk_id

log = logging.getLogger("rag.reindex")

SOURCE_SQL = (
    'SELECT "id","chunkIndex","page","section","content","tokenCount","metadata" FROM "DocumentChunk" '
    'WHERE "documentId" = %s AND "processingVersion" = %s AND "embeddingProvider" = %s AND "embeddingModel" = %s AND "embeddingDimension" = %s '
    'ORDER BY "chunkIndex", "id"'
)


class ReindexBody(BaseModel):
    document_id: str = Field(min_length=1, max_length=200)
    owner_id: str = Field(min_length=1, max_length=200)
    processing_version: int = Field(ge=0, le=2**31 - 1)
    source: EmbeddingIdentityIn
    target: EmbeddingConfigIn


def _stale(chunk_count: int = 0, dimension: int | None = None) -> dict[str, Any]:
    return {"type": "result", "status": "STALE", "chunk_count": chunk_count, "embedding_dimension": dimension}


async def _document_state(cur, body: ReindexBody) -> tuple[int, str]:
    await cur.execute('SELECT "ownerId","processingVersion","status"::text AS status FROM "Document" WHERE "id" = %s', (body.document_id,))
    row = await cur.fetchone()
    if row is None or row["ownerId"] != body.owner_id:
        raise AppError(ErrorCode.VALIDATION, "Document not found for this owner.")
    return int(row["processingVersion"]), row["status"]


async def run_reindex(*, pool: AsyncConnectionPool, registry: ProviderRegistry, body: ReindexBody,
                      vectors: VectorRuntime | None = None) -> dict[str, Any]:
    """Public entry: expected failures are AppErrors; anything else (database, infrastructure) is reported without detail."""
    try:
        return await _run_reindex(pool=pool, registry=registry, body=body, rt=vectors)
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001  the transaction has already rolled back
        log_event(log, "reindex_internal_error", logging.ERROR, document_id=body.document_id, exc_type=type(exc).__name__)
        raise AppError(ErrorCode.INTERNAL, "Re-indexing failed. Please retry.") from None


async def _run_reindex(*, pool: AsyncConnectionPool, registry: ProviderRegistry, body: ReindexBody, rt: VectorRuntime | None) -> dict[str, Any]:
    src, tgt = body.source, body.target
    if (src.provider, src.model, src.dimension) == (tgt.provider, tgt.model, tgt.dimension):
        raise AppError(ErrorCode.VALIDATION, "The source and target embedding identities are the same.")
    provider = registry.get(tgt.provider)  # unknown provider (or mock when disabled) -> 422 before any work
    if rt is not None and rt.pinecone_writes:
        rt.require_dimension(tgt.dimension)  # the staged index must be storable BEFORE any embedding money is spent
        await rt.ensure_schema(pool)
    secret = tgt.api_key.get_secret_value()
    with bind_secrets([secret]):
        async with pool.connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                version, status = await _document_state(cur, body)
                if version != body.processing_version or status != "READY":
                    return _stale()
                await cur.execute(SOURCE_SQL, (body.document_id, version, src.provider, src.model, src.dimension))
                source = await cur.fetchall()
            await conn.commit()  # read-only; do not hold a transaction open while waiting for the provider
        if not source:
            return _stale()

        vectors: list[list[float]] = []
        texts = [r["content"] for r in source]
        for i in range(0, len(texts), EMBED_BATCH):
            res = await provider.embed(
                EmbedRequest(model=tgt.model, api_key=tgt.api_key, inputs=texts[i : i + EMBED_BATCH],
                             dimensions=tgt.request_dimensions, expected_dimension=tgt.dimension)
            )
            if len(res.vectors) != len(texts[i : i + EMBED_BATCH]):
                raise AppError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
            vectors.extend(res.vectors)
        if any(len(v) != tgt.dimension for v in vectors):  # defence in depth: the adapter already enforces this
            raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)

        if rt is not None and rt.pinecone_writes:
            outcome = await _write_with_pinecone(pool, body, source, vectors, rt)
        else:
            outcome = await _write(pool, body, source, vectors)
    log_event(log, "reindex_done", document_id=body.document_id, status=outcome["status"], chunks=outcome["chunk_count"])
    return outcome


async def _write_with_pinecone(pool: AsyncConnectionPool, body: ReindexBody, source: list[dict[str, Any]], vectors: list[list[float]],
                               rt: VectorRuntime) -> dict[str, Any]:
    """Staged set for dual / pinecone: upsert (and wait until visible), then commit the PostgreSQL rows. A failure after the upsert deletes
    exactly the ids this attempt wrote; the active set is never touched."""
    tgt = body.target
    identity = Identity(tgt.provider, tgt.model, tgt.dimension)
    pairs = [(body.document_id, chunk_id(body.document_id, body.processing_version, identity, r["chunkIndex"])) for r in source]
    records = [VectorRecord(cid, body.document_id, body.owner_id, body.processing_version, identity, vec)
               for (_d, cid), vec in zip(pairs, vectors, strict=True)]
    try:
        await rt.pinecone.upsert(records)  # type: ignore[union-attr]
        outcome = await _write(pool, body, source, vectors, pg_vectors=rt.postgres_vectors, mark_pinecone=True)
    except BaseException:
        await _compensate(rt, body, identity, pairs)
        raise
    if outcome["status"] != "READY":
        await _compensate(rt, body, identity, pairs)
    return outcome


async def _compensate(rt: VectorRuntime, body: ReindexBody, identity: Identity, pairs: list[tuple[str, str]]) -> None:
    try:
        await asyncio.shield(rt.pinecone.delete_identity(owner_id=body.owner_id, identity=identity, chunks=pairs, verify=False))  # type: ignore[union-attr]
    except Exception as exc:  # noqa: BLE001  harmless orphans (no PostgreSQL row); the reconcile tool removes them
        log_event(log, "reindex_vector_compensation_failed", logging.WARNING, document_id=body.document_id, exc_type=type(exc).__name__)


async def _write(pool: AsyncConnectionPool, body: ReindexBody, source: list[dict[str, Any]], vectors: list[list[float]], *,
                 pg_vectors: bool = True, mark_pinecone: bool = False) -> dict[str, Any]:
    src, tgt = body.source, body.target
    identity = Identity(tgt.provider, tgt.model, tgt.dimension)
    async with pool.connection() as conn:
        # `transaction()` rolls back on ANY exception, so a failed verification leaves no partial target set behind.
        async with conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute('SELECT "ownerId","processingVersion","status"::text AS status FROM "Document" WHERE "id" = %s FOR UPDATE', (body.document_id,))
                row = await cur.fetchone()
                if row is None or row["ownerId"] != body.owner_id:
                    raise AppError(ErrorCode.VALIDATION, "Document not found for this owner.")
                if int(row["processingVersion"]) != body.processing_version or row["status"] != "READY":
                    return _stale()
                # the source set must be exactly what was embedded (same ids, same order)
                await cur.execute(SOURCE_SQL, (body.document_id, body.processing_version, src.provider, src.model, src.dimension))
                now = await cur.fetchall()
                if [r["id"] for r in now] != [r["id"] for r in source]:
                    return _stale()
                await cur.execute(
                    'DELETE FROM "DocumentChunk" WHERE "documentId" = %s AND "processingVersion" = %s '
                    'AND "embeddingProvider" = %s AND "embeddingModel" = %s AND "embeddingDimension" = %s',
                    (body.document_id, body.processing_version, tgt.provider, tgt.model, tgt.dimension),
                )
                rows = []
                for r, vec in zip(source, vectors, strict=True):
                    base = (chunk_id(body.document_id, body.processing_version, identity, r["chunkIndex"]), body.document_id, body.owner_id,
                            r["chunkIndex"], body.processing_version, r["page"], r["section"], r["content"], r["tokenCount"], tgt.provider,
                            tgt.model, Jsonb(r["metadata"]) if r["metadata"] is not None else None, Vector(vec) if pg_vectors else None)
                    rows.append((*base, tgt.dimension) if mark_pinecone else base)
                await cur.executemany(INSERT_EXT_SQL if mark_pinecone else INSERT_SQL, rows)
                # verified by the database itself, not by what was just written: every row exists, has exactly the target length, and (where
                # a store is required) is marked as held there
                checks = ['"embeddingDimension" = %s']
                if pg_vectors:
                    checks.append('vector_dims("embedding") = %s')
                if mark_pinecone:
                    checks.append('"pineconeIndexedAt" IS NOT NULL')
                await cur.execute(
                    f'SELECT count(*) AS n, count(*) FILTER (WHERE {" AND ".join(checks)}) AS ok FROM "DocumentChunk" '
                    'WHERE "documentId" = %s AND "processingVersion" = %s AND "embeddingProvider" = %s AND "embeddingModel" = %s AND "embeddingDimension" = %s',
                    (*([tgt.dimension] * (2 if pg_vectors else 1)), body.document_id, body.processing_version, tgt.provider, tgt.model, tgt.dimension),
                )
                check = await cur.fetchone()
                if check is None or check["n"] != len(source) or check["ok"] != len(source):
                    raise AppError(ErrorCode.INTERNAL, "The new index could not be verified.")  # rolls the transaction back
    return {"type": "result", "status": "READY", "chunk_count": len(source), "embedding_dimension": tgt.dimension}
