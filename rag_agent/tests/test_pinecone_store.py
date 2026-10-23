"""PineconeStore against a faithful fake of the REST API (no network)."""

from __future__ import annotations

import json
import logging

import httpx
import pytest

from app.errors import AppError, ErrorCode
from app.vectorstore import Identity, VectorRecord, chunk_id, vector_key
from app.vectorstore.pinecone_store import PineconeStore, upsert_batch_size
from tests.fake_pinecone import API_KEY
from tests.vector_utils import HOST_1536, fake_pinecone, vec_settings

ID = Identity("openai", "text-embedding-3-small", 1536)


def vecs(seed: int, dim: int = 1536) -> list[float]:
    return [((seed * 31 + i * 7) % 97) / 97.0 + 0.01 for i in range(dim)]


def rec(owner: str, doc: str, n: int, *, version: int = 1, identity: Identity = ID, seed: int | None = None) -> VectorRecord:
    return VectorRecord(chunk_id(doc, version, identity, n), doc, owner, version, identity, vecs(seed if seed is not None else n, identity.dimension))


def make(mode: str = "per-user", **kw) -> tuple[PineconeStore, "FakePinecone"]:  # noqa: F821
    fake = fake_pinecone()
    store = PineconeStore(vec_settings("pinecone", pinecone_namespace_mode=mode, **kw), client=fake.client())
    return store, fake


# ------------------------------------------------------------------------------------------------------------ upsert
async def test_upsert_sends_ids_namespace_headers_and_minimal_metadata():
    store, fake = make()
    r = rec("alice", "doc1", 0)
    await store.upsert([r])
    (call,) = fake.requests_to("/vectors/upsert")
    assert call["host"] == HOST_1536 and call["headers"]["api-key"] == API_KEY and call["headers"]["x-pinecone-api-version"]
    assert call["body"]["namespace"] == "dev-u-alice"
    (v,) = call["body"]["vectors"]
    assert v["id"] == f"doc1:{r.id}" == vector_key("doc1", r.id)
    assert v["metadata"] == {"ownerId": "alice", "documentId": "doc1", "processingVersion": 1,
                             "embeddingProvider": "openai", "embeddingModel": "text-embedding-3-small"}
    assert len(v["values"]) == 1536
    assert API_KEY not in json.dumps(call["body"]) and API_KEY not in call["url"]


async def test_no_chunk_text_ever_leaves_postgres():
    """VectorRecord has no text field, and the request carries only ids, numbers and the five metadata keys."""
    store, fake = make()
    await store.upsert([rec("alice", "doc1", i) for i in range(3)])
    meta_keys = {k for c in fake.requests_to("/vectors/upsert") for v in c["body"]["vectors"] for k in v["metadata"]}
    assert meta_keys == {"ownerId", "documentId", "processingVersion", "embeddingProvider", "embeddingModel"}
    assert not hasattr(rec("a", "d", 0), "content")


async def test_upsert_batches_stay_under_the_request_size_limit():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", i) for i in range(130)])
    calls = fake.requests_to("/vectors/upsert")
    assert len(calls) >= 3 and all(c["size"] < 2_000_000 for c in calls)
    assert sum(len(c["body"]["vectors"]) for c in calls) == 130 and len(fake.ns(HOST_1536, "dev-u-alice")) == 130
    assert upsert_batch_size(1536) <= 100 and upsert_batch_size(8) == 100 and upsert_batch_size(4096) >= 1


async def test_upsert_is_idempotent_for_stable_ids():
    store, fake = make()
    rs = [rec("alice", "doc1", i) for i in range(5)]
    await store.upsert(rs)
    await store.upsert(rs)
    assert len(fake.ns(HOST_1536, "dev-u-alice")) == 5


async def test_unsupported_dimension_fails_before_any_request():
    store, fake = make()
    other = Identity("openai", "text-embedding-3-large", 3072)
    with pytest.raises(AppError) as e:
        await store.upsert([rec("alice", "doc1", 0), rec("alice", "doc1", 1, identity=other)])
    assert e.value.code == ErrorCode.VECTOR_DIMENSION_UNSUPPORTED and "1536" in e.value.message
    assert fake.requests == []  # nothing, not even the supported half, was written


async def test_wrong_length_or_non_finite_vectors_are_rejected_never_repaired():
    store, fake = make()
    short = VectorRecord("c1", "doc1", "alice", 1, ID, [0.1] * 1535)
    longer = VectorRecord("c2", "doc1", "alice", 1, ID, [0.1] * 1537)
    for bad in (short, longer):
        with pytest.raises(AppError) as e:
            await store.upsert([bad])
        assert e.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH and not e.value.retryable
    nan = VectorRecord("c3", "doc1", "alice", 1, ID, [float("nan")] + [0.1] * 1535)
    with pytest.raises(AppError) as e:
        await store.upsert([nan])
    assert e.value.code == ErrorCode.PROVIDER_ERROR and not e.value.retryable
    assert fake.requests == []


async def test_hostile_ids_cannot_reach_the_request():
    store, fake = make()
    for owner, doc, cid in (("al:ice", "doc1", "c"), ("alice", "do c", "c"), ("alice", "doc1", "../c"), ("", "doc1", "c")):
        with pytest.raises(AppError) as e:
            await store.upsert([VectorRecord(cid, doc, owner, 1, ID, vecs(1))])
        assert e.value.code == ErrorCode.VALIDATION
    assert fake.requests == []


async def test_shared_mode_uses_one_namespace():
    store, fake = make("shared")
    await store.upsert([rec("alice", "d1", 0), rec("bob", "d2", 0)])
    assert {ns for (_h, ns) in fake.data} == {"dev-shared"}


# ------------------------------------------------------------------------------------------------------------ visibility
async def test_upsert_waits_until_vectors_are_visible():
    store, fake = make()
    fake.invisible_fetches = 2
    await store.upsert([rec("alice", "doc1", i) for i in range(3)])
    assert len(fake.requests_to("/vectors/fetch")) == 3  # two empty answers, then visible


async def test_visibility_wait_is_bounded_and_retryable():
    store, fake = make(pinecone_visibility_timeout_seconds=0.3)
    fake.always_invisible = True
    with pytest.raises(AppError) as e:
        await store.upsert([rec("alice", "doc1", 0)])
    assert e.value.code == ErrorCode.VECTOR_STORE_UNAVAILABLE and e.value.retryable
    assert len(fake.requests_to("/vectors/fetch")) < 12


async def test_zero_visibility_timeout_skips_the_wait():
    store, fake = make(pinecone_visibility_timeout_seconds=0)
    fake.always_invisible = True
    await store.upsert([rec("alice", "doc1", 0)])
    assert fake.requests_to("/vectors/fetch") == []


# ------------------------------------------------------------------------------------------------------------ query
async def test_query_filter_is_mandatory_and_built_by_the_store():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", 0), rec("alice", "doc2", 1)])
    out = await store.query(owner_id="alice", document_ids=["doc2", "doc1", "doc1"], vector=vecs(0), identity=ID, top_k=5, versions=[1, 3])
    (call,) = fake.requests_to("/query")
    assert call["body"]["namespace"] == "dev-u-alice" and call["body"]["topK"] == 5
    assert call["body"]["includeValues"] is False and call["body"]["includeMetadata"] is False
    assert call["body"]["filter"] == {"ownerId": {"$eq": "alice"}, "documentId": {"$in": ["doc1", "doc2"]},
                                      "embeddingProvider": {"$eq": "openai"}, "embeddingModel": {"$eq": "text-embedding-3-small"},
                                      "processingVersion": {"$in": [1, 3]}}
    assert [c.chunk_id for c in out][0] == chunk_id("doc1", 1, ID, 0) and out[0].score == pytest.approx(1.0)


async def test_query_returns_only_requested_documents_and_valid_matches():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", 0)])

    def tamper(req, body):
        if req.url.path == "/query":
            return httpx.Response(200, json={"matches": [
                {"id": f"other:{chunk_id('other', 1, ID, 0)}", "score": 0.99},   # a document that was not asked for
                {"id": "no-separator", "score": 0.9},                             # malformed id
                {"id": f"doc1:{chunk_id('doc1', 1, ID, 0)}", "score": "high"},   # malformed score
                {"id": f"doc1:{chunk_id('doc1', 1, ID, 0)}", "score": float("inf") if False else 0.5},
                "garbage",
            ]})
        return None

    fake.faults.append(tamper)
    out = await store.query(owner_id="alice", document_ids=["doc1"], vector=vecs(0), identity=ID, top_k=5)
    assert [(c.chunk_id, c.score) for c in out] == [(chunk_id("doc1", 1, ID, 0), 0.5)]


async def test_query_with_no_documents_makes_no_request_and_wrong_length_is_an_error():
    store, fake = make()
    assert await store.query(owner_id="alice", document_ids=[], vector=vecs(0), identity=ID, top_k=5) == []
    assert fake.requests == []
    with pytest.raises(AppError) as e:
        await store.query(owner_id="alice", document_ids=["doc1"], vector=vecs(0)[:-1], identity=ID, top_k=5)
    assert e.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH and fake.requests == []


async def test_query_unsupported_dimension():
    store, _ = make()
    with pytest.raises(AppError) as e:
        await store.query(owner_id="alice", document_ids=["d"], vector=[0.1] * 3072, identity=Identity("openai", "m", 3072), top_k=3)
    assert e.value.code == ErrorCode.VECTOR_DIMENSION_UNSUPPORTED


async def test_per_user_namespaces_never_mix_results():
    store, _ = make()
    await store.upsert([rec("alice", "doc1", 0, seed=1), rec("bob", "docB", 0, seed=1)])
    a = await store.query(owner_id="alice", document_ids=["doc1", "docB"], vector=vecs(1), identity=ID, top_k=10)
    assert [c.chunk_id for c in a] == [chunk_id("doc1", 1, ID, 0)]


async def test_shared_namespace_isolates_by_the_owner_filter():
    store, _ = make("shared")
    await store.upsert([rec("alice", "doc1", 0, seed=1), rec("bob", "docB", 0, seed=1)])
    a = await store.query(owner_id="alice", document_ids=["doc1", "docB"], vector=vecs(1), identity=ID, top_k=10)
    assert [c.chunk_id for c in a] == [chunk_id("doc1", 1, ID, 0)]


# ------------------------------------------------------------------------------------------------------------ retries / errors
async def test_transient_503_and_429_are_retried_then_succeed():
    store, fake = make()
    fake.fail_next(503, 2, path="/vectors/upsert")
    fake.fail_next(429, 1, path="/vectors/upsert", headers={"retry-after": "0"})
    await store.upsert([rec("alice", "doc1", 0)])
    assert len(fake.requests_to("/vectors/upsert")) == 4


async def test_timeouts_and_connection_errors_are_retried():
    store, fake = make()
    fake.raise_next(httpx.ReadTimeout("slow"), 1, path="/query")
    fake.raise_next(httpx.ConnectError("down"), 1, path="/query")
    await store.upsert([rec("alice", "doc1", 0)])
    out = await store.query(owner_id="alice", document_ids=["doc1"], vector=vecs(0), identity=ID, top_k=3)
    assert len(out) == 1 and len(fake.requests_to("/query")) == 3


async def test_retry_budget_is_bounded_and_the_error_is_retryable():
    store, fake = make(pinecone_max_retries=2)
    fake.fail_next(503, 99, path="/vectors/upsert")
    with pytest.raises(AppError) as e:
        await store.upsert([rec("alice", "doc1", 0)])
    assert e.value.code == ErrorCode.VECTOR_STORE_UNAVAILABLE and e.value.retryable
    assert len(fake.requests_to("/vectors/upsert")) == 3


async def test_rate_limit_exhaustion_reports_retry_after():
    store, fake = make(pinecone_max_retries=1)
    fake.fail_next(429, 99, path="/vectors/upsert", headers={"retry-after": "7"})
    # (retry-after is honoured up to a cap; the test only needs the final error's shape)
    import app.providers.retry as r

    orig = r.compute_delay
    r.compute_delay = lambda attempt, ra: 0.0
    try:
        with pytest.raises(AppError) as e:
            await store.upsert([rec("alice", "doc1", 0)])
    finally:
        r.compute_delay = orig
    assert e.value.code == ErrorCode.VECTOR_STORE_RATE_LIMITED and e.value.retryable and e.value.retry_after_seconds == 7


@pytest.mark.parametrize("status,code", [(401, ErrorCode.VECTOR_STORE_AUTH), (403, ErrorCode.VECTOR_STORE_AUTH), (400, ErrorCode.VECTOR_STORE_ERROR), (422, ErrorCode.VECTOR_STORE_ERROR)])
async def test_permanent_errors_are_not_retried(status, code):
    store, fake = make()
    fake.fail_next(status, 99, path="/vectors/upsert")
    with pytest.raises(AppError) as e:
        await store.upsert([rec("alice", "doc1", 0)])
    assert e.value.code == code and not e.value.retryable and len(fake.requests_to("/vectors/upsert")) == 1


async def test_wrong_api_key_is_a_clean_auth_error():
    fake = fake_pinecone()
    store = PineconeStore(vec_settings("pinecone", pinecone_api_key="pcsk_WRONGKEY_0123456789abcdef"), client=fake.client())
    with pytest.raises(AppError) as e:
        await store.upsert([rec("alice", "doc1", 0)])
    assert e.value.code == ErrorCode.VECTOR_STORE_AUTH
    assert "pcsk_WRONGKEY" not in json.dumps(e.value.body()) and "pcsk_WRONGKEY" not in str(e.value)


async def test_api_key_never_appears_in_errors_or_logs(caplog):
    caplog.set_level(logging.DEBUG)
    store, fake = make(pinecone_max_retries=1)
    fake.fail_next(503, 99)
    with pytest.raises(AppError) as e:
        await store.upsert([rec("alice", "doc1", 0)])
    blob = json.dumps(e.value.body()) + str(e.value.diagnostics) + "\n".join(r.getMessage() + str(r.__dict__) for r in caplog.records)
    assert API_KEY not in blob and HOST_1536 not in json.dumps(e.value.body())


async def test_key_only_goes_to_the_configured_host_and_never_follows_redirects():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", 0)])
    assert {r["host"] for r in fake.requests} == {HOST_1536}
    assert store._client.follow_redirects is False if store._owns_client else True


# ------------------------------------------------------------------------------------------------------------ deletes
async def test_delete_document_lists_by_prefix_paginates_and_is_idempotent():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", i) for i in range(250)] + [rec("alice", "doc2", i) for i in range(3)])
    assert await store.delete_document(owner_id="alice", document_id="doc1") == 250
    assert all(i.startswith("doc2:") for (_ns, i) in fake.all_ids()) and len(fake.all_ids()) == 3
    pages = fake.requests_to("/vectors/list")
    assert len(pages) >= 3 and all(dict(p["query"])["prefix"] == "doc1:" for p in pages[:3])
    assert await store.delete_document(owner_id="alice", document_id="doc1") == 0  # again: fine
    assert await store.delete_document(owner_id="alice", document_id="never-existed") == 0  # 404 tolerated
    assert len(fake.all_ids()) == 3


async def test_delete_document_prefix_does_not_catch_similar_ids():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", 0), rec("alice", "doc10", 0)])
    await store.delete_document(owner_id="alice", document_id="doc1")
    assert [i.split(":")[0] for (_ns, i) in fake.all_ids()] == ["doc10"]  # "doc1:" is not a prefix of "doc10:"


async def test_delete_batches_respect_the_1000_id_limit():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", i, seed=i % 5) for i in range(1050)])
    await store.delete_document(owner_id="alice", document_id="doc1")
    sizes = [len(c["body"]["ids"]) for c in fake.requests_to("/vectors/delete")]
    assert sizes == [1000, 50] and not fake.all_ids()


async def test_delete_user_per_user_clears_the_namespace_and_tolerates_missing():
    store, fake = make()
    await store.upsert([rec("alice", "doc1", 0), rec("bob", "doc2", 0)])
    await store.delete_user(owner_id="alice")
    assert {ns for (ns, _i) in fake.all_ids()} == {"dev-u-bob"}
    (call,) = fake.requests_to("/vectors/delete")
    assert call["body"] == {"namespace": "dev-u-alice", "deleteAll": True}
    await store.delete_user(owner_id="alice")  # namespace already gone: 404 is success


async def test_delete_user_shared_mode_deletes_document_by_document_only():
    store, fake = make("shared")
    await store.upsert([rec("alice", "doc1", 0), rec("alice", "doc2", 0), rec("bob", "docB", 0)])
    await store.delete_user(owner_id="alice", document_ids=["doc1", "doc2"])
    assert [i.split(":")[0] for (_ns, i) in fake.all_ids()] == ["docB"]
    assert not any(c["body"].get("deleteAll") for c in fake.requests_to("/vectors/delete"))  # never wipes the shared namespace


async def test_delete_identity_removes_exactly_the_listed_pairs():
    store, fake = make()
    other = Identity("openai", "text-embedding-3-small", 1536)
    rs = [rec("alice", "doc1", i) for i in range(4)]
    await store.upsert(rs)
    gone = [("doc1", rs[0].id), ("doc1", rs[1].id)]
    assert await store.delete_identity(owner_id="alice", identity=other, chunks=gone) == 2
    assert {i for (_ns, i) in fake.all_ids()} == {vector_key("doc1", rs[2].id), vector_key("doc1", rs[3].id)}
    assert await store.delete_identity(owner_id="alice", identity=other, chunks=gone) == 0  # idempotent: already gone, no error


async def test_delete_identity_rollback_mode_skips_the_fetch_check():
    """verify=False is for ids the caller just wrote itself (they may not be fetchable yet): no fetch, direct delete."""
    store, fake = make()
    rs = [rec("alice", "doc1", i) for i in range(2)]
    await store.upsert(rs)
    fake.requests.clear()
    await store.delete_identity(owner_id="alice", identity=ID, chunks=[("doc1", r.id) for r in rs], verify=False)
    assert fake.requests_to("/vectors/fetch") == [] and not fake.all_ids()


async def test_delete_identity_shared_mode_rechecks_ownership_from_metadata():
    store, fake = make("shared")
    mine, theirs = rec("alice", "doc1", 0), rec("bob", "doc1", 1)  # same document id string, different owners (hostile / colliding input)
    await store.upsert([mine, theirs])
    await store.delete_identity(owner_id="alice", identity=ID, chunks=[("doc1", mine.id), ("doc1", theirs.id)])
    left = fake.ns(HOST_1536, "dev-shared")
    assert list(left) == [vector_key("doc1", theirs.id)]  # bob's vector survived alice's request


async def test_count_document():
    store, _ = make()
    await store.upsert([rec("alice", "doc1", i) for i in range(7)])
    assert await store.count_document(owner_id="alice", document_id="doc1", dimension=1536) == 7
    assert await store.count_document(owner_id="alice", document_id="nope", dimension=1536) == 0
