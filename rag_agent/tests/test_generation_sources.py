"""sample_chunks: same isolation guarantees as search_chunks, on REAL Postgres."""

from __future__ import annotations

import pytest

from app.errors import AppError, ErrorCode
from app.generation.sources import sample_chunks
from tests.conftest import add_doc
from tests.test_retrieval import put


async def sample(pool, owner, docs, n=36):
    async with pool.connection() as conn:
        return await sample_chunks(conn, owner_id=owner, document_ids=docs, max_chunks=n)


@pytest.fixture
async def corpus(db):
    a = await add_doc(db, "alice", name="Biology.pdf", version=1)
    b = await add_doc(db, "bob", name="BobSecrets.pdf", version=1)
    for i in range(10):
        await put(db, a, "alice", i, f"Alice chunk number {i} about cells", page=i + 1)
    await put(db, b, "bob", 0, "Bob private salary notes")
    return a, b


async def test_returns_current_version_chunks_in_reading_order_with_db_names(db, corpus):
    a, _ = corpus
    res = await sample(db, "alice", [a])
    assert [c.content for c in res] == [f"Alice chunk number {i} about cells" for i in range(10)]
    assert all(c.document_id == a and c.document_name == "Biology.pdf" and c.similarity == 0.0 for c in res)
    assert res[0].page == 1 and res[3].chunk_id


async def test_even_spread_when_capped_and_deterministic(db, corpus):
    a, _ = corpus
    res = await sample(db, "alice", [a], 4)
    idx = [int(c.content.split()[3]) for c in res]
    assert len(idx) == 4 and idx == sorted(idx) and idx[0] <= 2 and idx[-1] >= 7 and len(set(idx)) == 4
    assert [c.chunk_id for c in await sample(db, "alice", [a], 4)] == [c.chunk_id for c in res]


async def test_user_a_never_sees_user_b(db, corpus):
    a, b = corpus
    assert await sample(db, "alice", [b]) == []  # bob's document id presented with alice's owner id
    mixed = await sample(db, "alice", [a, b])
    assert mixed and all(c.document_id == a and "Bob" not in c.content for c in mixed)
    assert [c.content for c in await sample(db, "bob", [b])] == ["Bob private salary notes"]


async def test_other_versions_and_non_ready_documents_are_hidden(db):
    cur = await add_doc(db, "alice", name="Versions.pdf", version=2)
    await put(db, cur, "alice", 0, "old version text", version=1)
    await put(db, cur, "alice", 1, "current version text", version=2)
    pending = await add_doc(db, "alice", name="Pending.pdf", status="PROCESSING", version=1)
    await put(db, pending, "alice", 0, "not ready yet")
    failed = await add_doc(db, "alice", name="Failed.pdf", status="FAILED", version=1)
    await put(db, failed, "alice", 0, "failed document")
    res = await sample(db, "alice", [cur, pending, failed])
    assert [c.content for c in res] == ["current version text"]


async def test_quota_is_shared_fairly_between_documents(db):
    d1 = await add_doc(db, "alice", name="A.pdf", version=1)
    d2 = await add_doc(db, "alice", name="B.pdf", version=1)
    for i in range(20):
        await put(db, d1, "alice", i, f"first document chunk {i}")
    await put(db, d2, "alice", 0, "second document only chunk")
    res = await sample(db, "alice", [d1, d2], 6)
    assert len(res) == 6 and sum(c.document_id == d2 for c in res) == 1 and sum(c.document_id == d1 for c in res) == 5


async def test_empty_ids_return_nothing_and_hostile_inputs_are_inert(db, corpus):
    a, _ = corpus
    assert await sample(db, "alice", []) == []
    assert await sample(db, "alice", ["x'; DROP TABLE \"Document\"; --", "' OR 1=1 --"]) == []
    assert await sample(db, "alice' OR '1'='1", [a]) == []
    with pytest.raises(AppError) as e:
        await sample(db, "", [a])
    assert e.value.code == ErrorCode.VALIDATION
    assert len(await sample(db, "alice", [a])) == 10  # table still there
