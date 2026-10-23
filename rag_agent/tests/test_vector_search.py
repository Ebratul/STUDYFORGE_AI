"""Retrieval with a remote vector store. PostgreSQL has the final say: a hostile, stale or buggy store can only ever return ids that
PostgreSQL then accepts or drops. Real PostgreSQL; in-memory store with a hostile-results hook."""

from __future__ import annotations

import asyncio
import logging

import pytest

from app.errors import AppError, ErrorCode
from app.providers.mock import hash_embed
from app.retrieval.search import search_chunks
from app.vectorstore import Candidate, Identity, VectorRecord, VectorRuntime, chunk_id
from app.vectorstore.memory import InMemoryVectorStore
from tests.conftest import add_doc
from tests.vector_utils import memory_runtime, vec_settings

IDENT = Identity("mock", "mock-embed", 1536)
SECRET_WORDS = ["ZEBRAFISH", "QUOKKA", "VIGNETTE"]


async def put(db, store, doc, owner, idx, content, *, version=1, identity=IDENT, local_vector=False, marked=True, indexed=True, page=None, section=None):
    """One chunk in the shape the pipeline writes: text/ownership in PostgreSQL, vector in the store (and optionally locally as well)."""
    from pgvector import Vector

    cid = chunk_id(doc, version, identity, idx)
    vec = hash_embed(content, identity.dimension)
    async with db.connection() as conn:
        await conn.execute(
            'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section","content","tokenCount",'
            '"embeddingProvider","embeddingModel","embedding","embeddingDimension","pineconeIndexedAt") '
            f"VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s,{'now()' if marked else 'NULL'})",
            (cid, doc, owner, idx, version, page, section, content, identity.provider, identity.model, Vector(vec) if local_vector else None, identity.dimension))
    if indexed:
        await store.upsert([VectorRecord(cid, doc, owner, version, identity, vec)])
    return cid


async def find(db, rt, owner, docs, query, *, text=None, top_k=6, identity=IDENT, max_ctx=None):
    async with db.connection() as conn:
        return await search_chunks(conn, owner_id=owner, document_ids=docs, query_embedding=hash_embed(query, identity.dimension),
                                   query_text=text if text is not None else query, embedding_provider=identity.provider,
                                   embedding_model=identity.model, embedding_dimension=identity.dimension, top_k=top_k, min_similarity=0.3,
                                   max_context_chars=max_ctx, vectors=rt)


@pytest.fixture
async def corpus(db):
    rt, store = memory_runtime("pinecone")
    a = await add_doc(db, "alice", name="Biology.pdf", version=1)
    b = await add_doc(db, "bob", name="BobSecrets.pdf", version=1)
    ids = {
        "atp": await put(db, store, a, "alice", 0, "Mitochondria produce ATP in the cell", page=3, section="Cells"),
        "ribo": await put(db, store, a, "alice", 1, "Ribosomes synthesise proteins from amino acids", page=4),
        "krebs": await put(db, store, a, "alice", 2, "The Krebs cycle takes place in the mitochondrial matrix", page=5),
        "bob": await put(db, store, b, "bob", 0, "Bob private mitochondria ATP salary notes"),
    }
    return rt, store, a, b, ids


# ------------------------------------------------------------------------------------------------------------ basic behaviour
async def test_results_come_from_the_store_but_text_and_metadata_from_postgres(db, corpus):
    rt, store, a, _, ids = corpus
    res = await find(db, rt, "alice", [a], "mitochondria ATP")
    top = res[0]
    assert top.chunk_id == ids["atp"] and top.content == "Mitochondria produce ATP in the cell" and top.rank == 1
    assert top.document_id == a and top.document_name == "Biology.pdf" and top.page == 3 and top.section == "Cells"
    expected = sum(x * y for x, y in zip(hash_embed("mitochondria ATP"), hash_embed(top.content)))
    assert top.similarity == pytest.approx(expected, abs=1e-5)  # the store's cosine score
    assert [r.rank for r in res] == list(range(1, len(res) + 1))


async def test_no_authorised_documents_means_no_store_call(db, corpus):
    rt, store, a, b, _ = corpus
    n = len(store.calls)
    assert await find(db, rt, "alice", [b], "mitochondria") == []  # bob's document, alice's request
    assert await find(db, rt, "alice", ["does-not-exist"], "mitochondria") == []
    assert await find(db, rt, "alice", [], "mitochondria") == []
    assert len(store.calls) == n  # the store was not even asked


async def test_not_ready_documents_are_not_searched(db):
    rt, store = memory_runtime("pinecone")
    d = await add_doc(db, "alice", status="PROCESSING", version=1)
    await put(db, store, d, "alice", 0, "mitochondria ATP")
    assert await find(db, rt, "alice", [d], "mitochondria ATP") == []


# ------------------------------------------------------------------------------------------------------------ hostile store
async def test_the_store_cannot_widen_what_a_user_sees(db, corpus):
    rt, store, a, b, ids = corpus
    other = await add_doc(db, "alice", name="Other.pdf", version=1)
    elsewhere = await put(db, store, other, "alice", 0, "Mitochondria in a document that was not requested")
    stale_doc = await add_doc(db, "alice", name="Versions.pdf", version=2)
    stale = await put(db, store, stale_doc, "alice", 0, "mitochondria ATP from an old version", version=1)  # doc is at v2
    failed = await add_doc(db, "alice", name="Failed.pdf", status="FAILED", version=1)
    in_failed = await put(db, store, failed, "alice", 0, "mitochondria ATP in a failed document")
    other_model = await put(db, store, a, "alice", 7, "mitochondria ATP under another model", identity=Identity("mock", "other-model", 1536))
    unmarked = await put(db, store, a, "alice", 8, "unrelated words entirely", marked=False)
    store.hostile = [Candidate(ids["bob"], 0.99),            # another user's chunk
                     Candidate("0" * 32, 0.98),              # an id PostgreSQL has never seen
                     Candidate(elsewhere, 0.97),             # alice's own chunk, but of a document that was not requested
                     Candidate(stale, 0.96),                 # alice's chunk of an old version
                     Candidate(in_failed, 0.95),             # a document that is not READY
                     Candidate(other_model, 0.94),           # another embedding identity
                     Candidate(unmarked, 0.93)]              # PostgreSQL does not list it as indexed in the store
    res = await find(db, rt, "alice", [a], "mitochondria ATP", text="zzz-no-keyword-match")
    got = {r.chunk_id for r in res}
    assert got and got <= {ids["atp"], ids["ribo"], ids["krebs"]}
    for bad in (ids["bob"], "0" * 32, elsewhere, stale, in_failed, other_model, unmarked):
        assert bad not in got
    assert all(r.document_id == a for r in res) and "salary" not in " ".join(r.content for r in res)


async def test_a_foreign_chunk_never_appears_even_if_the_store_ranks_it_first(db, corpus):
    rt, store, a, b, ids = corpus
    store.hostile = [Candidate(ids["bob"], 1.0)]
    res = await find(db, rt, "alice", [a, b], "Bob private mitochondria ATP salary notes")  # alice also lists bob's document id
    assert ids["bob"] not in {r.chunk_id for r in res} and all(r.document_id == a for r in res)


async def test_the_store_is_only_asked_about_authorised_documents(db, corpus):
    rt, store, a, b, _ = corpus
    await find(db, rt, "alice", [a, b, "ghost"], "mitochondria")
    (_, info) = [c for c in store.calls if c[0] == "query"][-1]
    assert info == {"owner": "alice", "docs": [a]}


async def test_orphaned_vectors_are_harmless(db, corpus):
    """Vectors with no PostgreSQL row (crash leftovers) rank first in the store but cannot be returned."""
    rt, store, a, _, ids = corpus
    for i in range(5):
        await store.upsert([VectorRecord(f"{i:032d}", a, "alice", 1, IDENT, hash_embed("mitochondria ATP in the cell"))])
    res = await find(db, rt, "alice", [a], "mitochondria ATP in the cell")
    assert {r.chunk_id for r in res} <= set(ids.values()) and res[0].chunk_id == ids["atp"]


async def test_stale_version_vectors_do_not_crowd_out_current_ones(db):
    rt, store = memory_runtime("pinecone")
    d = await add_doc(db, "alice", version=2)
    current = await put(db, store, d, "alice", 0, "mitochondria ATP current", version=2)
    for i in range(30):  # a lagging cleanup left many old-version vectors that match even better
        await store.upsert([VectorRecord(f"{i:032d}", d, "alice", 1, IDENT, hash_embed("mitochondria ATP current"))])
    res = await find(db, rt, "alice", [d], "mitochondria ATP current", top_k=3)
    assert [r.chunk_id for r in res] == [current]  # the version filter keeps them out of the candidate window


# ------------------------------------------------------------------------------------------------------------ hybrid behaviour
async def test_keyword_hits_still_work_and_rank_by_fusion(db, corpus):
    rt, store, a, _, ids = corpus
    res = await find(db, rt, "alice", [a], "completely different", text="ribosomes proteins")
    assert ids["ribo"] in {r.chunk_id for r in res}


async def test_keyword_only_hits_do_not_pass_the_similarity_gate_alone(db):
    rt, store = memory_runtime("pinecone")
    d = await add_doc(db, "alice", version=1)
    cid = await put(db, store, d, "alice", 0, "quokka vignette", indexed=False)  # in PostgreSQL, not in the store
    res = await find(db, rt, "alice", [d], "unrelated question", text="quokka")
    assert [r.chunk_id for r in res] == [cid] and res[0].similarity == 0.0


async def test_chunks_missing_from_the_store_are_still_found_by_keyword(db):
    rt, store = memory_runtime("pinecone")
    d = await add_doc(db, "alice", version=1)
    cid = await put(db, store, d, "alice", 0, "quokka vignette", marked=False, indexed=False)  # not backfilled yet
    assert [r.chunk_id for r in await find(db, rt, "alice", [d], "x", text="quokka")] == [cid]


async def test_context_budget_is_applied_like_in_pgvector_mode(db):
    rt, store = memory_runtime("pinecone")
    d = await add_doc(db, "alice", version=1)
    for i in range(4):
        await put(db, store, d, "alice", i, f"mitochondria passage {i} " + "x" * 400)
    res = await find(db, rt, "alice", [d], "mitochondria passage", max_ctx=500)
    assert len(res) == 1  # the best chunk is always kept; the rest do not fit


async def test_parity_with_the_pgvector_query(db):
    """Same corpus, vectors both in PostgreSQL and in the store: pgvector mode and pinecone mode agree on ids, order and scores."""
    rt, store = memory_runtime("pinecone")
    d = await add_doc(db, "alice", version=1)
    texts = ["Mitochondria produce ATP in the cell", "Ribosomes synthesise proteins", "The Krebs cycle in the matrix", "ATP synthase and the proton gradient",
             "Chloroplasts perform photosynthesis", "DNA replication happens in the nucleus", "Cell membranes are lipid bilayers"]
    for i, t in enumerate(texts):
        await put(db, store, d, "alice", i, t, local_vector=True)
    for q, kw in (("mitochondria ATP", "ATP"), ("photosynthesis chloroplast", "chloroplasts"), ("lipid membranes", "zzz")):
        pg = await find(db, None, "alice", [d], q, text=kw)
        pc = await find(db, rt, "alice", [d], q, text=kw)
        assert [c.chunk_id for c in pc] == [c.chunk_id for c in pg], q
        assert [c.similarity for c in pc] == pytest.approx([c.similarity for c in pg], abs=1e-5)


# ------------------------------------------------------------------------------------------------------------ failures
async def test_store_failure_surfaces_as_a_coded_retryable_error(db, corpus):
    rt, store, a, _, _ = corpus
    store.fail("query", AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE))
    with pytest.raises(AppError) as e:
        await find(db, rt, "alice", [a], "mitochondria")
    assert e.value.code == ErrorCode.VECTOR_STORE_UNAVAILABLE and e.value.retryable


async def test_unsupported_dimension_is_an_error_not_a_silent_miss(db):
    rt, store = memory_runtime("pinecone", dimensions=(3072,))
    d = await add_doc(db, "alice", version=1)
    await put(db, InMemoryVectorStore((1536,)), d, "alice", 0, "mitochondria")
    with pytest.raises(AppError) as e:
        await find(db, rt, "alice", [d], "mitochondria")
    assert e.value.code == ErrorCode.VECTOR_DIMENSION_UNSUPPORTED


async def test_wrong_length_query_vector_is_an_error(db, corpus):
    rt, _, a, _, _ = corpus
    async with db.connection() as conn:
        with pytest.raises(AppError) as e:
            await search_chunks(conn, owner_id="alice", document_ids=[a], query_embedding=[0.1] * 1535, query_text="x", embedding_provider="mock",
                                embedding_model="mock-embed", embedding_dimension=1536, top_k=3, vectors=rt)
    assert e.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH


async def test_pinecone_mode_requires_the_migration(db, corpus, monkeypatch):
    from app.vectorstore import runtime

    monkeypatch.setattr(runtime, "SCHEMA_SQL", "SELECT false, 'ALWAYS'")
    rt, _, a, _, _ = corpus
    with pytest.raises(AppError) as e:
        await find(db, rt, "alice", [a], "mitochondria")
    assert e.value.code == ErrorCode.VECTOR_STORE_SCHEMA_NOT_READY


# ------------------------------------------------------------------------------------------------------------ dual mode
def events(caplog, name):
    return [r for r in caplog.records if getattr(r, "event", None) == name]


@pytest.fixture
async def dual(db):
    rt, store = memory_runtime("dual")
    d = await add_doc(db, "alice", version=1)
    ids = [await put(db, store, d, "alice", i, t, local_vector=True) for i, t in
           enumerate(["Mitochondria produce ATP", "Ribosomes make proteins", "The Krebs cycle makes ATP", "Zebrafish vignette quokka"])]
    return rt, store, d, ids


async def test_dual_serves_postgres_results_exactly(db, dual, caplog):
    rt, store, d, ids = dual
    caplog.set_level(logging.INFO)
    served = await find(db, rt, "alice", [d], "mitochondria ATP", text="ATP")
    baseline = await find(db, None, "alice", [d], "mitochondria ATP", text="ATP")
    assert served == baseline
    (ev,) = events(caplog, "vector_shadow_compare")
    assert ev.levelno == logging.INFO and ev.jaccard == 1.0 and ev.top1_same is True and ev.only_pgvector == 0 and ev.only_pinecone == 0
    assert ev.same_order is True and ev.max_similarity_delta < 1e-5


async def test_dual_logs_divergence_when_the_stores_disagree(db, dual, caplog):
    rt, store, d, ids = dual
    caplog.set_level(logging.INFO)
    for k in [k for k in store.records if k[2] in (ids[0], ids[2])]:  # the store lost the two best vectors
        del store.records[k]
    served = await find(db, rt, "alice", [d], "mitochondria ATP", text="zzz")
    baseline = await find(db, None, "alice", [d], "mitochondria ATP", text="zzz")
    assert served == baseline  # the user still gets the PostgreSQL answer
    (ev,) = events(caplog, "vector_shadow_compare")
    assert ev.levelno == logging.WARNING and ev.only_pgvector >= 1 and ev.jaccard < 1.0 and ev.top1_same is False


async def test_a_failing_store_never_affects_dual_results(db, dual, caplog):
    rt, store, d, ids = dual
    caplog.set_level(logging.INFO)
    baseline = await find(db, None, "alice", [d], "mitochondria ATP", text="ATP")
    store.fail("query", AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE))
    assert await find(db, rt, "alice", [d], "mitochondria ATP", text="ATP") == baseline
    (ev,) = events(caplog, "vector_shadow_failed")
    assert ev.code == "VECTOR_STORE_UNAVAILABLE" and ev.levelno == logging.WARNING and not events(caplog, "vector_shadow_compare")


async def test_a_hanging_store_is_cut_off_by_the_shadow_budget(db, caplog):
    class Hangs(InMemoryVectorStore):
        async def query(self, **kw):
            await asyncio.sleep(30)

    store = Hangs((1536,))
    rt = VectorRuntime(vec_settings("dual", vector_shadow_timeout_seconds=0.1), store)
    d = await add_doc(db, "alice", version=1)
    await put(db, store, d, "alice", 0, "mitochondria ATP", local_vector=True)
    caplog.set_level(logging.INFO)
    t0 = asyncio.get_running_loop().time()
    served = await find(db, rt, "alice", [d], "mitochondria ATP")
    assert asyncio.get_running_loop().time() - t0 < 5 and len(served) == 1
    (ev,) = events(caplog, "vector_shadow_failed")
    assert ev.exc_type in ("TimeoutError", "CancelledError")


async def test_a_hostile_store_cannot_change_dual_results_or_leak_through_the_comparison(db, dual, caplog):
    rt, store, d, ids = dual
    bob_doc = await add_doc(db, "bob", version=1)
    bob_chunk = await put(db, InMemoryVectorStore((1536,)), bob_doc, "bob", 0, "bob private salary")
    store.hostile = [Candidate(bob_chunk, 1.0)]
    caplog.set_level(logging.INFO)
    baseline = await find(db, None, "alice", [d], "mitochondria ATP", text="ATP")
    assert await find(db, rt, "alice", [d], "mitochondria ATP", text="ATP") == baseline
    (ev,) = events(caplog, "vector_shadow_compare")
    assert ev.only_pinecone == 0  # the foreign chunk was dropped before the comparison


async def test_shadow_logs_carry_no_document_text(db, dual, caplog):
    rt, store, d, ids = dual
    caplog.set_level(logging.DEBUG)
    await find(db, rt, "alice", [d], "Zebrafish vignette quokka", text="quokka")
    blob = "\n".join(r.getMessage() + repr(sorted(r.__dict__.items(), key=lambda kv: kv[0])) for r in caplog.records).lower()
    assert events(caplog, "vector_shadow_compare")
    for text in ("mitochondria produce atp", "ribosomes make proteins", "the krebs cycle makes atp", "zebrafish vignette quokka"):
        assert text not in blob
