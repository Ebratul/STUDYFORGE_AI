"""The operator-run index check (against the fake) and the opt-in live smoke test (skipped unless explicitly enabled)."""

from __future__ import annotations

import os
import uuid

import pytest

from app.tools.pinecone_check import check
from app.vectorstore import Identity, VectorRecord, chunk_id
from app.vectorstore.pinecone_store import PineconeStore
from tests.vector_utils import HOST_1536, fake_pinecone, vec_settings


async def test_check_passes_for_a_matching_cosine_index():
    store = PineconeStore(vec_settings("pinecone"), client=fake_pinecone().client())
    report, ok = await check(store)
    assert ok and report["1536"]["dimension"] == 1536 and report["1536"]["metric"] == "cosine" and report["1536"]["problems"] == []


async def test_check_reports_a_dimension_mismatch_and_a_wrong_metric():
    fake = fake_pinecone()
    fake.reported_dimension[HOST_1536] = 3072
    fake.metric = "euclidean"
    report, ok = await check(PineconeStore(vec_settings("pinecone"), client=fake.client()))
    assert not ok and len(report["1536"]["problems"]) == 2
    assert "3072" in report["1536"]["problems"][0] and "euclidean" in report["1536"]["problems"][1]


async def test_check_notes_when_the_metric_is_not_reported_and_is_read_only():
    fake = fake_pinecone()
    fake.metric = None
    report, ok = await check(PineconeStore(vec_settings("pinecone"), client=fake.client()))
    assert ok and "confirm in the console" in report["1536"]["note"]
    assert {(r["method"], r["path"]) for r in fake.requests} == {("POST", "/describe_index_stats")}  # no write, no delete


async def test_check_reports_an_unreachable_or_unauthorised_index():
    fake = fake_pinecone()
    fake.fail_next(401, 99)
    report, ok = await check(PineconeStore(vec_settings("pinecone"), client=fake.client()))
    assert not ok and "VECTOR_STORE_AUTH" in report["1536"]["problems"][0]


# --------------------------------------------------------------------------------------------------------------------------------
# LIVE smoke test: talks to a REAL Pinecone index. Never runs unless an operator sets RUN_LIVE_PINECONE=1 together with the PINECONE_* settings
# (an index of the operator's own, e.g. a throwaway one). It uses a disposable per-user namespace and deletes everything it created.
#     RUN_LIVE_PINECONE=1 .venv/bin/python -m pytest tests/test_pinecone_live.py -q   # see backend/docs/VECTOR_STORE_SPEC.md
# --------------------------------------------------------------------------------------------------------------------------------
LIVE = os.environ.get("RUN_LIVE_PINECONE") == "1"


@pytest.mark.skipif(not LIVE, reason="live Pinecone test: set RUN_LIVE_PINECONE=1 (and the PINECONE_* settings) to run")
async def test_live_round_trip_in_a_disposable_namespace():
    from app.config import load_settings

    base = load_settings()
    prefix = f"smoke-{uuid.uuid4().hex[:8]}"
    settings = base.model_copy(update={"pinecone_namespace_prefix": prefix, "pinecone_namespace_mode": "per-user", "vector_store": "pinecone"})
    store = PineconeStore(settings)
    dim = store.supported_dimensions()[0]
    ident = Identity("smoke", "smoke-model", dim)
    owner, doc = "smokeowner", "smokedoc"
    vecs = [[1.0 if j == i else 0.0 for j in range(dim)] for i in range(3)]
    recs = [VectorRecord(chunk_id(doc, 1, ident, i), doc, owner, 1, ident, vecs[i]) for i in range(3)]
    try:
        facts = await store.describe(dim)
        assert facts["dimension"] == dim
        await store.upsert(recs)  # includes the bounded wait for visibility
        got = await store.query(owner_id=owner, document_ids=[doc], vector=vecs[1], identity=ident, top_k=3)
        assert got and got[0].chunk_id == recs[1].id and got[0].score == pytest.approx(1.0, abs=1e-3)
        assert await store.count_document(owner_id=owner, document_id=doc, dimension=dim) == 3
        assert await store.delete_identity(owner_id=owner, identity=ident, chunks=[(doc, recs[0].id)]) == 1
        assert await store.delete_document(owner_id=owner, document_id=doc) == 2
        assert await store.delete_document(owner_id=owner, document_id=doc) == 0  # idempotent
    finally:
        await store.delete_user(owner_id=owner)  # removes the whole disposable namespace, whatever happened above
        await store.aclose()
