"""Ingestion pipeline: validate -> extract (sandboxed) -> chunk -> embed -> store atomically. Yields NDJSON-ready dicts."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from pgvector import Vector
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, Field, SecretStr

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.ingest.chunk import chunk_blocks
from app.ingest.extract import ExtractError, resolve_kind
from app.ingest.sandbox import run_extract
from app.logging import log_event
from app.providers.base import EmbedRequest
from app.providers.registry import ProviderRegistry
from app.redact import bind_secrets

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


class EmbeddingConfig(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    api_key: SecretStr
    model: str = Field(min_length=1, max_length=200)


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
            text_length: int = 0, chunk_count: int = 0, model: str | None = None) -> dict[str, Any]:
    return {
        "type": "result",
        "status": status,
        "page_count": page_count,
        "text_length": text_length,
        "chunk_count": chunk_count,
        "embedding_model": model,
        "code": code,
        "message": message,
    }


def _failed(code: str, **kw: Any) -> dict[str, Any]:
    return _result("NEEDS_OCR" if code == "NEEDS_OCR" else "FAILED", code=code, message=MESSAGES.get(code, "The file could not be processed."), **kw)


async def run_ingest(
    *, settings: Settings, pool: AsyncConnectionPool, registry: ProviderRegistry, meta: IngestMeta, filename_ext: str, data: bytes
) -> AsyncIterator[dict[str, Any]]:
    secret = meta.embedding.api_key.get_secret_value()
    t0 = time.perf_counter()
    with bind_secrets([secret]):
        try:
            async for ev in _run(settings, pool, registry, meta, filename_ext, data):
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
               ext: str, data: bytes) -> AsyncIterator[dict[str, Any]]:
    doc = meta.document_id
    if len(data) > settings.max_upload_bytes:
        yield _failed("FILE_TOO_LARGE")
        return
    if not data:
        yield _failed("NO_TEXT")
        return
    # provider must exist BEFORE we spend effort (mock/unknown -> VALIDATION)
    provider = registry.get(meta.embedding.provider)

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
        res = await provider.embed(EmbedRequest(model=meta.embedding.model, api_key=meta.embedding.api_key, inputs=batch))
        if len(res.vectors) != len(batch):
            raise AppError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
        vectors.extend(res.vectors)
        yield {"type": "progress", "stage": "embed", "progress": 35 + int(55 * len(vectors) / total)}

    yield {"type": "progress", "stage": "store", "progress": 95}
    outcome = await _store(pool, meta, chunks, vectors)
    if outcome is not None:
        yield _failed(outcome, page_count=extracted.page_count)
        return
    log_event(log, "ingest_stored", document_id=doc, chunks=total)
    yield _result("READY", page_count=extracted.page_count, text_length=text_length, chunk_count=total, model=meta.embedding.model)


INSERT_SQL = (
    'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section",'
    '"content","tokenCount","embeddingModel","metadata","embedding") '
    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
)


async def _store(pool: AsyncConnectionPool, meta: IngestMeta, chunks: list, vectors: list[list[float]]) -> str | None:
    """Single transaction. Returns an expected-failure code, or None on success. Any exception rolls everything back."""
    v = meta.processing_version
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
                    return "STALE_VERSION"
                # idempotent re-run of the same version: delete-then-insert
                await cur.execute(
                    'DELETE FROM "DocumentChunk" WHERE "documentId" = %s AND "processingVersion" = %s', (meta.document_id, v)
                )
                rows = [
                    (
                        uuid.uuid4().hex,
                        meta.document_id,
                        meta.owner_id,
                        c.index,
                        v,
                        c.page,
                        c.section,
                        c.content,
                        c.token_count,
                        meta.embedding.model,
                        Jsonb({"charCount": len(c.content)}),
                        Vector(vec),
                    )
                    for c, vec in zip(chunks, vectors, strict=True)
                ]
                await cur.executemany(INSERT_SQL, rows)
                await cur.execute(
                    'DELETE FROM "DocumentChunk" WHERE "documentId" = %s AND "processingVersion" <> %s', (meta.document_id, v)
                )
                await cur.execute(
                    'UPDATE "Document" SET "processingVersion" = %s WHERE "id" = %s AND "ownerId" = %s',
                    (v, meta.document_id, meta.owner_id),
                )
    return None
