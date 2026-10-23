"""Staged re-index (rag side) in pgvector / dual / pinecone mode: the active set is never touched, the staged set is verified, and a failure
leaves neither staged rows nor staged vectors behind. (Activation and the cleanup jobs are the backend's; see its integration tests.)"""

from __future__ import annotations

import pytest

from app.errors import AppError, ErrorCode
from app.ingest import reindex as R
from app.ingest.reindex import ReindexBody, run_reindex
from app.providers.mock import VALID_KEY, hash_embed
from app.providers.registry import ProviderRegistry
from app.providers.base import EmbedResult
from app.vectorstore import Identity, VectorRuntime, chunk_id
from tests.conftest import add_doc, make_settings
from tests.fakes import FakeProvider
from tests.test_vector_ingest import TEXT, imeta, rows, run
from tests.vector_utils import memory_runtime

SRC = Identity("mock", "mock-embed", 1536)
TGT = Identity("mock", "mock-embed-flex", 1024)


def body(doc, *, version=1, owner="alice", provider="mock", key=VALID_KEY, model="mock-embed-flex", dimension=1024) -> ReindexBody:
    return ReindexBody.model_validate({
        "document_id": doc, "owner_id": owner, "processing_version": version,
        "source": {"provider": "mock", "model": "mock-embed", "dimension": 1536},
        "target": {"provider": provider, "api_key": key, "model": model, "dimension": dimension},
    })


async def reindex(db, rt, b, registry=None):
    settings = rt.settings if rt else make_settings()
    return await run_reindex(pool=db, registry=registry or ProviderRegistry(settings), body=b, vectors=rt)


async def staged_rows(db, doc, dim):
    async with db.connection() as conn:
        cur = await conn.execute('SELECT "id","embedding" IS NOT NULL,"embeddingDimension","pineconeIndexedAt" IS NOT NULL FROM "DocumentChunk" '
                                 'WHERE "documentId"=%s AND "embeddingDimension"=%s ORDER BY "chunkIndex"', (doc, dim))
        return await cur.fetchall()


async def seed(db, rt):
    doc = await add_doc(db, "alice")
    ev = await run(db, rt, imeta(doc, version=1))
    assert ev[-1]["status"] == "READY"
    return doc, ev[-1]["chunk_count"]


async def test_pgvector_mode_stages_a_second_set_with_local_vectors(db):
    doc, n = await seed(db, None)
    out = await reindex(db, None, body(doc))
    assert out == {"type": "result", "status": "READY", "chunk_count": n, "embedding_dimension": 1024}
    tgt = await staged_rows(db, doc, 1024)
    assert [r[0] for r in tgt] == [chunk_id(doc, 1, TGT, i) for i in range(n)]
    assert all(r[1] is True and r[3] is False for r in tgt)  # local vector, no Pinecone marker
    assert len(await staged_rows(db, doc, 1536)) == n  # the active set is untouched


async def test_pinecone_mode_stages_vectors_in_the_store_and_marks_the_rows(db):
    rt, store = memory_runtime("pinecone", dimensions=(1536, 1024), pinecone_keep_postgres_vectors=False)
    doc, n = await seed(db, rt)
    before = {k for k in store.records}
    out = await reindex(db, rt, body(doc))
    assert out["status"] == "READY" and out["chunk_count"] == n and out["embedding_dimension"] == 1024
    tgt = await staged_rows(db, doc, 1024)
    assert all(r[1] is False and r[2] == 1024 and r[3] is True for r in tgt)
    new = {k for k in store.records} - before
    assert {k[2] for k in new} == {chunk_id(doc, 1, TGT, i) for i in range(n)} and before <= set(store.records)  # active vectors untouched
    assert all(store.records[k].identity == TGT and len(store.records[k].values) == 1024 for k in new)


async def test_pinecone_mode_keeps_the_postgres_copy_of_the_staged_set_by_default(db):
    rt, store = memory_runtime("pinecone", dimensions=(1536, 1024))
    doc, n = await seed(db, rt)
    await reindex(db, rt, body(doc))
    tgt = await staged_rows(db, doc, 1024)
    assert len(tgt) == n and all(r[1] is True and r[3] is True for r in tgt)  # rollback-ready: switching back to pgvector finds the new index too


async def test_dual_mode_stages_both(db):
    rt, store = memory_runtime("dual", dimensions=(1536, 1024))
    doc, n = await seed(db, rt)
    await reindex(db, rt, body(doc))
    tgt = await staged_rows(db, doc, 1024)
    assert len(tgt) == n and all(r[1] is True and r[3] is True for r in tgt)
    assert len([k for k in store.records if store.records[k].identity == TGT]) == n


async def test_unsupported_target_dimension_is_refused_before_any_embedding(db):
    rt, store = memory_runtime("pinecone")  # the index only holds 1536
    doc, _ = await seed(db, rt)
    fake = FakeProvider("openai")
    reg = ProviderRegistry(rt.settings)
    reg.register_for_tests(fake)
    calls = len(store.calls)
    with pytest.raises(AppError) as e:
        await reindex(db, rt, body(doc, provider="openai", model="m", dimension=1024), registry=reg)
    assert e.value.code == ErrorCode.VECTOR_DIMENSION_UNSUPPORTED
    assert fake.embed_calls == 0 and len(store.calls) == calls and await staged_rows(db, doc, 1024) == []


async def test_a_database_failure_after_the_upsert_removes_the_staged_vectors(db, monkeypatch):
    rt, store = memory_runtime("pinecone", dimensions=(1536, 1024))
    doc, n = await seed(db, rt)
    active = set(store.records)

    async def boom(*a, **k):
        raise RuntimeError("db")

    monkeypatch.setattr(R, "_write", boom)
    with pytest.raises(AppError) as e:
        await reindex(db, rt, body(doc))
    assert e.value.code == ErrorCode.INTERNAL
    assert set(store.records) == active and await staged_rows(db, doc, 1024) == []


async def test_a_document_that_changed_while_embedding_is_stale_and_leaves_nothing(db):
    rt, store = memory_runtime("pinecone", dimensions=(1536, 1024))
    doc, n = await seed(db, rt)
    active = set(store.records)

    class Bumps(FakeProvider):
        async def embed(self, req):
            async with db.connection() as conn:  # the document is re-processed while the target embedding is being computed
                await conn.execute('UPDATE "Document" SET "processingVersion"=2 WHERE "id"=%s', (doc,))
            return EmbedResult(vectors=[hash_embed(t, req.expected_dimension) for t in req.inputs])

    reg = ProviderRegistry(rt.settings)
    reg.register_for_tests(Bumps("openai"))
    out = await reindex(db, rt, body(doc, provider="openai", model="m", key="k" * 20), registry=reg)
    assert out["status"] == "STALE"
    assert set(store.records) == active and await staged_rows(db, doc, 1024) == []


async def test_verification_failure_rolls_the_rows_back_and_removes_the_vectors(db, monkeypatch):
    """Two staged rows missing their marker would fail the database's own count check: nothing may survive."""
    rt, store = memory_runtime("pinecone", dimensions=(1536, 1024))
    doc, n = await seed(db, rt)
    active = set(store.records)
    monkeypatch.setattr(R, "INSERT_EXT_SQL", R.INSERT_EXT_SQL.replace("now())", "NULL)"))  # rows written without the marker
    with pytest.raises(AppError) as e:
        await reindex(db, rt, body(doc))
    assert e.value.code == ErrorCode.INTERNAL and "verified" in e.value.message
    assert set(store.records) == active and await staged_rows(db, doc, 1024) == []


async def test_rerunning_the_same_reindex_is_idempotent(db):
    rt, store = memory_runtime("pinecone", dimensions=(1536, 1024))
    doc, n = await seed(db, rt)
    await reindex(db, rt, body(doc))
    first = set(store.records)
    await reindex(db, rt, body(doc))
    assert set(store.records) == first and len(await staged_rows(db, doc, 1024)) == n


async def test_same_identity_is_still_a_validation_error(db):
    doc, _ = await seed(db, None)
    same = ReindexBody.model_validate({"document_id": doc, "owner_id": "alice", "processing_version": 1,
                                      "source": {"provider": "mock", "model": "mock-embed", "dimension": 1536},
                                      "target": {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": 1536}})
    with pytest.raises(AppError) as e:
        await reindex(db, None, same)
    assert e.value.code == ErrorCode.VALIDATION
