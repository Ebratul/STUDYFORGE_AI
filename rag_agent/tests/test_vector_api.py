"""The service-token protected /v1/vectors endpoints, and ingest through HTTP in pinecone mode."""

from __future__ import annotations

import contextlib
import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.errors import AppError, ErrorCode
from app.main import create_app
from app.providers.mock import VALID_KEY
from app.providers.registry import ProviderRegistry
from app.vectorstore import Identity, VectorRecord, VectorRuntime, chunk_id
from tests.conftest import SERVICE_TOKEN, add_doc, make_settings
from tests.vector_utils import memory_runtime

ID = Identity("openai", "text-embedding-3-small", 1536)


@contextlib.asynccontextmanager
async def serve(pool, rt: VectorRuntime | None, *, token: str | None = SERVICE_TOKEN):
    settings = rt.settings if rt else make_settings()
    app = create_app(settings, registry=ProviderRegistry(settings), pool=pool, vectors=rt)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://rag.test", headers=headers) as c:
        yield c


def seed(store, owner, doc, n=2):
    recs = [VectorRecord(chunk_id(doc, 1, ID, i), doc, owner, 1, ID, [float(i + 1)] + [0.0] * 1535) for i in range(n)]
    store.records.update({(owner, doc, r.id): r for r in recs})
    return recs


@pytest.mark.parametrize("method,path", [("GET", "/v1/vectors/status"), ("POST", "/v1/vectors/delete")])
async def test_endpoints_need_the_service_token(db, method, path):
    rt, _ = memory_runtime("pinecone")
    for tok in (None, "wrong-token-0123456789-abcdefghij"):
        async with serve(db, rt, token=tok) as c:
            r = await c.request(method, path, json={"scope": "user", "owner_id": "alice"} if method == "POST" else None)
            assert r.status_code == 401 and r.json()["error"]["code"] == "SERVICE_UNAUTHORIZED"


async def test_status_exposes_only_mode_and_sizes(db):
    rt, _ = memory_runtime("pinecone")
    async with serve(db, rt) as c:
        body = (await c.get("/v1/vectors/status")).json()
    assert body == {"mode": "pinecone", "dimensions": [1536]}
    async with serve(db, None) as c:
        assert (await c.get("/v1/vectors/status")).json() == {"mode": "pgvector", "dimensions": None}


async def test_delete_is_a_noop_in_pgvector_mode(db):
    async with serve(db, None) as c:
        r = await c.post("/v1/vectors/delete", json={"scope": "user", "owner_id": "alice"})
    assert r.status_code == 200 and r.json() == {"status": "noop", "mode": "pgvector", "deleted": 0}


async def test_delete_document_scope(db):
    rt, store = memory_runtime("pinecone")
    seed(store, "alice", "d1"), seed(store, "alice", "d2"), seed(store, "bob", "d3")
    async with serve(db, rt) as c:
        r = await c.post("/v1/vectors/delete", json={"scope": "document", "owner_id": "alice", "document_id": "d1"})
        assert r.status_code == 200 and r.json()["status"] == "ok" and r.json()["deleted"] == 2
        again = await c.post("/v1/vectors/delete", json={"scope": "document", "owner_id": "alice", "document_id": "d1"})
        assert again.status_code == 200 and again.json()["deleted"] == 0  # idempotent
    assert {(o, d) for (o, d, _c) in store.records} == {("alice", "d2"), ("bob", "d3")}


async def test_delete_cannot_cross_owners(db):
    rt, store = memory_runtime("pinecone")
    seed(store, "alice", "d1")
    async with serve(db, rt) as c:
        await c.post("/v1/vectors/delete", json={"scope": "document", "owner_id": "mallory", "document_id": "d1"})
        await c.post("/v1/vectors/delete", json={"scope": "user", "owner_id": "mallory"})
    assert len(store.records) == 2


async def test_delete_user_scope(db):
    rt, store = memory_runtime("pinecone")
    seed(store, "alice", "d1"), seed(store, "alice", "d2"), seed(store, "bob", "d3")
    async with serve(db, rt) as c:
        r = await c.post("/v1/vectors/delete", json={"scope": "user", "owner_id": "alice", "document_ids": ["d1", "d2"]})
    assert r.status_code == 200 and {o for (o, _d, _c) in store.records} == {"bob"}


async def test_delete_chunks_scope_is_exact_and_identity_scoped(db):
    rt, store = memory_runtime("pinecone")
    r0, r1 = seed(store, "alice", "d1")
    ident = {"provider": "openai", "model": "text-embedding-3-small", "dimension": 1536}
    async with serve(db, rt) as c:
        r = await c.post("/v1/vectors/delete", json={"scope": "chunks", "owner_id": "alice", "identity": ident, "chunks": [["d1", r0.id]]})
        assert r.status_code == 200 and r.json()["deleted"] == 1
        wrong = await c.post("/v1/vectors/delete", json={"scope": "chunks", "owner_id": "alice", "identity": {**ident, "model": "other"}, "chunks": [["d1", r1.id]]})
        assert wrong.json()["deleted"] == 0
        big = await c.post("/v1/vectors/delete", json={"scope": "chunks", "owner_id": "alice", "identity": {**ident, "dimension": 3072}, "chunks": [["d1", r1.id]]})
        assert big.status_code == 200 and big.json()["deleted"] == 0  # a size the store cannot hold: nothing to delete, the job can finish
    assert {k[2] for k in store.records} == {r1.id}


@pytest.mark.parametrize("payload", [
    {"scope": "user", "owner_id": "a:b"},
    {"scope": "user", "owner_id": ""},
    {"scope": "user", "owner_id": "../x"},
    {"scope": "user", "owner_id": "alice\n"},
    {"scope": "document", "owner_id": "alice"},
    {"scope": "document", "owner_id": "alice", "document_id": "a b"},
    {"scope": "chunks", "owner_id": "alice"},
    {"scope": "chunks", "owner_id": "alice", "identity": {"provider": "p", "model": "m", "dimension": 1536}, "chunks": []},
    {"scope": "chunks", "owner_id": "alice", "identity": {"provider": "p", "model": "m", "dimension": 1536}, "chunks": [["d:1", "c"]]},
    {"scope": "user", "owner_id": "alice", "document_ids": ["ok", "no good"]},
    {"scope": "everything", "owner_id": "alice"},
])
async def test_malformed_requests_are_rejected_and_delete_nothing(db, payload):
    rt, store = memory_runtime("pinecone")
    seed(store, "alice", "d1")
    async with serve(db, rt) as c:
        r = await c.post("/v1/vectors/delete", json=payload)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    assert len(store.records) == 2


async def test_caller_cannot_choose_a_namespace_or_filter(db):
    """Unknown fields are ignored, never honoured: the request deletes alice's vectors (its owner) and nothing else."""
    rt, store = memory_runtime("pinecone")
    seed(store, "alice", "d1"), seed(store, "bob", "d2")
    async with serve(db, rt) as c:
        await c.post("/v1/vectors/delete", json={"scope": "user", "owner_id": "alice", "namespace": "bob", "filter": {"ownerId": "bob"}})
    assert {o for (o, _d, _c) in store.records} == {"bob"}


async def test_store_failure_is_a_coded_retryable_error(db):
    rt, store = memory_runtime("pinecone")
    store.fail("delete", AppError(ErrorCode.VECTOR_STORE_UNAVAILABLE))
    async with serve(db, rt) as c:
        r = await c.post("/v1/vectors/delete", json={"scope": "user", "owner_id": "alice"})
        assert r.status_code == 503 and r.json()["error"] == {"code": "VECTOR_STORE_UNAVAILABLE", "message": r.json()["error"]["message"], "retryable": True}
        ok = await c.post("/v1/vectors/delete", json={"scope": "user", "owner_id": "alice"})  # the job's retry
        assert ok.status_code == 200


async def test_ingest_over_http_in_pinecone_mode_streams_a_result_with_the_superseded_list(db):
    rt, store = memory_runtime("pinecone")
    doc = await add_doc(db, "alice")
    text = (b"Mitochondria produce ATP in the cell through oxidative phosphorylation. " * 5 + b"\n\n") * 12

    async def post(version):
        meta = {"document_id": doc, "owner_id": "alice", "filename": "n.txt", "mime_type": "text/plain", "processing_version": version,
                "embedding": {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": 1536}}
        r = await c.post("/v1/ingest", data={"meta": json.dumps(meta)}, files={"file": ("n.txt", text, "text/plain")})
        assert r.status_code == 200
        return [json.loads(line) for line in r.text.splitlines() if line.strip()]

    async with serve(db, rt) as c:
        first = await post(1)
        second = await post(2)
    assert first[-1]["status"] == "READY" and first[-1]["superseded"] == []
    assert second[-1]["status"] == "READY" and len(second[-1]["superseded"][0]["chunks"]) == first[-1]["chunk_count"]
    assert all(e["type"] in ("progress", "result") for e in first)


async def test_ingest_over_http_reports_an_unsupported_dimension(db):
    rt, store = memory_runtime("pinecone", dimensions=(3072,))
    doc = await add_doc(db, "alice")
    meta = {"document_id": doc, "owner_id": "alice", "filename": "n.txt", "mime_type": "text/plain", "processing_version": 1,
            "embedding": {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": 1536}}
    async with serve(db, rt) as c:
        r = await c.post("/v1/ingest", data={"meta": json.dumps(meta)}, files={"file": ("n.txt", b"hello world " * 50, "text/plain")})
    last = json.loads(r.text.splitlines()[-1])
    assert last["type"] == "error" and last["code"] == "VECTOR_DIMENSION_UNSUPPORTED" and last["retryable"] is False
    assert store.records == {}
