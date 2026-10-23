"""Ingestion against REAL Postgres + pgvector (schema from the Prisma migrations)."""

from __future__ import annotations

import asyncio
import json
import logging

import pytest

from app.errors import AppError, ErrorCode
from app.ingest.pipeline import IngestMeta, precheck_document, run_ingest
from app.providers.mock import VALID_KEY
from app.providers.registry import ProviderRegistry
from tests import fixtures_files as ff
from tests.conftest import CANARY_KEY, add_doc, make_settings
from tests.fakes import FakeProvider

SECRET_TEXT = "Zebrafish photosynthesis quokka vignette"


def meta(doc_id, owner="alice", version=1, filename="notes.txt", provider="mock", key=VALID_KEY, model="mock-embed") -> IngestMeta:
    return IngestMeta.model_validate({
        "document_id": doc_id, "owner_id": owner, "filename": filename, "mime_type": "text/plain", "processing_version": version,
        "embedding": {"provider": provider, "api_key": key, "model": model},
    })


async def ingest(pool, m: IngestMeta, data: bytes, *, settings=None, registry=None, ext=None) -> list[dict]:
    settings = settings or make_settings()
    registry = registry or ProviderRegistry(settings)
    ext = ext or m.filename.rsplit(".", 1)[-1]
    return [ev async for ev in run_ingest(settings=settings, pool=pool, registry=registry, meta=m, filename_ext=ext, data=data)]


async def chunks_of(pool, doc_id):
    async with pool.connection() as conn:
        cur = await conn.execute(
            'SELECT "chunkIndex","processingVersion","page","section","content","embeddingModel","ownerId","tokenCount",'
            'vector_dims("embedding") FROM "DocumentChunk" WHERE "documentId"=%s ORDER BY "processingVersion","chunkIndex"', (doc_id,))
        return await cur.fetchall()


async def doc_version(pool, doc_id) -> int:
    async with pool.connection() as conn:
        cur = await conn.execute('SELECT "processingVersion" FROM "Document" WHERE "id"=%s', (doc_id,))
        return (await cur.fetchone())[0]


TEXT = ("Photosynthesis converts light energy into chemical energy. " * 5 + "\n\n") * 8


async def test_happy_path_txt(db):
    doc = await add_doc(db, "alice")
    events = await ingest(db, meta(doc), TEXT.encode())
    assert [e["type"] for e in events[:-1]] == ["progress"] * (len(events) - 1) and events[-1]["type"] == "result"
    prog = [e["progress"] for e in events if e["type"] == "progress"]
    assert prog == sorted(prog) and {e["stage"] for e in events if e["type"] == "progress"} == {"extract", "chunk", "embed", "store"}
    assert all(35 <= e["progress"] <= 90 for e in events if e.get("stage") == "embed") and prog[-1] == 95
    res = events[-1]
    assert res["status"] == "READY" and res["code"] is None and res["embedding_model"] == "mock-embed"
    assert res["embedding_dimension"] == 1536  # the verified length of the vectors actually stored
    rows = await chunks_of(db, doc)
    assert res["chunk_count"] == len(rows) >= 1 and res["text_length"] > 0
    for r in rows:
        assert r[1] == 1 and r[5] == "mock-embed" and r[6] == "alice" and r[8] == 1536 and r[7] >= 1
    assert await doc_version(db, doc) == 1


async def test_pdf_pages_are_recorded(db):
    doc = await add_doc(db, "alice", name="a.pdf")
    pdf = ff.make_pdf(["Alpha first page content. " * 20, "Bravo second page content. " * 20])
    events = await ingest(db, meta(doc, filename="a.pdf"), pdf)
    assert events[-1]["status"] == "READY" and events[-1]["page_count"] == 2
    rows = await chunks_of(db, doc)
    assert {r[2] for r in rows} == {1, 2}
    assert all("Bravo" not in r[4] for r in rows if r[2] == 1)


async def test_docx_sections_and_markdown_sections(db):
    d1 = await add_doc(db, "alice", name="a.docx")
    docx = ff.make_docx([("Overview", "Heading 1"), ("Cells divide by mitosis.", None)])
    await ingest(db, meta(d1, filename="a.docx"), docx)
    assert any(r[3] == "Overview" for r in await chunks_of(db, d1))
    d2 = await add_doc(db, "alice", name="a.md")
    await ingest(db, meta(d2, filename="a.md"), b"# Biology\n\nCells are small.\n")
    assert any(r[3] == "Biology" for r in await chunks_of(db, d2))


async def test_atomic_version_switch(db):
    doc = await add_doc(db, "alice")
    await ingest(db, meta(doc, version=1), b"version one text about cells " * 30)
    assert {r[1] for r in await chunks_of(db, doc)} == {1}
    ev = await ingest(db, meta(doc, version=2), b"version two text about nuclei " * 30)
    assert ev[-1]["status"] == "READY"
    rows = await chunks_of(db, doc)
    assert {r[1] for r in rows} == {2} and all("nuclei" in r[4] for r in rows)
    assert await doc_version(db, doc) == 2


async def test_idempotent_rerun_same_version(db):
    doc = await add_doc(db, "alice")
    a = await ingest(db, meta(doc, version=3), TEXT.encode())
    first = await chunks_of(db, doc)
    b = await ingest(db, meta(doc, version=3), TEXT.encode())
    second = await chunks_of(db, doc)
    assert a[-1]["chunk_count"] == b[-1]["chunk_count"] == len(second)
    assert [r[:6] for r in first] == [r[:6] for r in second]  # same content, no duplicates
    assert await doc_version(db, doc) == 3


async def test_rollback_on_embedding_failure_keeps_old_version(db, settings):
    doc = await add_doc(db, "alice")
    await ingest(db, meta(doc, version=1), b"stable old content " * 40)
    before = await chunks_of(db, doc)
    reg = ProviderRegistry(settings)
    reg.register_for_tests(FakeProvider("openai", embed_error=AppError(ErrorCode.PROVIDER_RATE_LIMITED, retry_after_seconds=8)))
    ev = await ingest(db, meta(doc, version=2, provider="openai", key=CANARY_KEY, model="text-embedding-3-small"),
                      b"brand new content " * 40, registry=reg)
    assert ev[-1] == {"type": "error", "code": "PROVIDER_RATE_LIMITED", "message": ev[-1]["message"], "retryable": True, "retry_after_seconds": 8}
    assert await chunks_of(db, doc) == before and await doc_version(db, doc) == 1
    assert CANARY_KEY not in json.dumps(ev)


async def test_rollback_when_store_fails_midway(db, settings):
    """A DB error while inserting (wrong-dimension vector for the last chunk) must leave the old chunk set untouched."""
    doc = await add_doc(db, "alice")
    await ingest(db, meta(doc, version=1), b"stable old content " * 40)
    before = await chunks_of(db, doc)

    class BadLast(FakeProvider):
        async def embed(self, req):
            res = await super().embed(req)
            res.vectors[-1] = [0.1, 0.2]  # not 1536-d: rejected by vector(1536) at INSERT time
            return res

    reg = ProviderRegistry(settings)
    reg.register_for_tests(BadLast("openai"))
    big = ("para about nuclei. " * 60 + "\n\n") * 6
    ev = await ingest(db, meta(doc, version=2, provider="openai", key=CANARY_KEY, model="m2"), big.encode(), registry=reg)
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "INTERNAL"
    assert await chunks_of(db, doc) == before and await doc_version(db, doc) == 1
    async with db.connection() as conn:  # no partial v2 rows
        cur = await conn.execute('SELECT count(*) FROM "DocumentChunk" WHERE "processingVersion"=2')
        assert (await cur.fetchone())[0] == 0


async def test_stale_version_does_not_overwrite_newer(db):
    doc = await add_doc(db, "alice")
    await ingest(db, meta(doc, version=5), b"newer content " * 40)
    ev = await ingest(db, meta(doc, version=4), b"older content " * 40)
    assert ev[-1]["status"] == "FAILED" and ev[-1]["code"] == "STALE_VERSION"
    assert {r[1] for r in await chunks_of(db, doc)} == {5}


async def test_owner_mismatch_is_rejected(db):
    doc = await add_doc(db, "alice")
    await add_doc(db, "mallory")
    with pytest.raises(AppError) as ei:
        await precheck_document(db, meta(doc, owner="mallory"))
    assert ei.value.code == ErrorCode.VALIDATION
    with pytest.raises(AppError):
        await precheck_document(db, meta("does-not-exist"))
    await precheck_document(db, meta(doc))  # the real owner passes


async def test_store_re_checks_owner_inside_transaction(db):
    doc = await add_doc(db, "alice")
    await add_doc(db, "mallory")
    ev = await ingest(db, meta(doc, owner="mallory"), b"x content " * 40)  # bypassing precheck
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "VALIDATION"
    assert await chunks_of(db, doc) == []


async def test_db_trigger_rejects_foreign_owner_chunks(db):
    doc = await add_doc(db, "alice")
    await add_doc(db, "mallory")
    async with db.connection() as conn:
        with pytest.raises(Exception, match="ownerId must equal"):
            await conn.execute(
                'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingModel") '
                "VALUES ('c1',%s,'mallory',0,1,'x',1,'m')", (doc,))


@pytest.mark.parametrize("fname,data,code,status", [
    ("scan.pdf", ff.make_blank_pdf(2), "NEEDS_OCR", "NEEDS_OCR"),
    ("fake.pdf", ff.PNG_BYTES, "UNSUPPORTED_FILE", "FAILED"),
    ("fake.txt", ff.EXE_BYTES, "UNSUPPORTED_FILE", "FAILED"),
    ("enc.pdf", ff.make_encrypted_pdf(), "ENCRYPTED_FILE", "FAILED"),
    ("bad.pdf", b"%PDF-1.4 broken", "CORRUPT_FILE", "FAILED"),
    ("bomb.docx", ff.docx_bomb(), "UNSAFE_ARCHIVE", "FAILED"),
    ("empty.txt", b"   \n\n  ", "NO_TEXT", "FAILED"),
    ("zero.txt", b"", "NO_TEXT", "FAILED"),
    ("x.exe", b"MZ", "UNSUPPORTED_FILE", "FAILED"),
])
async def test_expected_failures_store_nothing_and_keep_old_chunks(db, fname, data, code, status):
    doc = await add_doc(db, "alice", name=fname)
    await ingest(db, meta(doc, version=1, filename="seed.txt"), b"seed content " * 40)
    before = await chunks_of(db, doc)
    ev = await ingest(db, meta(doc, version=2, filename=fname), data)
    res = ev[-1]
    assert res["type"] == "result" and res["status"] == status and res["code"] == code and res["message"]
    assert res["chunk_count"] == 0 and res["embedding_model"] is None and res["embedding_dimension"] is None
    assert await chunks_of(db, doc) == before and await doc_version(db, doc) == 1
    if code == "NEEDS_OCR":
        assert res["message"] == "This PDF looks scanned (no text layer). OCR is not configured on this server."
        assert res["page_count"] == 2


async def test_limits_file_size_pages_text(db):
    doc = await add_doc(db, "alice")
    ev = await ingest(db, meta(doc), b"x " * 600, settings=make_settings(max_upload_bytes=1024))
    assert ev[-1]["code"] == "FILE_TOO_LARGE"
    ev = await ingest(db, meta(doc, filename="p.pdf"), ff.make_pdf(["page text " * 20] * 4), settings=make_settings(max_pages=3))
    assert ev[-1]["code"] == "TOO_MANY_PAGES"
    ev = await ingest(db, meta(doc), b"word " * 2000, settings=make_settings(max_text_chars=1500))
    assert ev[-1]["code"] == "TEXT_TOO_LONG"
    assert await chunks_of(db, doc) == []


async def test_parse_timeout_is_reported_as_failed(db):
    doc = await add_doc(db, "alice")
    ev = await ingest(db, meta(doc), b"hello " * 100, settings=make_settings(parse_timeout_seconds=0.001))
    assert ev[-1]["status"] == "FAILED" and ev[-1]["code"] == "PARSE_TIMEOUT"


async def test_groq_cannot_embed_so_ingest_errors_without_storing(db):
    doc = await add_doc(db, "alice")
    ev = await ingest(db, meta(doc, provider="groq", key=CANARY_KEY, model="x"), b"content " * 50)
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "CAPABILITY_UNSUPPORTED"
    assert await chunks_of(db, doc) == []


async def test_unknown_or_disabled_provider_is_a_validation_error(db):
    doc = await add_doc(db, "alice")
    s = make_settings(allow_mock_provider=False)
    ev = await ingest(db, meta(doc), b"x" * 50, settings=s)
    assert ev == [{"type": "error", "code": "VALIDATION", "message": ev[0]["message"], "retryable": False}]


async def test_cancellation_mid_embedding_stores_nothing(db, settings):
    doc = await add_doc(db, "alice")
    started = asyncio.Event()

    class Hang(FakeProvider):
        async def embed(self, req):
            started.set()
            await asyncio.sleep(60)

    reg = ProviderRegistry(settings)
    reg.register_for_tests(Hang("openai"))

    async def go():
        return await ingest(db, meta(doc, provider="openai", key=CANARY_KEY, model="m"), TEXT.encode(), registry=reg)

    t = asyncio.create_task(go())
    await asyncio.wait_for(started.wait(), 10)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert await chunks_of(db, doc) == [] and await doc_version(db, doc) == 0


async def test_cancellation_inside_transaction_rolls_back(db, settings, monkeypatch):
    doc = await add_doc(db, "alice")
    await ingest(db, meta(doc, version=1), b"old content " * 40)
    before = await chunks_of(db, doc)
    from app.ingest import pipeline

    gate = asyncio.Event()
    orig = pipeline.INSERT_SQL

    class SlowCursorPatch:
        pass

    real_store = pipeline._store

    async def slow_store(pool, m, chunks, vectors):
        # emulate the client disconnecting while the transaction is open
        async with pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('DELETE FROM "DocumentChunk" WHERE "documentId"=%s', (m.document_id,))
                gate.set()
                await asyncio.sleep(60)

    monkeypatch.setattr(pipeline, "_store", slow_store)
    t = asyncio.create_task(ingest(db, meta(doc, version=2), b"new content " * 40))
    await asyncio.wait_for(gate.wait(), 10)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    monkeypatch.setattr(pipeline, "_store", real_store)
    assert await chunks_of(db, doc) == before and await doc_version(db, doc) == 1


async def test_no_document_text_or_keys_in_logs(db, caplog):
    from app.logging import configure_logging

    caplog.set_level(logging.DEBUG)
    doc = await add_doc(db, "alice")
    await ingest(db, meta(doc, key=VALID_KEY), (SECRET_TEXT + " lorem ipsum ").encode() * 20)
    await ingest(db, meta(doc, filename="x.pdf"), ff.PNG_BYTES)
    assert SECRET_TEXT not in caplog.text and "Zebrafish" not in caplog.text and VALID_KEY not in caplog.text
    from app.logging import JsonFormatter

    lines = [JsonFormatter().format(r) for r in caplog.records]
    assert any(doc in ln for ln in lines)  # ids/stages/counts are logged
    assert not any(SECRET_TEXT in ln or VALID_KEY in ln for ln in lines)
