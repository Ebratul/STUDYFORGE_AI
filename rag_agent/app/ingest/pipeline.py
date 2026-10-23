"""Ingestion pipeline: validate -> extract (sandboxed) -> chunk -> embed -> store atomically. Yields NDJSON-ready dicts."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from pgvector import Vector
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, Field

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.ingest.chunk import chunk_blocks
from app.ingest.extract import ExtractError, resolve_kind
from app.ingest.sandbox import run_extract
from app.logging import log_event
from app.providers.base import EmbedRequest
from app.providers.registry import ProviderRegistry
from app.redact import bind_secrets
from app.schemas import EmbeddingConfigIn
from app.vectorstore import Identity, VectorRecord, VectorRuntime, chunk_id

log = logging.getLogger("rag.ingest")

EMBED_BATCH = 64

MESSAGES = {
    "UNSUPPORTED_FILE": "This file type is not supported or the file content does not match its extension.",
    "FILE_TOO_LARGE": "The file is too large.",
    "TOO_MANY_PAGES": "The document has too many pages.",
    "TEXT_TOO_LONG": "The document contains too much text.",
    "NEEDS_OCR": "This PDF looks scanned (no text layer). OCR is not configured on this server.",
    "NO_TEXT": "No readable text was found in this file.",
    "ENCRYPTED_FILE": "The file is encrypted or password protected and cannot be read.",
    "CORRUPT_FILE": "The file appears to be damaged and could not be read.",
    "UNSAFE_ARCHIVE": "The file was rejected by the safety checks.",
    "PARSE_TIMEOUT": "The file took too long to process.",
    "PARSE_MEMORY": "The file needs more memory than is allowed.",
    "PARSE_FAILED": "The file could not be processed.",
    "STALE_VERSION": "A newer processing version already exists for this document.",
}


EmbeddingConfig = EmbeddingConfigIn


class IngestMeta(BaseModel):
    document_id: str = Field(min_length=1, max_length=200)
    owner_id: str = Field(min_length=1, max_length=200)
    filename: str = Field(min_length=1, max_length=500)
    mime_type: str | None = Field(default=None, max_length=200)
    processing_version: int = Field(ge=0, le=2**31 - 1)
    embedding: EmbeddingConfig


async def precheck_document(pool: AsyncConnectionPool, meta: IngestMeta) -> None:
    """The Document row must exist and belong to owner_id (else VALIDATION, before any streaming starts)."""
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute('SELECT 1 FROM "Document" WHERE "id" = %s AND "ownerId" = %s', (meta.document_id, meta.owner_id))
            if await cur.fetchone() is None:
                raise AppError(ErrorCode.VALIDATION, "Document not found for this owner.")


def _result(status: str, *, code: str | None = None, message: str | None = None, page_count: int | None = None,
            text_length: int = 0, chunk_count: int = 0, model: str | None = None,
            dimension: int | None = None, superseded: dict[str, Any] | None = None) -> dict[str, Any]:
    out = {
        "type": "result",
        "status": status,
        "page_count": page_count,
        "text_length": text_length,
        "chunk_count": chunk_count,
        "embedding_model": model,
        "embedding_dimension": dimension,
        "code": code,
        "message": message,
    }
    if superseded is not None:  # only in dual / pinecone mode: the previous version's vectors the backend must remove from Pinecone
        out.update(superseded)
    return out


def _failed(code: str, **kw: Any) -> dict[str, Any]:
    return _result("NEEDS_OCR" if code == "NEEDS_OCR" else "FAILED", code=code, message=MESSAGES.get(code, "The file could not be processed."), **kw)


async def run_ingest(
    *, settings: Settings, pool: AsyncConnectionPool, registry: ProviderRegistry, meta: IngestMeta, filename_ext: str, data: bytes,
    vectors: VectorRuntime | None = None,
) -> AsyncIterator[dict[str, Any]]:
    secret = meta.embedding.api_key.get_secret_value()
    t0 = time.perf_counter()
    with bind_secrets([secret]):
        try:
            async for ev in _run(settings, pool, registry, meta, filename_ext, data, vectors or VectorRuntime(settings)):
                yield ev
        except AppError as e:
            log_event(log, "ingest_error", logging.WARNING, document_id=meta.document_id, code=e.code.value)
            yield {"type": "error", **e.to_dict()}
        except ExtractError as e:  # defensive: expected failures are handled inside _run
            yield _failed(e.code)
        except Exception as exc:  # noqa: BLE001  infra failure (DB etc.): the transaction has already rolled back
            log_event(log, "ingest_internal_error", logging.ERROR, document_id=meta.document_id, exc_type=type(exc).__name__)
            yield {"type": "error", **AppError(ErrorCode.INTERNAL, "Processing failed. Please retry.").to_dict()}
        log_event(log, "ingest_done", document_id=meta.document_id, duration_ms=int((time.perf_counter() - t0) * 1000))


async def _run(settings: Settings, pool: AsyncConnectionPool, registry: ProviderRegistry, meta: IngestMeta,
               ext: str, data: bytes, rt: VectorRuntime) -> AsyncIterator[dict[str, Any]]:
    doc = meta.document_id
    if len(data) > settings.max_upload_bytes:
        yield _failed("FILE_TOO_LARGE")
        return
    if not data:
        yield _failed("NO_TEXT")
        return
    # provider must exist BEFORE we spend effort (mock/unknown -> VALIDATION)
    provider = registry.get(meta.embedding.provider)
    if rt.pinecone_writes:
        # before any embedding money is spent: the index must hold this size, and the database must have been migrated for it
        rt.require_dimension(meta.embedding.dimension)
        await rt.ensure_schema(pool)

    yield {"type": "progress", "stage": "extract", "progress": 5}
    try:
        kind = resolve_kind(ext, data)
        extracted = await run_extract(kind, data, settings)
    except ExtractError as e:
        log_event(log, "ingest_extract_failed", logging.INFO, document_id=doc, code=e.code)
        yield _failed(e.code)
        return
    text_length = extracted.text_length
    if extracted.scanned:
        # OCR is optional and off by default; when unavailable we degrade to NEEDS_OCR
        yield _failed("NEEDS_OCR", page_count=extracted.page_count)
        return
    yield {"type": "progress", "stage": "extract", "progress": 15}

    chunks = chunk_blocks(extracted.blocks, target=settings.chunk_target_chars, overlap=settings.chunk_overlap_chars,
                          by_page=(extracted.kind == "pdf"))
    if not chunks:
        yield _failed("NO_TEXT", page_count=extracted.page_count)
        return
    yield {"type": "progress", "stage": "chunk", "progress": 35}
    log_event(log, "ingest_chunked", document_id=doc, chunks=len(chunks), text_length=text_length)

    vectors: list[list[float]] = []
    total = len(chunks)
    for i in range(0, total, EMBED_BATCH):
        batch = [c.content for c in chunks[i : i + EMBED_BATCH]]
        res = await provider.embed(
            EmbedRequest(model=meta.embedding.model, api_key=meta.embedding.api_key, inputs=batch,
                         dimensions=meta.embedding.request_dimensions, expected_dimension=meta.embedding.dimension)
        )
        if len(res.vectors) != len(batch):
            raise AppError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
        # Whatever the adapter did, nothing of another length is ever stored (no padding, no truncation).
        if any(len(v) != meta.embedding.dimension for v in res.vectors):
            raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
        vectors.extend(res.vectors)
        yield {"type": "progress", "stage": "embed", "progress": 35 + int(55 * len(vectors) / total)}

    identity = Identity(meta.embedding.provider, meta.embedding.model, meta.embedding.dimension)
    if not rt.pinecone_writes:
        yield {"type": "progress", "stage": "store", "progress": 95}
        outcome = await _store(pool, meta, chunks, vectors)
        if outcome is not None:
            yield _failed(outcome, page_count=extracted.page_count)
            return
        log_event(log, "ingest_stored", document_id=doc, chunks=total)
        yield _result("READY", page_count=extracted.page_count, text_length=text_length, chunk_count=total, model=meta.embedding.model,
                      dimension=len(vectors[0]) if vectors else None)
        return

    # dual / pinecone: (1) upsert + wait until visible, (2) commit the PostgreSQL rows and the new processingVersion, (3) the caller removes the
    # previous version's vectors through the retried delete job. Pinecone and PostgreSQL cannot commit atomically, so a failure after (1) is
    # compensated by deleting exactly the ids this attempt wrote; if even that fails, the orphans have no PostgreSQL row and can never be
    # returned (every candidate is validated against PostgreSQL), and the reconcile tool removes them.
    yield {"type": "progress", "stage": "store", "progress": 93}
    pairs = [(doc, chunk_id(doc, meta.processing_version, identity, c.index)) for c in chunks]
    records = [VectorRecord(cid, doc, meta.owner_id, meta.processing_version, identity, vec) for (_d, cid), vec in zip(pairs, vectors, strict=True)]
    try:
        await rt.pinecone.upsert(records)  # type: ignore[union-attr]
        yield {"type": "progress", "stage": "store", "progress": 95}
        outcome, superseded = await _store_ext(pool, meta, chunks, vectors, pg_vectors=rt.postgres_vectors, mark_pinecone=True, collect_superseded=True)
    except BaseException:
        await _compensate(rt, meta, identity, pairs)
        raise
    if outcome is not None:
        await _compensate(rt, meta, identity, pairs)
        yield _failed(outcome, page_count=extracted.page_count)
        return
    log_event(log, "ingest_stored", document_id=doc, chunks=total, mode=rt.mode, superseded=superseded["superseded_count"])
    yield _result("READY", page_count=extracted.page_count, text_length=text_length, chunk_count=total, model=meta.embedding.model,
                  dimension=len(vectors[0]) if vectors else None, superseded=superseded["payload"])


async def _compensate(rt: VectorRuntime, meta: IngestMeta, identity: Identity, pairs: list[tuple[str, str]]) -> None:
    """Best effort: remove the vectors this attempt wrote. Shielded so a cancelled request still cleans up; never raises."""
    try:
        await asyncio.shield(rt.pinecone.delete_identity(owner_id=meta.owner_id, identity=identity, chunks=pairs, verify=False))  # type: ignore[union-attr]
    except Exception as exc:  # noqa: BLE001  the orphans are harmless (no PostgreSQL row) and the reconcile tool removes them
        log_event(log, "ingest_vector_compensation_failed", logging.WARNING, document_id=meta.document_id, exc_type=type(exc).__name__)


INSERT_SQL = (
    'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section",'
    '"content","tokenCount","embeddingProvider","embeddingModel","metadata","embedding") '
    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
)
# dual / pinecone: the dimension is written explicitly (the vector may be absent) and the Pinecone marker is set in the same statement.
INSERT_EXT_SQL = (
    'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section",'
    '"content","tokenCount","embeddingProvider","embeddingModel","metadata","embedding","embeddingDimension","pineconeIndexedAt") '
    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())"
)

SUPERSEDED_CAP = 5000  # ids reported per ingest; anything beyond is left to the reconcile tool (such vectors are harmless: stale version)


async def _store(pool: AsyncConnectionPool, meta: IngestMeta, chunks: list, vectors: list[list[float]]) -> str | None:
    """pgvector mode. Single transaction. Returns an expected-failure code, or None on success. Any exception rolls everything back."""
    outcome, _ = await _store_ext(pool, meta, chunks, vectors, pg_vectors=True, mark_pinecone=False, collect_superseded=False)
    return outcome


async def _store_ext(pool: AsyncConnectionPool, meta: IngestMeta, chunks: list, vectors: list[list[float]], *, pg_vectors: bool,
                     mark_pinecone: bool, collect_superseded: bool) -> tuple[str | None, dict[str, Any]]:
    v = meta.processing_version
    identity = Identity(meta.embedding.provider, meta.embedding.model, meta.embedding.dimension)
    superseded: dict[str, Any] = {"payload": None, "superseded_count": 0}
    async with pool.connection() as conn:
        async with conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    'SELECT "ownerId", "processingVersion" FROM "Document" WHERE "id" = %s FOR UPDATE', (meta.document_id,)
                )
                row = await cur.fetchone()
                if row is None or row["ownerId"] != meta.owner_id:
                    raise AppError(ErrorCode.VALIDATION, "Document not found for this owner.")
                if v < row["processingVersion"]:
                    return "STALE_VERSION", superseded
                # idempotent re-run of the same version AND identity: delete-then-insert. A staged set of another identity at this
                # version (a re-index in progress) is not ours to touch here.
                await cur.execute(
                    'DELETE FROM "DocumentChunk" WHERE "documentId" = %s AND "processingVersion" = %s '
                    'AND "embeddingProvider" = %s AND "embeddingModel" = %s AND "embeddingDimension" = %s',
                    (meta.document_id, v, meta.embedding.provider, meta.embedding.model, meta.embedding.dimension),
                )
                rows = []
                for c, vec in zip(chunks, vectors, strict=True):
                    base = (
                        chunk_id(meta.document_id, v, identity, c.index), meta.document_id, meta.owner_id, c.index, v, c.page, c.section,
                        c.content, c.token_count, meta.embedding.provider, meta.embedding.model, Jsonb({"charCount": len(c.content)}),
                        Vector(vec) if pg_vectors else None,
                    )
                    rows.append((*base, meta.embedding.dimension) if mark_pinecone else base)
                await cur.executemany(INSERT_EXT_SQL if mark_pinecone else INSERT_SQL, rows)
                if collect_superseded:
                    await cur.execute(
                        'DELETE FROM "DocumentChunk" WHERE "documentId" = %s AND "processingVersion" <> %s '
                        'RETURNING "id","embeddingProvider","embeddingModel","embeddingDimension"', (meta.document_id, v)
                    )
                    superseded = _group_superseded(meta.document_id, await cur.fetchall())
                else:
                    await cur.execute(
                        'DELETE FROM "DocumentChunk" WHERE "documentId" = %s AND "processingVersion" <> %s', (meta.document_id, v)
                    )
                await cur.execute(
                    'UPDATE "Document" SET "processingVersion" = %s WHERE "id" = %s AND "ownerId" = %s',
                    (v, meta.document_id, meta.owner_id),
                )
    return None, superseded


def _group_superseded(document_id: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The chunks of earlier versions that were just deleted from PostgreSQL, grouped by identity, for the backend's delete job."""
    groups: dict[tuple[str, str, int], list[str]] = {}
    count = 0
    for r in rows:
        if r["embeddingDimension"] is None:
            continue
        count += 1
        if count > SUPERSEDED_CAP:
            continue
        groups.setdefault((r["embeddingProvider"], r["embeddingModel"], int(r["embeddingDimension"])), []).append(r["id"])
    payload = {
        "superseded": [
            {"identity": {"provider": p, "model": m, "dimension": d}, "chunks": [[document_id, c] for c in ids]} for (p, m, d), ids in groups.items()
        ],
        "superseded_truncated": count > SUPERSEDED_CAP,
    }
    return {"payload": payload, "superseded_count": count}
