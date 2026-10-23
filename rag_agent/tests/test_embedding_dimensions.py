"""Configurable embedding dimensions (backend/docs/EMBEDDING_SETTINGS_SPEC.md): validation, strict output checks, ingest, identity-scoped
retrieval, full-document sources and the staged re-index endpoint. Real Postgres + pgvector; provider HTTP is mocked (respx) or the mock provider."""

from __future__ import annotations

import json
import logging
import math
import uuid

import httpx
import pytest
import respx
from pgvector import Vector
from pydantic import SecretStr

from app.config import MAX_EMBEDDING_DIMENSION, MIN_EMBEDDING_DIMENSION, Settings
from app.errors import AppError, ErrorCode, ProviderError
from app.generation.sources import sample_chunks
from app.ingest.pipeline import IngestMeta, run_ingest
from app.providers.base import EmbedRequest
from app.providers.embedding import check_vectors
from app.providers.mock import MockProvider, VALID_KEY, embedding_behaviour, hash_embed
from app.providers.openai import OpenAIProvider
from app.providers.registry import ProviderRegistry
from app.retrieval.search import search_chunks
from tests.conftest import CANARY_KEY, SERVICE_TOKEN, add_doc, make_settings
from tests.fakes import FakeProvider
from tests.helpers import BASES, chat_json, embed_json, err_body

VALIDATE = "/v1/providers/validate"
OA = BASES["openai"]
KEY = SecretStr("sk-test-key-0123456789")


# ============================================================================================ validation (HTTP provider, respx)
def vbody(emb="text-embedding-3-large", **extra):
    return {"provider": "openai", "api_key": CANARY_KEY, "chat_model": "gpt-4o-mini", "embedding_model": emb, **extra}


def openai_routes(m, *, native=3072, honour=True, reject_param=False, status_with_param=None):
    """OpenAI-style /embeddings: native size `native`; `dimensions` is honoured, ignored, rejected (400) or answered with an HTTP error."""
    m.get(f"{OA}/models").mock(return_value=httpx.Response(200, json={"data": []}))
    m.post(f"{OA}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json()))

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        asked = body.get("dimensions")
        if asked is not None and status_with_param is not None:
            return httpx.Response(status_with_param, json=err_body("upstream said: secret detail " + CANARY_KEY, code="x"))
        if asked is not None and reject_param:
            return httpx.Response(400, json=err_body("Unknown parameter: 'dimensions' for this model. " + CANARY_KEY, code="unknown_parameter"))
        return httpx.Response(200, json=embed_json(1, asked if (asked is not None and honour) else native))

    return m.post(f"{OA}/embeddings").mock(side_effect=handler)


async def test_native_size_when_none_is_requested(client):
    with respx.mock as m:
        route = openai_routes(m, native=3072)
        out = (await client.post(VALIDATE, json=vbody())).json()
    emb = out["checks"]["embedding"]
    assert out["ok"] is True and out["embedding_dimension"] == 3072
    assert emb == {**emb, "ok": True, "dimension": 3072, "native_dimension": 3072} and "request_dimensions" not in emb
    assert route.call_count == 1 and "dimensions" not in json.loads(route.calls.last.request.content)


async def test_requested_size_equal_to_native_sends_no_parameter(client):
    with respx.mock as m:
        route = openai_routes(m, native=1536)
        out = (await client.post(VALIDATE, json=vbody(emb="text-embedding-3-small", embedding_dimension=1536))).json()
    assert out["embedding_dimension"] == 1536 and "request_dimensions" not in out["checks"]["embedding"]
    assert route.call_count == 1 and "dimensions" not in json.loads(route.calls.last.request.content)


async def test_shortened_size_is_verified_with_a_live_request(client):
    with respx.mock as m:
        route = openai_routes(m, native=3072, honour=True)
        out = (await client.post(VALIDATE, json=vbody(embedding_dimension=1024))).json()
    emb = out["checks"]["embedding"]
    assert out["ok"] is True and out["embedding_dimension"] == 1024
    assert emb["dimension"] == 1024 and emb["native_dimension"] == 3072 and emb["request_dimensions"] == 1024
    sent = [json.loads(c.request.content) for c in route.calls]
    assert [("dimensions" in s) for s in sent] == [False, True] and sent[1]["dimensions"] == 1024
    assert CANARY_KEY not in json.dumps(out)


async def test_a_model_that_ignores_the_parameter_is_a_mismatch_never_padded_or_cut(client):
    with respx.mock as m:
        openai_routes(m, native=768, honour=False)
        out = (await client.post(VALIDATE, json=vbody(emb="vendor-embed", embedding_dimension=512))).json()
    emb = out["checks"]["embedding"]
    assert out["ok"] is False and out["embedding_dimension"] is None
    assert emb["code"] == "EMBEDDING_DIMENSION_MISMATCH" and emb["dimension"] == 768 and emb["native_dimension"] == 768
    assert "768" in emb["message"] and "512" in emb["message"]


async def test_a_model_that_rejects_the_parameter_is_unsupported_with_a_fixed_message(client):
    with respx.mock as m:
        openai_routes(m, native=1024, reject_param=True)
        r = await client.post(VALIDATE, json=vbody(emb="vendor-embed", embedding_dimension=256))
    emb = r.json()["checks"]["embedding"]
    assert emb["ok"] is False and emb["code"] == "EMBEDDING_DIMENSION_UNSUPPORTED" and emb["native_dimension"] == 1024
    assert "256" in emb["message"] and "1024" in emb["message"]
    assert "Unknown parameter" not in r.text and CANARY_KEY not in r.text  # upstream text is never copied


async def test_requested_larger_than_native(client):
    with respx.mock as m:  # a provider that refuses it
        openai_routes(m, native=1024, reject_param=True)
        emb = (await client.post(VALIDATE, json=vbody(emb="vendor-embed", embedding_dimension=3072))).json()["checks"]["embedding"]
    assert emb["code"] == "EMBEDDING_DIMENSION_UNSUPPORTED"
    with respx.mock as m:  # a provider that silently ignores it
        openai_routes(m, native=1024, honour=False)
        emb = (await client.post(VALIDATE, json=vbody(emb="vendor-embed", embedding_dimension=3072))).json()["checks"]["embedding"]
    assert emb["code"] == "EMBEDDING_DIMENSION_MISMATCH" and emb["dimension"] == 1024


@pytest.mark.parametrize("bad", [0, 7, MIN_EMBEDDING_DIMENSION - 1, MAX_EMBEDDING_DIMENSION + 1, 100000, -1, "abc", 1.5])
async def test_out_of_range_or_malformed_dimension_is_a_422(client, bad):
    r = await client.post(VALIDATE, json=vbody(embedding_dimension=bad))
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    assert "embedding_dimension" in r.json()["error"]["message"] and CANARY_KEY not in r.text


@pytest.mark.parametrize("ok", [MIN_EMBEDDING_DIMENSION, 2048, 3072, MAX_EMBEDDING_DIMENSION])
async def test_boundary_sizes_are_accepted_when_the_model_honours_them(client, ok):
    with respx.mock as m:
        openai_routes(m, native=4096 if ok != 4096 else 8192, honour=True)
        out = (await client.post(VALIDATE, json=vbody(emb="vendor-embed", embedding_dimension=ok))).json()
    assert out["embedding_dimension"] == ok


async def test_a_bad_key_still_short_circuits_with_a_dimension_requested(client):
    with respx.mock as m:
        m.get(f"{OA}/models").mock(return_value=httpx.Response(401, json=err_body("no", code="invalid_api_key")))
        chat = m.post(f"{OA}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json()))
        emb = m.post(f"{OA}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1)))
        out = (await client.post(VALIDATE, json=vbody(embedding_dimension=1024))).json()
    assert out["checks"]["auth"]["code"] == "PROVIDER_AUTH_INVALID" and out["checks"]["embedding"] == {"ok": None, "skipped": True}
    assert not chat.called and not emb.called


async def test_a_failing_chat_model_does_not_hide_the_embedding_verdict(client):
    with respx.mock as m:
        openai_routes(m, native=3072)
        m.post(f"{OA}/chat/completions").mock(return_value=httpx.Response(404, json=err_body("nope", code="model_not_found")))
        out = (await client.post(VALIDATE, json=vbody(embedding_dimension=1024))).json()
    assert out["ok"] is False and out["checks"]["chat"]["code"] == "MODEL_NOT_FOUND"
    assert out["checks"]["embedding"]["ok"] is True and out["embedding_dimension"] == 1024


@pytest.mark.parametrize(("status", "code"), [(429, "PROVIDER_RATE_LIMITED"), (402, "QUOTA_EXCEEDED"), (401, "PROVIDER_AUTH_INVALID"), (503, "PROVIDER_UNAVAILABLE")])
async def test_account_or_service_failures_on_the_shortened_probe_are_not_called_unsupported(client, status, code):
    with respx.mock as m:
        openai_routes(m, native=3072, status_with_param=status)
        r = await client.post(VALIDATE, json=vbody(embedding_dimension=1024))
    emb = r.json()["checks"]["embedding"]
    assert emb["ok"] is False and emb["code"] == code and emb["native_dimension"] == 3072
    assert "secret detail" not in r.text and CANARY_KEY not in r.text


async def test_failed_native_request_is_normalised_and_leaks_nothing(client):
    with respx.mock as m:
        openai_routes(m)
        m.post(f"{OA}/embeddings").mock(return_value=httpx.Response(500, json=err_body("boom " + CANARY_KEY, code="server_error")))
        r = await client.post(VALIDATE, json=vbody(embedding_dimension=1024))
    emb = r.json()["checks"]["embedding"]
    assert emb["ok"] is False and emb["code"] == "PROVIDER_UNAVAILABLE" and "native_dimension" not in emb
    assert "boom" not in r.text and CANARY_KEY not in r.text


async def test_malformed_embedding_response_is_a_provider_error(client):
    with respx.mock as m:
        openai_routes(m)
        m.post(f"{OA}/embeddings").mock(return_value=httpx.Response(200, json={"data": [{"embedding": [0.1, "x"]}]}))
        emb = (await client.post(VALIDATE, json=vbody())).json()["checks"]["embedding"]
    assert emb["code"] == "PROVIDER_ERROR"


# ---- mock provider models (what the e2e stack uses)
async def test_mock_models_behave_like_the_spec(client):
    def b(model, **kw):
        return {"provider": "mock", "api_key": VALID_KEY, "chat_model": "mock-chat", "embedding_model": model, **kw}

    async def emb(model, **kw):
        out = (await client.post(VALIDATE, json=b(model, **kw))).json()
        return out["checks"]["embedding"], out["embedding_dimension"]

    assert (await emb("mock-embed"))[1] == 1536
    assert (await emb("mock-embed-2048"))[1] == 2048
    assert (await emb("mock-embed-3072"))[1] == 3072
    c, d = await emb("mock-embed-flex")
    assert d == 1024 and "request_dimensions" not in c
    c, d = await emb("mock-embed-flex", embedding_dimension=256)
    assert d == 256 and c["request_dimensions"] == 256 and c["native_dimension"] == 1024
    c, d = await emb("mock-embed-flex", embedding_dimension=2048)  # larger than native: the model refuses
    assert d is None and c["code"] == "EMBEDDING_DIMENSION_UNSUPPORTED"
    c, d = await emb("mock-embed-ignore", embedding_dimension=512)
    assert d is None and c["code"] == "EMBEDDING_DIMENSION_MISMATCH" and c["dimension"] == 768
    assert (await emb("mock-embed-ignore", embedding_dimension=768))[1] == 768
    c, d = await emb("mock-embed-strict", embedding_dimension=512)
    assert d is None and c["code"] == "EMBEDDING_DIMENSION_UNSUPPORTED" and c["native_dimension"] == 1536
    assert (await emb("mock-embed-strict", embedding_dimension=1536))[1] == 1536
    assert (await emb("mock-embed-nan"))[0]["code"] == "PROVIDER_ERROR"


def test_mock_embeddings_are_deterministic_and_unit_length_at_every_size():
    for dim in (8, 64, 768, 1536, 4096):
        v = hash_embed("mitochondria produce ATP", dim)
        assert len(v) == dim and v == hash_embed("mitochondria produce ATP", dim)
        assert math.sqrt(sum(x * x for x in v)) == pytest.approx(1.0)
    assert embedding_behaviour("mock-embed-96") == (96, "ignore") and embedding_behaviour("mock-embed-9999") == (1536, "ignore")


def test_the_dimension_is_no_longer_a_service_setting():
    s = Settings(_env_file=None, rag_agent_token=SERVICE_TOKEN, embedding_dimensions=2048)  # a leftover env var is simply ignored
    assert not hasattr(s, "embedding_dimensions")
    assert make_settings(allow_mock_provider=True)


# ============================================================================================ strict embedding output
def test_check_vectors_rejects_everything_that_is_not_a_clean_vector_of_the_expected_length():
    check_vectors([[0.1] * 4, [0.2] * 4], 4)
    check_vectors([[0.1] * 4, [0.2] * 4], None)  # no expectation: still one shared length
    for bad in ([[0.1] * 3], [[0.1] * 5], [[0.1] * 4, [0.1] * 3]):
        with pytest.raises(ProviderError) as ei:
            check_vectors(bad, 4)
        assert ei.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH and ei.value.retryable is False
    with pytest.raises(ProviderError) as ei:
        check_vectors([[0.1] * 4, [0.1] * 3], None)
    assert ei.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH
    for bad in ([[]], [[0.1, float("nan")]], [[0.1, float("inf")]], [[0.1, True]], [[0.1, "0.2"]], [None], ["ab"]):
        with pytest.raises(ProviderError) as ei:
            check_vectors(bad, None)
        assert ei.value.code == ErrorCode.PROVIDER_ERROR, bad


async def test_openai_adapter_sends_dimensions_only_when_asked_and_checks_every_vector(settings):
    p = OpenAIProvider(settings)
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        return httpx.Response(200, json=embed_json(len(body["input"]), body.get("dimensions", 3072)))

    with respx.mock as m:
        m.post(f"{OA}/embeddings").mock(side_effect=handler)
        await p.embed(EmbedRequest("any-model", KEY, ["a", "b"], expected_dimension=3072))
        res = await p.embed(EmbedRequest("any-model", KEY, ["a", "b"], dimensions=512, expected_dimension=512))
    assert "dimensions" not in sent[0] and sent[1]["dimensions"] == 512  # any model, no allow-list: the caller decides
    assert all(len(v) == 512 for v in res.vectors)


async def test_wrong_length_vectors_from_the_provider_are_rejected_not_repaired(settings):
    p = OpenAIProvider(settings)
    payload = embed_json(2, 1536)
    payload["data"][1]["embedding"] = payload["data"][1]["embedding"][:1535]  # one vector one short
    with respx.mock as m:
        m.post(f"{OA}/embeddings").mock(return_value=httpx.Response(200, json=payload))
        with pytest.raises(ProviderError) as ei:
            await p.embed(EmbedRequest("m", KEY, ["a", "b"], expected_dimension=1536))
        with pytest.raises(ProviderError) as ei2:  # no expectation: mixed lengths in one batch are still refused
            await p.embed(EmbedRequest("m", KEY, ["a", "b"]))
    assert ei.value.code == ei2.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH


async def test_non_finite_numbers_from_the_provider_are_rejected(settings):
    p = OpenAIProvider(settings)
    raw = b'{"object":"list","model":"m","data":[{"object":"embedding","index":0,"embedding":[0.5,NaN,0.25]}],"usage":{"prompt_tokens":1,"total_tokens":1}}'
    with respx.mock as m:
        m.post(f"{OA}/embeddings").mock(return_value=httpx.Response(200, content=raw, headers={"content-type": "application/json"}))
        with pytest.raises(ProviderError) as ei:
            await p.embed(EmbedRequest("m", KEY, ["a"], expected_dimension=3))
    assert ei.value.code == ErrorCode.PROVIDER_ERROR


async def test_mock_provider_checks_its_own_output_against_expected_dimension():
    p = MockProvider()
    ok = await p.embed(EmbedRequest("mock-embed-flex", SecretStr(VALID_KEY), ["x"], dimensions=300, expected_dimension=300))
    assert len(ok.vectors[0]) == 300
    with pytest.raises(ProviderError) as ei:  # ignores the parameter, so 768 != 300
        await p.embed(EmbedRequest("mock-embed-ignore", SecretStr(VALID_KEY), ["x"], dimensions=300, expected_dimension=300))
    assert ei.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH


# ============================================================================================ ingest
def imeta(doc, *, model="mock-embed", dimension=1536, request_dimensions=None, version=1, provider="mock", key=VALID_KEY):
    return IngestMeta.model_validate({
        "document_id": doc, "owner_id": "alice", "filename": "n.txt", "mime_type": "text/plain", "processing_version": version,
        "embedding": {"provider": provider, "api_key": key, "model": model, "dimension": dimension, "request_dimensions": request_dimensions},
    })


async def run_ingest_for(pool, m: IngestMeta, data: bytes, registry=None):
    settings = make_settings()
    return [ev async for ev in run_ingest(settings=settings, pool=pool, registry=registry or ProviderRegistry(settings), meta=m, filename_ext="txt", data=data)]


async def chunk_rows(pool, doc, *, version=None):
    async with pool.connection() as conn:
        cur = await conn.execute(
            'SELECT "embeddingProvider","embeddingModel","embeddingDimension",vector_dims("embedding"),"processingVersion","chunkIndex" '
            'FROM "DocumentChunk" WHERE "documentId"=%s AND (%s::int IS NULL OR "processingVersion"=%s) ORDER BY "processingVersion","embeddingModel","chunkIndex"',
            (doc, version, version))
        return await cur.fetchall()


TEXT = (b"Mitochondria produce ATP in the cell through oxidative phosphorylation. " * 30)


@pytest.mark.parametrize(("model", "dim", "req"), [("mock-embed-3072", 3072, None), ("mock-embed-2048", 2048, None), ("mock-embed-flex", 256, 256), ("mock-embed-flex", 1024, None)])
async def test_ingest_stores_the_configured_dimension_and_identity(db, model, dim, req):
    doc = await add_doc(db, "alice", status="QUEUED", version=0)
    ev = await run_ingest_for(db, imeta(doc, model=model, dimension=dim, request_dimensions=req), TEXT)
    assert ev[-1]["type"] == "result" and ev[-1]["status"] == "READY" and ev[-1]["embedding_dimension"] == dim and ev[-1]["embedding_model"] == model
    rows = await chunk_rows(db, doc)
    assert rows and all(r[:4] == ("mock", model, dim, dim) for r in rows)  # the generated column equals the real vector length


async def test_ingest_refuses_vectors_that_do_not_match_the_configured_dimension(db):
    doc = await add_doc(db, "alice", status="QUEUED", version=0)
    # mock-embed returns 1536-d vectors; the caller says 1024 and sends no parameter: nothing may be stored, padded or cut
    ev = await run_ingest_for(db, imeta(doc, model="mock-embed", dimension=1024), TEXT)
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "EMBEDDING_DIMENSION_MISMATCH" and ev[-1]["retryable"] is False
    assert await chunk_rows(db, doc) == []


async def test_ingest_defends_itself_against_an_adapter_that_returns_the_wrong_length(db, settings):
    class Sloppy(FakeProvider):
        async def embed(self, req):  # ignores expected_dimension entirely
            return await super().embed(EmbedRequest(req.model, req.api_key, req.inputs))

    reg = ProviderRegistry(settings)
    reg.register_for_tests(Sloppy("openai"))
    doc = await add_doc(db, "alice", status="QUEUED", version=0)
    ev = await run_ingest_for(db, imeta(doc, provider="openai", key=CANARY_KEY, dimension=768), TEXT, reg)
    assert ev[-1]["type"] == "error" and ev[-1]["code"] == "EMBEDDING_DIMENSION_MISMATCH"
    assert await chunk_rows(db, doc) == []


async def test_rerun_replaces_only_its_own_identity_and_a_new_version_replaces_all(db):
    doc = await add_doc(db, "alice", status="QUEUED", version=0)
    await run_ingest_for(db, imeta(doc, version=1), TEXT)
    # a staged set of another identity at the same version (what a re-index in progress looks like)
    async with db.connection() as conn:
        await conn.execute(
            'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding") '
            "VALUES (%s,%s,'alice',0,1,'staged',1,'mock','mock-embed-768',%s)", (uuid.uuid4().hex, doc, Vector(hash_embed("staged", 768))))
    await run_ingest_for(db, imeta(doc, version=1), TEXT)  # idempotent re-run of the same identity
    models = sorted({r[1] for r in await chunk_rows(db, doc, version=1)})
    assert models == ["mock-embed", "mock-embed-768"]
    await run_ingest_for(db, imeta(doc, version=2), TEXT)  # a newer version supersedes every identity
    rows = await chunk_rows(db, doc)
    assert rows and {r[4] for r in rows} == {2} and {r[1] for r in rows} == {"mock-embed"}


@pytest.mark.parametrize("embedding", [
    {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed"},                                          # dimension is required
    {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": 7},
    {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": MAX_EMBEDDING_DIMENSION + 1},
    {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": 1536, "request_dimensions": 1024},  # must equal dimension
])
async def test_ingest_endpoint_rejects_bad_embedding_config(client, db, embedding):
    await add_doc(db, "alice", "d-x")
    meta = {"document_id": "d-x", "owner_id": "alice", "filename": "a.txt", "processing_version": 1, "embedding": embedding}
    r = await client.post("/v1/ingest", data={"meta": json.dumps(meta)}, files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION" and VALID_KEY not in r.text
    assert "embedding" in r.json()["error"]["message"]


# ============================================================================================ retrieval never mixes identities
async def put_set(pool, doc, owner, texts, *, provider="mock", model="mock-embed", dim=1536, version=1):
    async with pool.connection() as conn:
        for i, t in enumerate(texts):
            await conn.execute(
                'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingProvider","embeddingModel","embedding") '
                "VALUES (%s,%s,%s,%s,%s,%s,1,%s,%s,%s)", (uuid.uuid4().hex, doc, owner, i, version, t, provider, model, Vector(hash_embed(t, dim))))


async def query(pool, doc, text, *, provider="mock", model="mock-embed", dim=1536, qdim=None):
    async with pool.connection() as conn:
        return await search_chunks(conn, owner_id="alice", document_ids=[doc], query_embedding=hash_embed(text, qdim or dim), query_text=text,
                                   embedding_provider=provider, embedding_model=model, embedding_dimension=dim, top_k=10)


async def test_two_identities_of_different_lengths_coexist_and_never_meet(db):
    d = await add_doc(db, "alice", version=1)
    await put_set(db, d, "alice", ["alpha cells", "beta cells"], dim=1536)
    await put_set(db, d, "alice", ["gamma cells", "delta cells"], model="mock-embed-768", dim=768)
    await put_set(db, d, "alice", ["epsilon cells"], provider="openai", model="mock-embed", dim=1536)  # same model+length, other provider
    assert {c.content for c in await query(db, d, "cells")} == {"alpha cells", "beta cells"}
    assert {c.content for c in await query(db, d, "cells", model="mock-embed-768", dim=768)} == {"gamma cells", "delta cells"}
    assert {c.content for c in await query(db, d, "cells", provider="openai")} == {"epsilon cells"}


async def test_same_length_different_model_is_not_comparable(db):
    d = await add_doc(db, "alice", version=1)
    await put_set(db, d, "alice", ["alpha cells"], model="model-a", dim=1536)
    await put_set(db, d, "alice", ["beta cells"], model="model-b", dim=1536)
    assert [c.content for c in await query(db, d, "cells", model="model-b")] == ["beta cells"]


async def test_a_query_vector_of_the_wrong_length_is_an_error_not_a_db_failure(db):
    d = await add_doc(db, "alice", version=1)
    await put_set(db, d, "alice", ["alpha cells"], dim=1536)
    await put_set(db, d, "alice", ["gamma cells"], model="mock-embed-768", dim=768)
    for kw in ({"dim": 1536, "qdim": 768}, {"model": "mock-embed-768", "dim": 768, "qdim": 1536}):
        with pytest.raises(AppError) as ei:
            await query(db, d, "cells", **kw)
        assert ei.value.code == ErrorCode.EMBEDDING_DIMENSION_MISMATCH
    assert await query(db, d, "cells", dim=3072) == []  # nothing stored at that size; and no "different vector dimensions" error


# ============================================================================================ full-document context reads one set
async def test_sources_read_only_the_documents_recorded_identity(db):
    d = await add_doc(db, "alice", version=1, provider="MOCK", model="mock-embed", dimension=1536)
    await put_set(db, d, "alice", ["one", "two", "three"], dim=1536)
    await put_set(db, d, "alice", ["one", "two", "three"], model="mock-embed-768", dim=768)  # the staged copy of the same passages
    async with db.connection() as conn:
        got = await sample_chunks(conn, owner_id="alice", document_ids=[d], max_chunks=50)
    assert sorted(c.content for c in got) == ["one", "three", "two"]


async def test_sources_follow_the_document_after_activation_of_a_new_identity(db):
    d = await add_doc(db, "alice", version=1, provider="MOCK", model="mock-embed-768", dimension=768)
    await put_set(db, d, "alice", ["one", "two"], dim=1536)
    await put_set(db, d, "alice", ["one", "two"], model="mock-embed-768", dim=768)
    async with db.connection() as conn:
        got = await sample_chunks(conn, owner_id="alice", document_ids=[d], max_chunks=50)
    assert sorted(c.content for c in got) == ["one", "two"]


# ============================================================================================ POST /v1/reindex
RE = "/v1/reindex"
SRC = {"provider": "mock", "model": "mock-embed", "dimension": 1536}
TEXTS = ["Mitochondria produce ATP", "Ribosomes make protein", "The Krebs cycle runs in the matrix"]


def rbody(doc, *, version=1, owner="alice", source=None, key=VALID_KEY, model="mock-embed-768", dimension=768, request_dimensions=None, provider="mock"):
    return {"document_id": doc, "owner_id": owner, "processing_version": version, "source": source or SRC,
            "target": {"provider": provider, "api_key": key, "model": model, "dimension": dimension, **({"request_dimensions": request_dimensions} if request_dimensions else {})}}


async def seed_doc(db, texts=TEXTS, **kw):
    d = await add_doc(db, "alice", version=1, **kw)
    async with db.connection() as conn:
        for i, t in enumerate(texts):
            await conn.execute(
                'INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section","content","tokenCount","embeddingProvider","embeddingModel","metadata","embedding") '
                "VALUES (%s,%s,'alice',%s,1,%s,%s,%s,7,'mock','mock-embed','{\"charCount\": 5}',%s)", (uuid.uuid4().hex, d, i, i + 1, f"S{i}", t, Vector(hash_embed(t))))
    return d


async def snapshot(pool, doc, model):
    async with pool.connection() as conn:
        cur = await conn.execute(
            'SELECT "id","chunkIndex","page","section","content","tokenCount","metadata",("embedding"::text) FROM "DocumentChunk" WHERE "documentId"=%s AND "embeddingModel"=%s ORDER BY "chunkIndex"', (doc, model))
        return await cur.fetchall()


async def test_reindex_builds_a_second_set_and_leaves_the_first_untouched(client, db):
    d = await seed_doc(db)
    before = await snapshot(db, d, "mock-embed")
    r = await client.post(RE, json=rbody(d))
    assert r.status_code == 200 and r.json() == {"type": "result", "status": "READY", "chunk_count": 3, "embedding_dimension": 768}
    assert await snapshot(db, d, "mock-embed") == before  # byte-identical: the old index is never modified
    new = await snapshot(db, d, "mock-embed-768")
    assert [(x[1], x[2], x[3], x[4], x[5], x[6]) for x in new] == [(b[1], b[2], b[3], b[4], b[5], b[6]) for b in before]  # same text, order, page, section, tokens
    assert {x[0] for x in new}.isdisjoint({b[0] for b in before})
    rows = await chunk_rows(db, d)
    assert sorted({(r_[1], r_[2], r_[3]) for r_ in rows}) == [("mock-embed", 1536, 1536), ("mock-embed-768", 768, 768)]
    # both indexes answer queries, each in its own space
    assert {c.content for c in await query(db, d, "Mitochondria ATP", model="mock-embed-768", dim=768)} >= {TEXTS[0]}
    assert {c.content for c in await query(db, d, "Mitochondria ATP")} >= {TEXTS[0]}


async def test_reindex_to_a_shortened_size_and_rerun_is_idempotent(client, db):
    d = await seed_doc(db)
    body = rbody(d, model="mock-embed-flex", dimension=256, request_dimensions=256)
    assert (await client.post(RE, json=body)).json()["embedding_dimension"] == 256
    assert (await client.post(RE, json=body)).json()["status"] == "READY"
    rows = [r_ for r_ in await chunk_rows(db, d) if r_[1] == "mock-embed-flex"]
    assert len(rows) == 3 and all(r_[2] == r_[3] == 256 for r_ in rows)


async def test_reindex_refuses_the_same_identity(client, db):
    d = await seed_doc(db)
    r = await client.post(RE, json=rbody(d, model="mock-embed", dimension=1536))
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    assert len(await chunk_rows(db, d)) == 3


@pytest.mark.parametrize("what", ["version", "status", "source-missing"])
async def test_reindex_reports_stale_and_writes_nothing(client, db, what):
    d = await seed_doc(db, status="PROCESSING" if what == "status" else "READY")
    body = rbody(d, version=2 if what == "version" else 1, source={**SRC, "model": "other-model"} if what == "source-missing" else None)
    r = await client.post(RE, json=body)
    assert r.status_code == 200 and r.json()["status"] == "STALE"
    assert len(await chunk_rows(db, d)) == 3


async def test_reindex_is_stale_when_the_source_changes_while_embedding(client, db, settings):
    d = await seed_doc(db)

    class Racy(FakeProvider):
        async def embed(self, req):
            async with db.connection() as conn:  # the document is re-processed under the hood
                await conn.execute('DELETE FROM "DocumentChunk" WHERE "documentId"=%s AND "chunkIndex"=2', (d,))
            return await super().embed(EmbedRequest(req.model, req.api_key, req.inputs))

    client.app.state.registry.register_for_tests(Racy("openai"))
    r = await client.post(RE, json=rbody(d, provider="openai", key=CANARY_KEY, model="m", dimension=1536))
    assert r.json()["status"] == "STALE"
    assert {x[1] for x in await chunk_rows(db, d)} == {"mock-embed"}


async def test_reindex_rolls_back_completely_when_a_vector_cannot_be_stored(client, db):
    d = await seed_doc(db)

    class NanLast(FakeProvider):
        async def embed(self, req):
            res = await super().embed(EmbedRequest(req.model, req.api_key, req.inputs))
            res.vectors[-1] = [float("nan")] * 1536  # right length, refused by pgvector at INSERT
            return res

    client.app.state.registry.register_for_tests(NanLast("openai"))
    r = await client.post(RE, json=rbody(d, provider="openai", key=CANARY_KEY, model="m", dimension=1536))
    assert r.status_code == 500 and r.json()["error"]["code"] == "INTERNAL" and CANARY_KEY not in r.text and "NaN" not in r.text
    assert {x[1] for x in await chunk_rows(db, d)} == {"mock-embed"}  # no partial target rows


async def test_reindex_rejects_wrong_length_provider_output(client, db):
    d = await seed_doc(db)
    # mock-embed-ignore always answers 768-d although 512 is asked for: a mismatch, nothing is stored
    r = await client.post(RE, json=rbody(d, model="mock-embed-ignore", dimension=512, request_dimensions=512))
    assert r.status_code == 422 and r.json()["error"]["code"] == "EMBEDDING_DIMENSION_MISMATCH" and r.json()["error"]["retryable"] is False
    assert {x[1] for x in await chunk_rows(db, d)} == {"mock-embed"}


async def test_reindex_provider_failure_uses_the_error_envelope_and_never_echoes_the_key(client, db, caplog):
    d = await seed_doc(db)
    with caplog.at_level(logging.DEBUG):
        r = await client.post(RE, json=rbody(d, key=CANARY_KEY))
    err = r.json()["error"]
    assert r.status_code == 502 and err["code"] == "PROVIDER_AUTH_INVALID" and err["retryable"] is False
    assert CANARY_KEY not in r.text and CANARY_KEY not in caplog.text
    assert {x[1] for x in await chunk_rows(db, d)} == {"mock-embed"}


async def test_reindex_is_owner_scoped(client, db):
    d = await seed_doc(db)
    for body in (rbody(d, owner="mallory"), rbody("no-such-doc")):
        r = await client.post(RE, json=body)
        assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    assert len(await chunk_rows(db, d)) == 3


async def test_reindex_shares_the_concurrency_limit(client, db):
    d = await seed_doc(db)
    client.app.state.ingests_active = client.app.state.settings.max_concurrent_ingests
    r = await client.post(RE, json=rbody(d))
    assert r.status_code == 429 and r.json()["error"]["code"] == "BUSY" and r.json()["error"]["retryable"] is True
    client.app.state.ingests_active = 0
    assert (await client.post(RE, json=rbody(d))).status_code == 200
    assert client.app.state.ingests_active == 0  # released


@pytest.mark.parametrize("patch", [
    {"target": {"provider": "mock", "api_key": VALID_KEY, "model": "m"}},                          # dimension required
    {"target": {"provider": "mock", "api_key": VALID_KEY, "model": "m", "dimension": 7}},
    {"target": {"provider": "mock", "api_key": VALID_KEY, "model": "m", "dimension": 768, "request_dimensions": 512}},
    {"source": {"provider": "mock", "model": "m"}},
    {"processing_version": -1},
])
async def test_reindex_validates_its_body(client, db, patch):
    d = await seed_doc(db)
    r = await client.post(RE, json={**rbody(d), **patch})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION" and VALID_KEY not in r.text


async def test_reindex_needs_the_service_token_and_an_enabled_provider(client, db, pool):
    d = await seed_doc(db)
    r = await httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://x").post(RE, json=rbody(d))
    assert r.status_code == 401
    from app.main import create_app
    app = create_app(make_settings(allow_mock_provider=False), pool=pool)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}) as c:
        r = await c.post(RE, json=rbody(d))
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
