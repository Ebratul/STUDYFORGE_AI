"""Backfill of existing PostgreSQL vectors into the vector store, and the orphan reconciler. Dry run first; resumable; never calls an embedding
provider; never changes a stored vector."""

from __future__ import annotations

import io
import json
from contextlib import redirect_stdout

import pytest

from app.errors import AppError, ErrorCode
from app.tools import backfill_pinecone as B
from app.tools.reconcile_pinecone import reconcile
from app.vectorstore import Identity, VectorRuntime, chunk_id
from app.vectorstore.memory import InMemoryVectorStore
from app.vectorstore.pinecone_store import PineconeStore
from tests.conftest import add_doc
from tests.test_vector_search import IDENT, find, put
from tests.vector_utils import INDEXES, fake_pinecone, memory_runtime, vec_settings

OPENAI = Identity("openai", "text-embedding-3-small", 1536)


async def legacy(db, doc, owner, idx, text, *, identity=OPENAI, version=1):
    """A chunk exactly as the pgvector-only pipeline left it: local vector, no Pinecone marker."""
    return await put(db, InMemoryVectorStore((1536, 768)), doc, owner, idx, text, identity=identity, version=version, local_vector=True, marked=False, indexed=False)


async def marker(db, cid) -> bool:
    async with db.connection() as conn:
        return (await (await conn.execute('SELECT "pineconeIndexedAt" IS NOT NULL FROM "DocumentChunk" WHERE "id"=%s', (cid,))).fetchone())[0]


async def vector_text(db) -> dict[str, str]:
    async with db.connection() as conn:
        return {r[0]: r[1] for r in await (await conn.execute('SELECT "id","embedding"::text FROM "DocumentChunk" WHERE "embedding" IS NOT NULL')).fetchall()}


@pytest.fixture
async def world(db):
    """Two users, several documents; some chunks the backfill must skip."""
    out = {"copy": [], "skip": {}}
    for owner, n in (("alice", 3), ("bob", 2)):
        for d in range(n):
            doc = await add_doc(db, owner, f"{owner}-d{d}", provider="OPENAI", model=OPENAI.model, version=1)
            for i in range(2):
                out["copy"].append(await legacy(db, doc, owner, i, f"{owner} {d} text {i}"))
    mock_doc = await add_doc(db, "alice", "alice-mock", provider="MOCK", model="mock-embed", version=1)
    out["skip"]["mock"] = await legacy(db, mock_doc, "alice", 0, "mock vectors", identity=IDENT)
    big_doc = await add_doc(db, "alice", "alice-768", provider="OPENAI", model="small", dimension=768, version=1)
    out["skip"]["768"] = await legacy(db, big_doc, "alice", 0, "other size", identity=Identity("openai", "small", 768))
    old_doc = await add_doc(db, "alice", "alice-old", provider="OPENAI", model=OPENAI.model, version=2)
    out["skip"]["old-version"] = await legacy(db, old_doc, "alice", 0, "stale version", version=1)  # not current: never copied, never counted
    proc = await add_doc(db, "alice", "alice-proc", status="PROCESSING", provider="OPENAI", model=OPENAI.model, version=1)
    out["skip"]["processing"] = await legacy(db, proc, "alice", 0, "not ready")
    return out


# ------------------------------------------------------------------------------------------------------------ dry run
async def test_dry_run_reports_and_changes_nothing(db, world):
    before = await vector_text(db)
    rep = await B.run_backfill(pool=db, store=None, supported={1536})
    d = rep.as_dict()
    assert d["mode"] == "dry-run" and d["chunks_copied"] == 0 and d["failures"] == []
    assert d["pending_by_identity"] == [{"provider": "openai", "model": OPENAI.model, "dimension": 1536, "chunks": len(world["copy"])}]
    assert d["skipped"] == {"mock-provider": 1, "unsupported-dimension": 1}
    assert d["documents_total"] == 5
    assert not any([await marker(db, c) for c in world["copy"]]) and await vector_text(db) == before


async def test_dry_run_never_needs_or_builds_a_store(db, world):
    rep = await B.run_backfill(pool=db, store=None, supported=None)  # no Pinecone configuration at all
    assert rep.as_dict()["skipped"]["no-pinecone-config"] == len(world["copy"]) + 1  # 768-d row counts too: nothing is known to be supported
    with pytest.raises(ValueError):
        await B.run_backfill(pool=db, store=None, supported={1536}, apply=True)


async def test_unknown_provider_rows_are_reported_not_guessed(db):
    doc = await add_doc(db, "alice", "d1", version=1)
    await legacy(db, doc, "alice", 0, "legacy chunk", identity=Identity("unknown", "m", 1536))
    other = await add_doc(db, "alice", "d2", version=1)
    await legacy(db, other, "alice", 0, "plain")
    d = (await B.run_backfill(pool=db, store=None, supported={1536})).as_dict()
    assert d["skipped"] == {"unknown-provider": 1} and d["pending_by_identity"][0]["chunks"] == 1


async def test_a_recorded_dimension_cannot_be_made_to_disagree_with_the_vector(db):
    """The migration's trigger re-derives the dimension from the vector, so 'inconsistent' rows cannot be created to begin with."""
    doc = await add_doc(db, "alice", "d1", version=1)
    cid = await legacy(db, doc, "alice", 0, "text")
    async with db.connection() as conn:
        await conn.execute('UPDATE "DocumentChunk" SET "embeddingDimension"=768 WHERE "id"=%s', (cid,))
        dim = (await (await conn.execute('SELECT "embeddingDimension" FROM "DocumentChunk" WHERE "id"=%s', (cid,))).fetchone())[0]
    assert dim == 1536


# ------------------------------------------------------------------------------------------------------------ apply
async def test_apply_copies_marks_and_leaves_postgres_vectors_untouched(db, world):
    store = InMemoryVectorStore((1536,))
    before = await vector_text(db)
    rep = await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)
    d = rep.as_dict()
    assert d["failures"] == [] and d["incomplete_documents"] == [] and d["chunks_copied"] == len(world["copy"]) and d["documents_done"] == 5
    assert all([await marker(db, c) for c in world["copy"]])
    assert not any([await marker(db, c) for c in world["skip"].values()])  # skipped rows are not marked
    assert {k[2] for k in store.records} == set(world["copy"])
    assert await vector_text(db) == before  # not a single stored vector was touched
    owners = {k[2]: k[0] for k in store.records}
    assert all(store.records[(owners[c], next(k[1] for k in store.records if k[2] == c), c)].processing_version == 1 for c in world["copy"])


async def test_apply_is_idempotent_and_rerunning_copies_nothing_more(db, world):
    store = InMemoryVectorStore((1536,))
    await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)
    n = len(store.records)
    again = await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)
    assert again.chunks_copied == 0 and again.documents_total == 0 and len(store.records) == n


async def test_the_copied_vectors_are_the_stored_vectors(db):
    doc = await add_doc(db, "alice", "d1", provider="OPENAI", model=OPENAI.model, version=1)
    cid = await legacy(db, doc, "alice", 0, "exact values")
    store = InMemoryVectorStore((1536,))
    await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)
    async with db.connection() as conn:
        stored = (await (await conn.execute('SELECT "embedding" FROM "DocumentChunk" WHERE "id"=%s', (cid,))).fetchone())[0]
    (rec,) = store.records.values()
    assert list(rec.values) == B._as_floats(stored) and rec.id == cid  # same ids, same numbers: nothing recomputed


async def test_resume_after_a_failure_finishes_the_rest(db, world):
    store = InMemoryVectorStore((1536,))
    calls = {"n": 0}
    real = store.upsert

    async def flaky(records):
        calls["n"] += 1
        if calls["n"] == 3:
            raise AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE)
        await real(records)

    store.upsert = flaky  # type: ignore[method-assign]
    first = await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)
    assert [f["code"] for f in first.failures] == ["VECTOR_STORE_UNAVAILABLE"] and first.documents_done == 4
    marked = [c for c in world["copy"] if await marker(db, c)]
    assert 0 < len(marked) < len(world["copy"])
    second = await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)  # "resume" = run it again
    assert second.failures == [] and second.documents_total == 1 and all([await marker(db, c) for c in world["copy"]])
    assert {k[2] for k in store.records} == set(world["copy"])


async def test_resume_after_a_given_document_skips_the_earlier_ones(db, world):
    store = InMemoryVectorStore((1536,))
    rep = await B.run_backfill(pool=db, store=store, supported={1536}, apply=True, resume_after="alice-d1")
    docs = {k[1] for k in store.records}
    assert docs == {"alice-d2", "bob-d0", "bob-d1"} and rep.documents_total == 3


async def test_a_dead_store_stops_the_run_after_three_failures(db, world):
    store = InMemoryVectorStore((1536,))
    store.fail("upsert", AppError(ErrorCode.VECTOR_STORE_AUTH), times=50)
    rep = await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)
    assert rep.documents_done == 0 and rep.failures[-1]["code"] == "ABORTED_AFTER_REPEATED_FAILURES" and len(rep.failures) == 4
    assert not any([await marker(db, c) for c in world["copy"]])  # nothing was marked without being seen in the store


async def test_a_document_that_is_not_fully_visible_is_not_marked(db, world):
    class Lossy(InMemoryVectorStore):
        async def count_document(self, **kw):
            return 0  # the store claims it can see nothing

    rep = await B.run_backfill(pool=db, store=Lossy((1536,)), supported={1536}, apply=True, owner_id="bob")
    assert len(rep.incomplete_documents) == 2 and rep.chunks_copied == 0
    assert not any([await marker(db, c) for c in world["copy"]])


async def test_owner_filter(db, world):
    store = InMemoryVectorStore((1536,))
    await B.run_backfill(pool=db, store=store, supported={1536}, apply=True, owner_id="bob")
    assert {k[0] for k in store.records} == {"bob"}


async def test_limit_documents(db, world):
    store = InMemoryVectorStore((1536,))
    rep = await B.run_backfill(pool=db, store=store, supported={1536}, apply=True, limit_documents=2)
    assert rep.documents_done == 2 and len({k[1] for k in store.records}) == 2


async def test_progress_callback_is_reported_per_document(db, world):
    seen = []
    await B.run_backfill(pool=db, store=InMemoryVectorStore((1536,)), supported={1536}, apply=True, progress=lambda r: seen.append((r.documents_done, r.last_document_id)))
    assert [n for n, _ in seen] == [1, 2, 3, 4, 5] and [d for _, d in seen] == sorted(d for _, d in seen)


async def test_the_migration_is_required(db, world, monkeypatch):
    monkeypatch.setattr(B, "SCHEMA_OK", "SELECT false, 'ALWAYS'")
    with pytest.raises(AppError) as e:
        await B.run_backfill(pool=db, store=None, supported={1536})
    assert e.value.code == ErrorCode.VECTOR_STORE_SCHEMA_NOT_READY


async def test_backfilled_data_is_served_by_pinecone_mode(db):
    """The point of the exercise: after a backfill, pinecone mode finds what pgvector mode finds."""
    doc = await add_doc(db, "alice", "d1", provider="MOCK", model="mock-embed", version=1)
    await put(db, InMemoryVectorStore(), doc, "alice", 0, "Mitochondria produce ATP", local_vector=True, marked=False, indexed=False)
    await put(db, InMemoryVectorStore(), doc, "alice", 1, "Ribosomes make proteins", local_vector=True, marked=False, indexed=False)
    rt, store = memory_runtime("pinecone")
    assert await find(db, rt, "alice", [doc], "mitochondria ATP", text="zzz") == []  # before: nothing is indexed yet
    # 'mock' rows are skipped by design, so register them as a real provider for this test only
    async with db.connection() as conn:
        await conn.execute('UPDATE "DocumentChunk" SET "embeddingProvider"=\'openai\' WHERE "documentId"=%s', (doc,))
    ident = Identity("openai", "mock-embed", 1536)
    await B.run_backfill(pool=db, store=store, supported={1536}, apply=True)
    res = await find(db, rt, "alice", [doc], "mitochondria ATP", text="zzz", identity=ident)
    base = await find(db, None, "alice", [doc], "mitochondria ATP", text="zzz", identity=ident)
    assert [c.chunk_id for c in res] == [c.chunk_id for c in base] and res[0].content == "Mitochondria produce ATP"


async def test_end_to_end_through_the_rest_store(db, world):
    fake = fake_pinecone()
    store = PineconeStore(vec_settings("pinecone"), client=fake.client())
    rep = await B.run_backfill(pool=db, store=store, supported=set(store.supported_dimensions()), apply=True, owner_id="bob")
    assert rep.failures == [] and rep.chunks_copied == 4
    assert {ns for (ns, _i) in fake.all_ids()} == {"dev-u-bob"}  # bob's vectors, bob's namespace
    assert all(i.split(":")[0].startswith("bob-d") for (_ns, i) in fake.all_ids())


async def test_cli_dry_run_prints_json_and_makes_no_store(db, world, monkeypatch):
    import argparse

    monkeypatch.setattr(B, "load_settings", lambda: vec_settings("pgvector", pinecone_indexes=INDEXES))
    built = []
    monkeypatch.setattr(PineconeStore, "__init__", lambda self, *a, **k: built.append(1))  # a dry run must never construct a store
    out = io.StringIO()
    with redirect_stdout(out):
        code = await B._amain(argparse.Namespace(apply=False, owner=None, limit_documents=None, state=None, resume=False))
    data = json.loads(out.getvalue())
    assert code == 0 and built == [] and data["mode"] == "dry-run" and data["chunks_copied"] == 0 and data["documents_total"] == 5


def test_cli_has_help_and_defaults_to_dry_run():
    with pytest.raises(SystemExit) as e:
        B.main(["--help"])
    assert e.value.code == 0
    assert B.__doc__ and "DRY RUN BY DEFAULT" in B.__doc__


# ------------------------------------------------------------------------------------------------------------ reconcile
async def test_reconcile_finds_and_removes_only_orphans(db):
    fake = fake_pinecone()
    store = PineconeStore(vec_settings("pinecone"), client=fake.client())
    rt = VectorRuntime(vec_settings("pinecone"), store)
    ready = await add_doc(db, "alice", "d-ready", version=1)
    queued = await add_doc(db, "alice", "d-queued", status="QUEUED", version=0)
    kept = await put(db, store, ready, "alice", 0, "committed chunk", identity=OPENAI)
    # crash leftovers: vectors with no PostgreSQL row, in a READY document and in a document that no longer exists
    from app.vectorstore import VectorRecord

    junk = [VectorRecord("a" * 32, ready, "alice", 2, OPENAI, [0.1] * 1536), VectorRecord("b" * 32, "d-deleted", "alice", 1, OPENAI, [0.1] * 1536)]
    inflight = VectorRecord("c" * 32, queued, "alice", 1, OPENAI, [0.1] * 1536)  # an ingest that is running right now
    await store.upsert([*junk, inflight])
    other = await put(db, store, await add_doc(db, "bob", "d-bob", version=1), "bob", 0, "bob chunk", identity=OPENAI)

    report = await reconcile(pool=db, store=store, owner_id="alice", apply=False)
    assert report["orphans"] == 2 and report["skipped_in_flight"] == 1 and report["deleted"] == 0 and len(fake.all_ids()) == 5
    report = await reconcile(pool=db, store=store, owner_id="alice", apply=True)
    assert report["deleted"] == 2
    left = {i for (_ns, i) in fake.all_ids()}
    assert left == {f"{ready}:{kept}", f"{queued}:{'c' * 32}", f"d-bob:{other}"}  # valid, in-flight and other users' vectors survive
    assert (await reconcile(pool=db, store=store, owner_id="alice", apply=True))["orphans"] == 0


async def test_reconcile_refuses_shared_namespaces(db):
    store = PineconeStore(vec_settings("pinecone", pinecone_namespace_mode="shared"), client=fake_pinecone().client())
    with pytest.raises(ValueError):
        await reconcile(pool=db, store=store, owner_id="alice", apply=True)
