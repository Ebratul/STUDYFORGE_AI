"""Hybrid retrieval + strict owner isolation, on REAL Postgres + pgvector."""

from __future__ import annotations

import uuid

import pytest
from pgvector import Vector

from app.errors import AppError, ErrorCode
from app.providers.mock import hash_embed
from app.retrieval import search as S
from app.retrieval.search import search_chunks
from tests.conftest import add_doc

MODEL = "mock-embed"
PROVIDER = "mock"


async def put(pool, doc, owner, idx, content, *, version=1, model=MODEL, provider=PROVIDER, page=None, section=None, vec_text=None, dim=1536):
    async with pool.connection() as conn:
        await conn.execute(
            'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section","content","tokenCount","embeddingProvider","embeddingModel","embedding") '
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (uuid.uuid4().hex, doc, owner, idx, version, page, section, content, 1, provider, model, Vector(hash_embed(vec_text or content, dim))),
        )


async def find(pool, owner, docs, query, *, model=MODEL, provider=PROVIDER, dim=1536, top_k=6, max_ctx=None, text=None):
    async with pool.connection() as conn:
        return await search_chunks(conn, owner_id=owner, document_ids=docs, query_embedding=hash_embed(query, dim),
                                   query_text=text if text is not None else query, embedding_provider=provider, embedding_model=model,
                                   embedding_dimension=dim, top_k=top_k, min_similarity=0.3, max_context_chars=max_ctx)


@pytest.fixture
async def corpus(db):
    a = await add_doc(db, "alice", name="Biology.pdf", version=1)
    b = await add_doc(db, "bob", name="BobSecrets.pdf", version=1)
    await put(db, a, "alice", 0, "Mitochondria produce ATP in the cell", page=3, section="Cells")
    await put(db, a, "alice", 1, "Ribosomes synthesise proteins from amino acids", page=4)
    await put(db, a, "alice", 2, "The Krebs cycle takes place in the mitochondrial matrix", page=5)
    await put(db, b, "bob", 0, "Bob private mitochondria ATP salary notes")
    return a, b


async def test_basic_search_returns_expected_shape_and_cosine(db, corpus):
    a, _ = corpus
    res = await find(db, "alice", [a], "mitochondria ATP")
    assert res[0].content.startswith("Mitochondria produce ATP") and res[0].rank == 1
    top = res[0]
    assert top.document_id == a and top.document_name == "Biology.pdf" and top.page == 3 and top.section == "Cells"
    expected = sum(x * y for x, y in zip(hash_embed("mitochondria ATP"), hash_embed(top.content)))
    assert top.similarity == pytest.approx(expected, abs=1e-5)  # real cosine, not a rank score
    assert [r.rank for r in res] == list(range(1, len(res) + 1))
    assert all(isinstance(r.similarity, float) for r in res)


async def test_user_a_never_sees_user_b(db, corpus):
    a, b = corpus
    # alice asks about bob's document id while presenting her own owner_id
    assert await find(db, "alice", [b], "mitochondria ATP salary") == []
    res = await find(db, "alice", [a, b], "mitochondria ATP salary notes")
    assert res and all(r.document_id == a for r in res) and all("Bob" not in r.content for r in res)
    # and the reverse
    res = await find(db, "bob", [a, b], "mitochondria ATP")
    assert res and all(r.document_id == b for r in res)


async def test_empty_document_ids_do_not_query(db, corpus):
    class Boom:
        def cursor(self, *a, **k):
            raise AssertionError("must not query")

    out = await search_chunks(Boom(), owner_id="alice", document_ids=[], query_embedding=hash_embed("x"), query_text="x",
                              embedding_provider=PROVIDER, embedding_model=MODEL, embedding_dimension=1536, top_k=3, min_similarity=0.3)
    assert out == []


async def test_other_processing_versions_are_hidden(db):
    d = await add_doc(db, "alice", version=2)
    await put(db, d, "alice", 0, "old version cells text", version=1)
    await put(db, d, "alice", 0, "current version cells text", version=2)
    res = await find(db, "alice", [d], "cells text")
    assert [r.content for r in res] == ["current version cells text"]


async def test_non_ready_documents_are_hidden(db):
    for status in ("QUEUED", "PROCESSING", "FAILED", "NEEDS_OCR"):
        d = await add_doc(db, "alice", status=status, version=1)
        await put(db, d, "alice", 0, f"hidden {status} content about cells")
        assert await find(db, "alice", [d], "cells") == [], status
    d = await add_doc(db, "alice", status="READY", version=1)
    await put(db, d, "alice", 0, "visible content about cells")
    assert len(await find(db, "alice", [d], "cells")) == 1


async def test_embedding_model_mismatch_is_hidden(db):
    d = await add_doc(db, "alice", version=1)
    await put(db, d, "alice", 0, "cells content", model="text-embedding-3-small")
    assert await find(db, "alice", [d], "cells content", model="text-embedding-3-large") == []
    assert len(await find(db, "alice", [d], "cells content", model="text-embedding-3-small")) == 1


async def test_chunk_owner_must_match_document_owner_in_query(db):
    """Even if a forged chunk row existed (trigger disabled), the query's d.ownerId predicate would hide it."""
    d = await add_doc(db, "alice", version=1)
    async with db.connection() as conn:
        await conn.execute('ALTER TABLE "DocumentChunk" DISABLE TRIGGER "DocumentChunk_owner_check"')
    try:
        await put(db, d, "mallory", 0, "forged chunk owned by mallory about cells")
        assert await find(db, "mallory", [d], "forged cells") == []   # d.ownerId != mallory
        assert await find(db, "alice", [d], "forged cells") == []     # c.ownerId != alice
    finally:
        async with db.connection() as conn:
            await conn.execute('ALTER TABLE "DocumentChunk" ENABLE TRIGGER "DocumentChunk_owner_check"')


@pytest.mark.parametrize("evil", [
    "alice' OR '1'='1", "x'; DROP TABLE \"Document\"; --", "' UNION SELECT content FROM \"DocumentChunk\" --",
    "\\'; SELECT pg_sleep(5); --", "%", "*", "a & b | !c", "(((", "\x00", "ａｂｃ",
])
async def test_sql_injection_shaped_inputs_are_inert(db, corpus, evil):
    a, b = corpus
    # as query text
    res = await find(db, "alice", [a], "mitochondria", text=evil)
    assert all(r.document_id == a for r in res)
    # as owner id / document id / model
    foreign = evil.replace("\x00", "") or "nobody"
    assert await find(db, foreign, [a], "mitochondria") == []
    res = await find(db, "alice", [foreign, a], "mitochondria")
    assert res and all(r.document_id == a for r in res)
    assert await find(db, "alice", [a], "mitochondria", model=evil.replace("\x00", "")) == []
    async with db.connection() as conn:  # tables still intact
        cur = await conn.execute('SELECT count(*) FROM "DocumentChunk"')
        assert (await cur.fetchone())[0] == 4


async def test_nul_in_query_text_is_stripped_not_fatal(db, corpus):
    a, _ = corpus
    res = await find(db, "alice", [a], "mitochondria", text="mito\x00chondria")
    assert all(r.document_id == a for r in res)


async def test_keyword_hits_are_fused_and_similarity_is_cosine_for_all(db):
    d = await add_doc(db, "alice", version=1)
    # semantically distant vector but contains the exact rare keyword in its text
    await put(db, d, "alice", 0, "supercalifragilistic appears only here in this chunk", vec_text="completely unrelated embedding words")
    for i in range(1, 12):
        await put(db, d, "alice", i, f"generic filler sentence number {i} about nothing")
    res = await find(db, "alice", [d], "supercalifragilistic", top_k=3)
    kw = [r for r in res if "supercalifragilistic" in r.content]
    assert kw, "keyword-only hit must be retrieved via the keyword leg"
    expected = sum(x * y for x, y in zip(hash_embed("supercalifragilistic"), hash_embed("completely unrelated embedding words")))
    assert kw[0].similarity == pytest.approx(expected, abs=1e-5)


async def test_top_k_and_context_budget(db):
    d = await add_doc(db, "alice", version=1)
    for i in range(10):
        await put(db, d, "alice", i, f"cells chunk {i} " + "padding " * 50)
    assert len(await find(db, "alice", [d], "cells chunk", top_k=4)) == 4
    budget = await find(db, "alice", [d], "cells chunk", top_k=10, max_ctx=900)
    assert 1 <= len(budget) < 10 and sum(len(r.content) for r in budget) <= 900 + len(budget[0].content)
    tiny = await find(db, "alice", [d], "cells chunk", top_k=10, max_ctx=10)
    assert len(tiny) == 1  # always keeps at least one
    assert [r.rank for r in budget] == list(range(1, len(budget) + 1))


async def test_wrong_dimension_query_vector(db, corpus):
    a, _ = corpus
    async with db.connection() as conn:
        with pytest.raises(AppError) as ei:
            await search_chunks(conn, owner_id="alice", document_ids=[a], query_embedding=[0.1] * 10, query_text="x",
                                embedding_provider=PROVIDER, embedding_model=MODEL, embedding_dimension=1536, top_k=3, min_similarity=0.3)
    assert ei.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH


async def test_missing_owner_is_rejected(db, corpus):
    a, _ = corpus
    async with db.connection() as conn:
        with pytest.raises(AppError):
            await search_chunks(conn, owner_id="", document_ids=[a], query_embedding=hash_embed("x"), query_text="x",
                                embedding_provider=PROVIDER, embedding_model=MODEL, embedding_dimension=1536, top_k=3, min_similarity=0.3)


def test_sql_is_parameterised_and_always_owner_scoped():
    sql = S.SQL
    for needle in ('c."ownerId" = %(owner)s', 'd."ownerId" = %(owner)s', 'c."documentId" = ANY(%(doc_ids)s)',
                   'c."processingVersion" = d."processingVersion"', "d.\"status\" = 'READY'", 'c."embeddingModel" = %(embedding_model)s',
                   'c."embeddingProvider" = %(embedding_provider)s', 'c."embeddingDimension" = %(dim)s', 'vector_dims(c."embedding") = %(dim)s',
                   "base AS MATERIALIZED"):
        assert needle in sql
    assert "{" not in sql and "f'" not in sql
    assert "USING hnsw" not in sql.lower() and "ivfflat" not in sql.lower()
