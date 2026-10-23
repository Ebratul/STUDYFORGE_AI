"""One behavioural contract, three implementations: the in-memory fake, PineconeStore (over a fake REST server) and PgVectorStore
(real PostgreSQL + pgvector). Anything a backend does differently here would surface as a divergence in dual mode."""

from __future__ import annotations

import pytest

from app.errors import AppError, ErrorCode
from app.vectorstore import Identity, VectorRecord, chunk_id
from app.vectorstore.memory import InMemoryVectorStore
from app.vectorstore.pgvector_store import PgVectorStore
from app.vectorstore.pinecone_store import PineconeStore
from tests.conftest import add_doc
from tests.vector_utils import fake_pinecone, vec_settings

A = Identity("openai", "text-embedding-3-small", 1536)
B = Identity("openai", "other-model", 1536)


def onehot(i: int, dim: int = 1536) -> list[float]:
    v = [0.0] * dim
    v[i] = 1.0
    return v


class Harness:
    def __init__(self, store, pool=None) -> None:
        self.store, self.pool, self._n = store, pool, 0

    async def put(self, owner: str, doc: str, i: int, *, identity: Identity = A, version: int = 1, vec: list[float] | None = None) -> VectorRecord:
        r = VectorRecord(chunk_id(doc, version, identity, i), doc, owner, version, identity, vec or onehot(i))
        if self.pool is not None:  # pgvector keeps the vector in the chunk row, so the row (text, ownership) must exist first
            await self._ensure_doc(owner, doc, identity, version)
            async with self.pool.connection() as conn:
                self._n += 1
                await conn.execute(
                    'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel") '
                    "VALUES (%s,%s,%s,%s,%s,'x',1,%s,%s)", (r.id, doc, owner, self._n, version, identity.provider, identity.model))
        await self.store.upsert([r])
        return r

    async def _ensure_doc(self, owner: str, doc: str, identity: Identity, version: int) -> None:
        async with self.pool.connection() as conn:
            exists = await (await conn.execute('SELECT 1 FROM "Document" WHERE "id"=%s', (doc,))).fetchone()
        if exists is None:
            await add_doc(self.pool, owner, doc, version=version, provider="OPENAI", model=identity.model, dimension=identity.dimension)

    async def ids(self, owner: str, docs: list[str], q: list[float], identity: Identity = A, k: int = 50, versions=None) -> list[str]:
        out = await self.store.query(owner_id=owner, document_ids=docs, vector=q, identity=identity, top_k=k, versions=versions)
        return [c.chunk_id for c in out]


@pytest.fixture(params=["memory", "pinecone-shared", "pinecone-per-user", "pgvector"])
async def h(request, db):
    if request.param == "memory":
        yield Harness(InMemoryVectorStore((1536,)))
    elif request.param.startswith("pinecone"):
        fake = fake_pinecone()
        mode = request.param.removeprefix("pinecone-")  # shared = isolation by the owner filter only; per-user = one namespace each
        yield Harness(PineconeStore(vec_settings("pinecone", pinecone_namespace_mode=mode), client=fake.client()))
    else:
        yield Harness(PgVectorStore(db), db)


async def test_nearest_first_with_cosine_scores(h):
    for i in range(3):
        await h.put("alice", "d1", i)
    out = await h.store.query(owner_id="alice", document_ids=["d1"], vector=onehot(1), identity=A, top_k=3)
    assert out[0].chunk_id == chunk_id("d1", 1, A, 1) and out[0].score == pytest.approx(1.0)
    assert [round(c.score, 6) for c in out[1:]] == [0.0, 0.0] and len(out) == 3
    assert out[1].chunk_id < out[2].chunk_id  # ties break by id: deterministic across backends


async def test_top_k_limits_results(h):
    for i in range(5):
        await h.put("alice", "d1", i)
    assert len(await h.ids("alice", ["d1"], onehot(0), k=2)) == 2


async def test_owner_isolation(h):
    a = await h.put("alice", "dA", 0)
    b = await h.put("bob", "dB", 0)  # identical vector, other owner
    assert await h.ids("alice", ["dA", "dB"], onehot(0)) == [a.id]
    assert await h.ids("bob", ["dA", "dB"], onehot(0)) == [b.id]
    assert await h.ids("carol", ["dA", "dB"], onehot(0)) == []


async def test_document_scoping(h):
    r1 = await h.put("alice", "d1", 0)
    await h.put("alice", "d2", 1)
    assert await h.ids("alice", ["d1"], onehot(0)) == [r1.id]
    assert await h.ids("alice", [], onehot(0)) == []
    assert await h.ids("alice", ["nope"], onehot(0)) == []


async def test_identity_scoping(h):
    a = await h.put("alice", "d1", 0, identity=A)
    b = await h.put("alice", "d1", 0, identity=B)
    assert await h.ids("alice", ["d1"], onehot(0), identity=A) == [a.id]
    assert await h.ids("alice", ["d1"], onehot(0), identity=B) == [b.id]


async def test_version_filter(h):
    old = await h.put("alice", "d1", 0, version=1)
    new = await h.put("alice", "d1", 0, version=2)
    assert old.id != new.id
    assert await h.ids("alice", ["d1"], onehot(0), versions=[2]) == [new.id]
    assert set(await h.ids("alice", ["d1"], onehot(0))) == {old.id, new.id}


async def test_dimension_mismatch_is_an_error_never_repaired(h):
    await h.put("alice", "d1", 0)
    with pytest.raises(AppError) as e:
        await h.store.query(owner_id="alice", document_ids=["d1"], vector=[1.0] * 1535, identity=A, top_k=3)
    assert e.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH
    short = VectorRecord("zzz", "d1", "alice", 1, A, [1.0] * 1535)
    with pytest.raises(AppError) as e2:
        await h.store.upsert([short])
    assert e2.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH


async def test_upsert_is_idempotent(h):
    r = await h.put("alice", "d1", 0)
    await h.store.upsert([r])
    assert await h.ids("alice", ["d1"], onehot(0)) == [r.id]
    assert await h.store.count_document(owner_id="alice", document_id="d1", dimension=1536) == 1


async def test_delete_document_is_scoped_and_idempotent(h):
    await h.put("alice", "d1", 0)
    keep = await h.put("alice", "d2", 0)
    other = await h.put("bob", "d3", 0)
    assert await h.store.delete_document(owner_id="alice", document_id="d1") >= 1
    assert await h.ids("alice", ["d1", "d2"], onehot(0)) == [keep.id]
    await h.store.delete_document(owner_id="alice", document_id="d1")  # again
    assert await h.ids("bob", ["d3"], onehot(0)) == [other.id]
    await h.store.delete_document(owner_id="bob", document_id="d2")  # someone else's document id: removes nothing of alice's
    assert await h.ids("alice", ["d2"], onehot(0)) == [keep.id]


async def test_delete_user_is_scoped(h):
    await h.put("alice", "d1", 0)
    await h.put("alice", "d2", 1)
    other = await h.put("bob", "d3", 0)
    await h.store.delete_user(owner_id="alice", document_ids=["d1", "d2"])
    assert await h.ids("alice", ["d1", "d2"], onehot(0)) == []
    assert await h.ids("bob", ["d3"], onehot(0)) == [other.id]
    await h.store.delete_user(owner_id="alice", document_ids=["d1", "d2"])  # idempotent


async def test_delete_identity_removes_exactly_the_given_pairs(h):
    r0 = await h.put("alice", "d1", 0, identity=A)
    r1 = await h.put("alice", "d1", 1, identity=A)
    staged = await h.put("alice", "d1", 0, identity=B)
    foreign = await h.put("bob", "d9", 5, identity=A)
    await h.store.delete_identity(owner_id="alice", identity=A, chunks=[("d1", r0.id), ("d9", foreign.id)])  # second pair is bob's
    assert set(await h.ids("alice", ["d1"], onehot(0), identity=A)) == {r1.id}
    assert await h.ids("alice", ["d1"], onehot(0), identity=B) == [staged.id]  # the other identity is untouched
    assert await h.ids("bob", ["d9"], onehot(5)) == [foreign.id]
    await h.store.delete_identity(owner_id="alice", identity=A, chunks=[("d1", r0.id)])  # idempotent


async def test_delete_identity_ignores_pairs_of_a_different_identity(h):
    r = await h.put("alice", "d1", 0, identity=A)
    await h.store.delete_identity(owner_id="alice", identity=B, chunks=[("d1", r.id)])  # wrong identity: nothing happens
    assert await h.ids("alice", ["d1"], onehot(0), identity=A) == [r.id]
