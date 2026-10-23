"""Ingestion in pgvector / dual / pinecone mode: what is written where, and what happens when one of the two stores fails.

PostgreSQL is real (disposable rag test database); the vector store is the in-memory fake, with scripted faults."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.errors import AppError, ErrorCode
from app.ingest import pipeline
from app.ingest.pipeline import IngestMeta, run_ingest
from app.providers.mock import VALID_KEY
from app.providers.registry import ProviderRegistry
from app.vectorstore import Identity, VectorRuntime, chunk_id
from app.vectorstore.memory import InMemoryVectorStore
from tests.conftest import CANARY_KEY, add_doc, make_settings
from tests.fakes import FakeProvider
from tests.vector_utils import memory_runtime, vec_settings

TEXT = (b"Mitochondria produce ATP in the cell through oxidative phosphorylation. " * 5 + b"\n\n") * 12
MOCK = Identity("mock", "mock-embed", 1536)


def imeta(doc, *, owner="alice", version=1, provider="mock", key=VALID_KEY, model="mock-embed", dimension=1536) -> IngestMeta:
    return IngestMeta.model_validate({
        "document_id": doc, "owner_id": owner, "filename": "n.txt", "mime_type": "text/plain", "processing_version": version,
        "embedding": {"provider": provider, "api_key": key, "model": model, "dimension": dimension},
    })


async def run(db, rt: VectorRuntime | None, m: IngestMeta, data: bytes = TEXT, registry=None) -> list[dict]:
    settings = rt.settings if rt else make_settings()
    return [ev async for ev in run_ingest(settings=settings, pool=db, registry=registry or ProviderRegistry(settings), meta=m,
                                          filename_ext="txt", data=data, vectors=rt)]


async def rows(db, doc):
    async with db.connection() as conn:
        cur = await conn.execute(
            'SELECT "id","processingVersion","embedding" IS NOT NULL,"embeddingDimension","pineconeIndexedAt" IS NOT NULL,"chunkIndex" '
            'FROM "DocumentChunk" WHERE "documentId"=%s ORDER BY "processingVersion","chunkIndex"', (doc,))
        return await cur.fetchall()


async def doc_version(db, doc) -> int:
    async with db.connection() as conn:
        return (await (await conn.execute('SELECT "processingVersion" FROM "Document" WHERE "id"=%s', (doc,))).fetchone())[0]


def expected_ids(doc, version, n, identity=MOCK):
    return [chunk_id(doc, version, identity, i) for i in range(n)]


# ------------------------------------------------------------------------------------------------------------ where things go
async def test_pgvector_mode_is_unchanged_and_never_touches_pinecone(db):
    doc = await add_doc(db, "alice")
    ev = await run(db, None, imeta(doc))
    res = ev[-1]
    assert res["status"] == "READY" and "superseded" not in res  # the result shape is the one the backend already knows
    r = await rows(db, doc)
    assert [x[0] for x in r] == expected_ids(doc, 1, len(r))  # deterministic ids in every mode
    assert all(x[2] is True and x[3] == 1536 and x[4] is False for x in r)  # vector in Postgres, no Pinecone marker


async def test_pinecone_mode_by_default_also_keeps_the_postgres_vector_so_rollback_is_just_a_flag(db):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    assert (await run(db, rt, imeta(doc)))[-1]["status"] == "READY"
    r = await rows(db, doc)
    assert all(x[2] is True and x[3] == 1536 and x[4] is True for x in r) and {k[2] for k in store.records} == {x[0] for x in r}
    # ...and with the flag back at pgvector the very same document is found, without any re-embedding or migration of data
    from app.providers.mock import hash_embed
    from app.retrieval.search import search_chunks

    async with db.connection() as conn:
        found = await search_chunks(conn, owner_id="alice", document_ids=[doc], query_embedding=hash_embed("Mitochondria produce ATP"), query_text="ATP",
                                    embedding_provider="mock", embedding_model="mock-embed", embedding_dimension=1536, top_k=3, vectors=None)
    assert found and found[0].document_id == doc and found[0].similarity > 0.3


async def test_pinecone_mode_can_opt_out_of_the_postgres_copy_and_then_keeps_vectors_only_in_the_store(db):
    rt, store = memory_runtime("pinecone", pinecone_keep_postgres_vectors=False)
    doc = await add_doc(db, "alice")
    ev = await run(db, rt, imeta(doc))
    res = ev[-1]
    assert res["status"] == "READY" and res["embedding_dimension"] == 1536
    r = await rows(db, doc)
    assert res["chunk_count"] == len(r) >= 1
    assert all(x[2] is False and x[3] == 1536 and x[4] is True for x in r)  # no local vector; dimension explicit; marker set
    assert {k[2] for k in store.records} == {x[0] for x in r} == set(expected_ids(doc, 1, len(r)))
    assert all(k[0] == "alice" and k[1] == doc for k in store.records)
    assert res["superseded"] == [] and res["superseded_truncated"] is False
    assert await doc_version(db, doc) == 1
    stages = [e["stage"] for e in ev if e["type"] == "progress"]
    assert stages[-2:] == ["store", "store"] and [e["progress"] for e in ev if e["type"] == "progress"][-2:] == [93, 95]


async def test_dual_mode_writes_both_places(db):
    rt, store = memory_runtime("dual")
    doc = await add_doc(db, "alice")
    ev = await run(db, rt, imeta(doc))
    assert ev[-1]["status"] == "READY"
    r = await rows(db, doc)
    assert all(x[2] is True and x[3] == 1536 and x[4] is True for x in r)  # local vector AND marker
    assert {k[2] for k in store.records} == {x[0] for x in r}


async def test_a_new_version_reports_the_previous_versions_vectors_for_the_delete_job(db):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    await run(db, rt, imeta(doc, version=1))
    v1 = {r[0] for r in await rows(db, doc)}
    ev = await run(db, rt, imeta(doc, version=2))
    res = ev[-1]
    assert res["status"] == "READY" and not res["superseded_truncated"]
    (group,) = res["superseded"]
    assert group["identity"] == {"provider": "mock", "model": "mock-embed", "dimension": 1536}
    assert {c for _d, c in group["chunks"]} == v1 and all(d == doc for d, _c in group["chunks"])
    assert {r[1] for r in await rows(db, doc)} == {2}  # PostgreSQL already dropped v1
    assert v1 <= store.ids("alice")  # ...the store keeps v1 until the retried delete job runs; v1 vectors are invisible to retrieval meanwhile


async def test_every_error_and_result_is_free_of_keys(db):
    rt, _ = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    reg = ProviderRegistry(rt.settings)
    reg.register_for_tests(FakeProvider("openai"))
    ev = await run(db, rt, imeta(doc, provider="openai", key=CANARY_KEY, model="text-embedding-3-small"), registry=reg)
    assert CANARY_KEY not in json.dumps(ev)


# ------------------------------------------------------------------------------------------------------------ failures
async def test_store_failure_is_retryable_and_leaves_postgres_untouched(db):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    await run(db, rt, imeta(doc, version=1))
    before, ids_before = await rows(db, doc), store.ids()
    store.fail("upsert", AppError(ErrorCode.VECTOR_STORE_RATE_LIMITED, retry_after_seconds=4))
    ev = await run(db, rt, imeta(doc, version=2))
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "VECTOR_STORE_RATE_LIMITED" and ev[-1]["retryable"] is True
    assert ev[-1]["retry_after_seconds"] == 4
    assert await rows(db, doc) == before and await doc_version(db, doc) == 1 and store.ids() == ids_before


async def test_a_partial_upsert_is_rolled_back_by_deleting_exactly_what_was_written(db):
    class StoresThenFails(InMemoryVectorStore):
        async def upsert(self, records):
            await super().upsert(records)
            raise AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE)  # e.g. the visibility wait timed out after the data was accepted

    store = StoresThenFails((1536,))
    rt = VectorRuntime(vec_settings("pinecone"), store)
    doc = await add_doc(db, "alice")
    ev = await run(db, rt, imeta(doc))
    assert ev[-1]["code"] == "VECTOR_STORE_UNAVAILABLE" and ev[-1]["retryable"] is True
    assert store.records == {} and await rows(db, doc) == [] and await doc_version(db, doc) == 0


async def test_a_postgres_failure_after_the_upsert_removes_the_orphans(db, monkeypatch):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    await run(db, rt, imeta(doc, version=1))
    keep = store.ids()

    async def boom(*a, **k):
        raise RuntimeError("database went away")

    monkeypatch.setattr(pipeline, "_store_ext", boom)
    ev = await run(db, rt, imeta(doc, version=2))
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "INTERNAL"
    assert store.ids() == keep  # v2's vectors were deleted again; v1's are untouched
    assert await doc_version(db, doc) == 1


class BadLast(FakeProvider):
    async def embed(self, req):
        res = await super().embed(req)
        res.vectors[-1] = [float("nan")] * 1536  # right length; the adapter-level finite check is bypassed by this fake
        return res


async def _dual_with_bad_vector(db, store):
    rt = VectorRuntime(vec_settings("dual"), store)
    reg = ProviderRegistry(rt.settings)
    reg.register_for_tests(BadLast("openai"))
    doc = await add_doc(db, "alice")
    ev = await run(db, rt, imeta(doc, provider="openai", key=CANARY_KEY, model="m"), registry=reg)
    return doc, ev


async def test_a_non_finite_vector_rejected_by_the_store_after_a_partial_write_is_cleaned_up(db):
    store = InMemoryVectorStore((1536,))  # validates like Pinecone: stores the good records, then refuses the NaN one
    doc, ev = await _dual_with_bad_vector(db, store)
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "PROVIDER_ERROR" and ev[-1]["retryable"] is False
    assert store.records == {} and await rows(db, doc) == [] and await doc_version(db, doc) == 0


async def test_dual_mode_postgres_refusing_a_vector_the_store_accepted_removes_the_orphans(db):
    class LaxStore(InMemoryVectorStore):
        async def upsert(self, records):  # accepts everything, including the NaN vector
            for r in records:
                self.records[(r.owner_id, r.document_id, r.id)] = r

    store = LaxStore((1536,))
    doc, ev = await _dual_with_bad_vector(db, store)
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "INTERNAL"  # pgvector refused NaN at INSERT time; the transaction rolled back
    assert store.records == {} and await rows(db, doc) == [] and await doc_version(db, doc) == 0


async def test_stale_version_removes_the_vectors_it_just_wrote(db):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    await run(db, rt, imeta(doc, version=5))
    keep = store.ids()
    ev = await run(db, rt, imeta(doc, version=2))
    assert ev[-1]["status"] == "FAILED" and ev[-1]["code"] == "STALE_VERSION"
    assert store.ids() == keep and {r[1] for r in await rows(db, doc)} == {5} and await doc_version(db, doc) == 5


async def test_retry_after_a_failed_commit_is_idempotent(db, monkeypatch):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    real, calls = pipeline._store_ext, {"n": 0}

    async def flaky(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return await real(*a, **k)

    monkeypatch.setattr(pipeline, "_store_ext", flaky)
    first = await run(db, rt, imeta(doc, version=1))
    assert first[-1]["type"] == "error" and store.records == {}
    second = await run(db, rt, imeta(doc, version=1))  # the backend's job retry: same version
    assert second[-1]["status"] == "READY"
    r = await rows(db, doc)
    assert {k[2] for k in store.records} == {x[0] for x in r} == set(expected_ids(doc, 1, len(r)))  # same ids, one copy


async def test_running_the_same_version_twice_leaves_one_copy(db):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    await run(db, rt, imeta(doc, version=1))
    n = len(store.records)
    await run(db, rt, imeta(doc, version=1))
    assert len(store.records) == n and len(await rows(db, doc)) == n


async def test_unsupported_dimension_fails_before_any_embedding_or_write(db):
    rt, store = memory_runtime("pinecone", dimensions=(3072,))
    doc = await add_doc(db, "alice")
    fake = FakeProvider("openai")
    reg = ProviderRegistry(rt.settings)
    reg.register_for_tests(fake)
    ev = await run(db, rt, imeta(doc, provider="openai", key=CANARY_KEY, model="m"), registry=reg)
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "VECTOR_DIMENSION_UNSUPPORTED" and ev[-1]["retryable"] is False
    assert "3072" in ev[-1]["message"] and "1536" in ev[-1]["message"]
    assert fake.embed_calls == 0 and store.calls == [] and await rows(db, doc) == []


async def test_missing_migration_is_reported_before_any_work(db, monkeypatch):
    from app.vectorstore import runtime

    monkeypatch.setattr(runtime, "SCHEMA_SQL", "SELECT false, 'ALWAYS'")
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    fake = FakeProvider("openai")
    reg = ProviderRegistry(rt.settings)
    reg.register_for_tests(fake)
    ev = await run(db, rt, imeta(doc, provider="openai", key=CANARY_KEY, model="m"), registry=reg)
    assert ev[-1]["code"] == "VECTOR_STORE_SCHEMA_NOT_READY" and ev[-1]["retryable"] is False
    assert fake.embed_calls == 0 and store.calls == []


async def test_a_pgvector_runtime_does_not_require_the_migration(db, monkeypatch):
    from app.vectorstore import runtime

    monkeypatch.setattr(runtime, "SCHEMA_SQL", "SELECT false, 'ALWAYS'")
    doc = await add_doc(db, "alice")
    ev = await run(db, VectorRuntime(make_settings()), imeta(doc))
    assert ev[-1]["status"] == "READY"


async def test_cancellation_after_the_upsert_deletes_what_was_written(db, monkeypatch):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    reached = asyncio.Event()

    async def hang(*a, **k):
        reached.set()
        await asyncio.sleep(60)

    monkeypatch.setattr(pipeline, "_store_ext", hang)
    t = asyncio.create_task(run(db, rt, imeta(doc)))
    await asyncio.wait_for(reached.wait(), 10)
    assert store.records  # the vectors are in the store at this moment
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert store.records == {} and await rows(db, doc) == []


async def test_compensation_failure_is_logged_not_raised_and_orphans_stay_unreachable(db, monkeypatch, caplog):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")

    async def boom(*a, **k):
        raise RuntimeError("db")

    monkeypatch.setattr(pipeline, "_store_ext", boom)
    store.fail("delete", AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE))  # the cleanup itself fails
    ev = await run(db, rt, imeta(doc))
    assert ev[-1]["code"] == "INTERNAL"  # the original failure is what the caller sees
    assert store.records  # orphans remain in the store...
    assert await rows(db, doc) == []  # ...but PostgreSQL has no row for them, so retrieval can never return them
    assert any(getattr(r, "event", "") == "ingest_vector_compensation_failed" for r in caplog.records)
