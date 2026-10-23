"""Credential tests + model listing/merge rules (mocked HTTP)."""

from __future__ import annotations

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.providers import catalogue
from app.providers.groq import GroqProvider
from app.providers.openai import OpenAIProvider
from app.providers.openrouter import OpenRouterProvider
from tests.helpers import BASES, CANARY_KEY, err_body

KEY = SecretStr(CANARY_KEY)

OPENAI_MODELS = {
    "object": "list",
    "data": [
        {"id": "gpt-4o", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "gpt-4o-mini", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "gpt-3.5-turbo", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "gpt-4-0613", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "o3-mini", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "text-embedding-3-small", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "text-embedding-3-large", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "text-embedding-ada-002", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "whisper-1", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "dall-e-3", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "gpt-4o-audio-preview", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "omni-moderation-latest", "object": "model", "created": 1, "owned_by": "openai"},
        {"id": "some-future-thing", "object": "model", "created": 1, "owned_by": "x"},
    ],
}


async def test_openai_models_merge_rules(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        m.get(BASES["openai"] + "/models").mock(return_value=httpx.Response(200, json=OPENAI_MODELS))
        models = await p.list_models(KEY)
    by = {x.id: x for x in models}
    assert [x.id for x in models] == sorted(by)  # sorted by id
    assert set(by) == {"gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo", "gpt-4-0613", "o3-mini", "text-embedding-3-small",
                       "text-embedding-3-large", "text-embedding-ada-002"}  # non-chat/non-embedding models are not offered
    assert by["gpt-4o"].capabilities.structured_output == "yes" and by["gpt-4o"].capability_source == "catalogue"
    assert by["gpt-3.5-turbo"].capabilities.structured_output == "no"
    assert by["gpt-4-0613"].capabilities.structured_output == "no"
    assert by["gpt-4o"].context_length is None  # OpenAI does not report it: never invented
    e = by["text-embedding-3-small"]
    assert e.capabilities.embeddings and not e.capabilities.chat
    assert not hasattr(e, "embedding_dimensions")  # no 1536 judgement: the size is measured at validation time
    assert not by["gpt-4o"].capabilities.embeddings and by["gpt-4o"].capabilities.streaming


async def test_openai_unknown_chat_family_is_unverified(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        m.get(BASES["openai"] + "/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "gpt-zzz-experimental"}]}))
        models = await p.list_models(KEY)
    assert models[0].capabilities.structured_output == "unknown" and models[0].capability_source == "unverified"


OR_MODELS = {
    "data": [
        {"id": "anthropic/claude-x", "name": "Claude X", "context_length": 200000,
         "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
         "supported_parameters": ["temperature", "tools", "structured_outputs", "response_format"]},
        {"id": "vendor/json-only", "name": "JSON only", "context_length": 8000,
         "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["response_format"]},
        {"id": "vendor/plain", "name": "Plain", "context_length": None,
         "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["temperature"]},
        {"id": "vendor/image-gen", "name": "Img", "context_length": 1, "architecture": {"output_modalities": ["image"]},
         "supported_parameters": []},
        {"id": "vendor/no-params", "name": "NP", "context_length": 4096, "architecture": {"output_modalities": ["text"]}},
    ]
}
OR_EMB = {
    "data": [
        {"id": "openai/text-embedding-3-small", "name": "TE3 small", "context_length": 8192,
         "architecture": {"output_modalities": ["embeddings"]}, "supported_parameters": []},
        {"id": "baai/bge-large-en-v1.5", "name": "BGE large", "context_length": 512,
         "architecture": {"output_modalities": ["embeddings"]}, "supported_parameters": []},
        {"id": "vendor/mystery-embed", "name": "M", "context_length": 512,
         "architecture": {"output_modalities": ["embeddings"]}, "supported_parameters": []},
    ]
}


async def test_openrouter_models_use_api_metadata(settings):
    p = OpenRouterProvider(settings)
    with respx.mock as m:
        m.get(BASES["openrouter"] + "/key").mock(return_value=httpx.Response(200, json={"data": {"label": "k"}}))
        m.get(BASES["openrouter"] + "/models").mock(return_value=httpx.Response(200, json=OR_MODELS))
        m.get(BASES["openrouter"] + "/embeddings/models").mock(return_value=httpx.Response(200, json=OR_EMB))
        models = await p.list_models(KEY)
    by = {x.id: x for x in models}
    assert "vendor/image-gen" not in by
    c = by["anthropic/claude-x"]
    assert c.capabilities.structured_output == "yes" and c.capabilities.tools == "yes" and c.capability_source == "api"
    assert c.context_length == 200000 and c.name == "Claude X"
    assert by["vendor/json-only"].capabilities.structured_output == "unknown"
    assert by["vendor/plain"].capabilities.structured_output == "no" and by["vendor/plain"].capabilities.tools == "no"
    assert by["vendor/plain"].context_length is None
    assert by["vendor/no-params"].capability_source == "unverified"
    assert all(by[i].capabilities.embeddings and not by[i].capabilities.chat for i in OR_EMB_IDS)


OR_EMB_IDS = ["openai/text-embedding-3-small", "baai/bge-large-en-v1.5", "vendor/mystery-embed"]


async def test_openrouter_embeddings_listing_failure_is_tolerated_but_auth_failure_is_not(settings):
    p = OpenRouterProvider(settings)
    with respx.mock as m:
        m.get(BASES["openrouter"] + "/key").mock(return_value=httpx.Response(200, json={"data": {}}))
        m.get(BASES["openrouter"] + "/models").mock(return_value=httpx.Response(200, json=OR_MODELS))
        m.get(BASES["openrouter"] + "/embeddings/models").mock(return_value=httpx.Response(500, json=err_body("x")))
        assert len(await p.list_models(KEY)) == 4
    with respx.mock as m:
        m.get(BASES["openrouter"] + "/key").mock(return_value=httpx.Response(401, json=err_body("no")))
        from app.errors import ProviderError

        with pytest.raises(ProviderError) as ei:
            await p.list_models(KEY)
        assert ei.value.code.value == "PROVIDER_AUTH_INVALID"


GROQ_MODELS = {
    "object": "list",
    "data": [
        {"id": "openai/gpt-oss-20b", "object": "model", "active": True, "context_window": 131072},
        {"id": "llama-3.3-70b-versatile", "object": "model", "active": True, "context_window": 131072},
        {"id": "whisper-large-v3", "object": "model", "active": True, "context_window": 448},
        {"id": "meta-llama/llama-prompt-guard-2-22m", "object": "model", "active": True, "context_window": 512},
        {"id": "old-model", "object": "model", "active": False, "context_window": 1000},
    ],
}


async def test_groq_models(settings):
    p = GroqProvider(settings)
    with respx.mock as m:
        m.get(BASES["groq"] + "/models").mock(return_value=httpx.Response(200, json=GROQ_MODELS))
        models = await p.list_models(KEY)
    by = {x.id: x for x in models}
    assert set(by) == {"openai/gpt-oss-20b", "llama-3.3-70b-versatile"}
    assert by["openai/gpt-oss-20b"].capabilities.structured_output == "yes"
    assert by["llama-3.3-70b-versatile"].capabilities.structured_output == "unknown"
    assert by["llama-3.3-70b-versatile"].capability_source == "unverified"
    assert by["llama-3.3-70b-versatile"].context_length == 131072
    assert not any(x.capabilities.embeddings for x in models)  # Groq has no embeddings API


def test_models_are_capped_at_500_and_sorted():
    payload = {"data": [{"id": f"gpt-{i:04d}"} for i in range(700)]}
    models = catalogue.finalize(catalogue.parse_openai_models(payload))
    assert len(models) == 500 and [m.id for m in models] == sorted(m.id for m in models)


def test_embedding_models_survive_the_cap():
    payload = {"data": [{"id": f"gpt-{i:04d}"} for i in range(700)] + [{"id": "text-embedding-3-small"}]}
    models = catalogue.finalize(catalogue.parse_openai_models(payload))
    assert "text-embedding-3-small" in {m.id for m in models}


# ------------------------------------------------------------------------------------------------ credential tests
@pytest.mark.parametrize("pid,cls", [("openai", OpenAIProvider), ("groq", GroqProvider)])
async def test_credential_test_ok(settings, pid, cls):
    with respx.mock as m:
        route = m.get(BASES[pid] + "/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}]}))
        res = await cls(settings).test(KEY)
    assert res.ok and res.models_count == 2 and res.latency_ms is not None
    assert route.calls.last.request.headers["authorization"] == f"Bearer {CANARY_KEY}"


async def test_openrouter_credential_test_uses_authenticated_key_endpoint(settings):
    """/models is public on OpenRouter, so an invalid key must be caught by GET /key."""
    p = OpenRouterProvider(settings)
    with respx.mock(assert_all_called=False) as m:
        m.get(BASES["openrouter"] + "/key").mock(return_value=httpx.Response(401, json={"error": {"code": 401, "message": f"bad {CANARY_KEY}"}}))
        models = m.get(BASES["openrouter"] + "/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "a"}]}))
        res = await p.test(KEY)
    assert not res.ok and res.code == "PROVIDER_AUTH_INVALID" and models.call_count == 0
    assert CANARY_KEY not in (res.message or "")
    with respx.mock as m:
        m.get(BASES["openrouter"] + "/key").mock(return_value=httpx.Response(200, json={"data": {}}))
        m.get(BASES["openrouter"] + "/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}))
        res = await p.test(KEY)
    assert res.ok and res.models_count == 3


@pytest.mark.parametrize(
    "resp,code,retryable",
    [
        (httpx.Response(401, json=err_body(f"Incorrect API key {CANARY_KEY}")), "PROVIDER_AUTH_INVALID", False),
        (httpx.Response(403, json=err_body("x")), "PROVIDER_AUTH_INVALID", False),
        (httpx.Response(429, json=err_body("x"), headers={"Retry-After": "7"}), "PROVIDER_RATE_LIMITED", True),
        (httpx.Response(500, json=err_body("x")), "PROVIDER_UNAVAILABLE", True),
        (httpx.Response(200, text="<html>"), "PROVIDER_ERROR", False),
        (httpx.Response(200, json={"unexpected": True}), "PROVIDER_ERROR", False),
        (httpx.Response(404, json=err_body("nf")), "PROVIDER_ERROR", False),
    ],
)
async def test_credential_test_failures_never_leak(settings, resp, code, retryable):
    with respx.mock as m:
        m.get(BASES["openai"] + "/models").mock(return_value=resp)
        res = await OpenAIProvider(settings).test(KEY)
    assert not res.ok and res.code == code and res.retryable is retryable
    assert CANARY_KEY not in (res.message or "") and "html" not in (res.message or "").lower()


async def test_credential_test_timeout(settings):
    with respx.mock as m:
        m.get(BASES["openai"] + "/models").mock(side_effect=httpx.ConnectTimeout("t"))
        res = await OpenAIProvider(settings).test(KEY)
    assert not res.ok and res.code == "PROVIDER_TIMEOUT" and res.retryable


# ------------------------------------------------------------------------------------------------ HTTP endpoints
async def test_providers_catalogue_endpoint(client):
    r = await client.get("/v1/providers")
    assert r.status_code == 200
    ps = {p["id"]: p for p in r.json()["providers"]}
    assert set(ps) == {"openai", "openrouter", "groq", "mock"}
    assert ps["groq"]["capabilities"]["embeddings"] is False
    assert ps["openai"]["capabilities"]["structured_output"] == "model-dependent"
    assert ps["mock"]["name"] == "Mock (testing only)"
    assert "base_url" not in ps["openai"]
    for p in ps.values():
        assert {"id", "name", "docs_url", "key_hint", "capabilities", "embedding_dimensions_note"} <= set(p)


async def test_models_endpoint_shape(client):
    with respx.mock as m:
        m.get(BASES["groq"] + "/models").mock(return_value=httpx.Response(200, json=GROQ_MODELS))
        r = await client.post("/v1/providers/models", json={"provider": "groq", "api_key": CANARY_KEY})
    assert r.status_code == 200
    j = r.json()
    assert j["provider"] == "groq" and j["fetched_at"].endswith("Z")
    assert j["models"][0].keys() >= {"id", "name", "capabilities", "capability_source"}
    assert CANARY_KEY not in r.text


async def test_models_endpoint_error_shape(client):
    with respx.mock as m:
        m.get(BASES["openai"] + "/models").mock(return_value=httpx.Response(401, json=err_body("bad")))
        r = await client.post("/v1/providers/models", json={"provider": "openai", "api_key": CANARY_KEY})
    assert r.status_code == 502
    e = r.json()["error"]
    assert e["code"] == "PROVIDER_AUTH_INVALID" and e["retryable"] is False and CANARY_KEY not in r.text


async def test_test_endpoint_is_always_200(client):
    with respx.mock as m:
        m.get(BASES["openai"] + "/models").mock(return_value=httpx.Response(401, json=err_body("bad")))
        r = await client.post("/v1/providers/test", json={"provider": "openai", "api_key": CANARY_KEY})
    assert r.status_code == 200 and r.json()["ok"] is False and r.json()["code"] == "PROVIDER_AUTH_INVALID"
    with respx.mock as m:
        m.get(BASES["openai"] + "/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "x"}]}))
        r = await client.post("/v1/providers/test", json={"provider": "openai", "api_key": CANARY_KEY})
    assert r.json() == {"ok": True, "latency_ms": r.json()["latency_ms"], "models_count": 1}
