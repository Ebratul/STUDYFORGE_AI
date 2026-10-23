"""Gemini (Google AI Studio, OpenAI-compatibility endpoint) against MOCKED HTTP (respx). No live calls, no real keys."""

from __future__ import annotations

import json

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.providers import catalogue
from app.providers.gemini import GeminiProvider
from app.redact import scrub
from tests.conftest import CANARY_KEY
from tests.helpers import BASES, chat_json, embed_json, err_body

G = BASES["gemini"]
KEY = SecretStr(CANARY_KEY)
URL = "/v1/providers/validate"

GEMINI_MODELS = {
    "object": "list",
    "data": [
        {"id": "models/gemini-2.5-flash", "object": "model", "owned_by": "google"},
        {"id": "gemini-2.5-pro", "object": "model", "owned_by": "google"},
        {"id": "models/gemma-3-27b-it", "object": "model", "owned_by": "google"},
        {"id": "models/gemini-embedding-001", "object": "model", "owned_by": "google"},
        {"id": "models/text-embedding-004", "object": "model", "owned_by": "google"},
        {"id": "models/imagen-4.0-generate-001", "object": "model", "owned_by": "google"},
        {"id": "models/veo-3.0-generate-001", "object": "model", "owned_by": "google"},
        {"id": "models/gemini-2.5-flash-preview-tts", "object": "model", "owned_by": "google"},
        {"id": "models/gemini-live-2.5-flash", "object": "model", "owned_by": "google"},
        {"id": "models/aqa", "object": "model", "owned_by": "google"},
        {"id": 7, "object": "model"},
    ],
}


def body(chat="gemini-2.5-flash", emb="gemini-embedding-001", key=CANARY_KEY, **extra):
    return {"provider": "gemini", "api_key": key, "chat_model": chat, "embedding_model": emb, **extra}


def mock_ok(m, *, dim=3072):
    m.get(f"{G}/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "models/gemini-2.5-flash"}]}))
    chat = m.post(f"{G}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json("OK")))
    emb = m.post(f"{G}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1, dim)))
    return chat, emb


# ---------------------------------------------------------------------------------------------------------- catalogue / model list
def test_gemini_is_in_the_catalogue_with_a_fixed_google_endpoint():
    meta = catalogue.PROVIDERS["gemini"]
    assert meta.base_url == "https://generativelanguage.googleapis.com/v1beta/openai" and meta.embeddings and meta.key_hint == "AIza..."
    assert GeminiProvider.base_url == meta.base_url and GeminiProvider.id == "gemini"


async def test_models_are_split_into_chat_and_embedding_and_ids_lose_the_models_prefix(settings):
    with respx.mock as m:
        m.get(G + "/models").mock(return_value=httpx.Response(200, json=GEMINI_MODELS))
        models = await GeminiProvider(settings).list_models(KEY)
    by = {x.id: x for x in models}
    assert set(by) == {"gemini-2.5-flash", "gemini-2.5-pro", "gemma-3-27b-it", "gemini-embedding-001", "text-embedding-004"}
    assert by["gemini-2.5-flash"].capabilities.chat and not by["gemini-2.5-flash"].capabilities.embeddings
    assert by["gemini-embedding-001"].capabilities.embeddings and not by["gemini-embedding-001"].capabilities.chat
    # strict json_schema support is undocumented, so it is never claimed
    assert by["gemini-2.5-flash"].capabilities.structured_output == "unknown" and by["gemini-2.5-flash"].capability_source == "unverified"
    assert GeminiProvider(settings).structured_support("gemini-2.5-flash") == "unknown"


# ---------------------------------------------------------------------------------------------------------- credential test + errors
async def test_credential_test_sends_the_key_only_to_google(settings):
    with respx.mock as m:
        route = m.get(G + "/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "models/a"}, {"id": "models/b"}]}))
        res = await GeminiProvider(settings).test(KEY)
    assert res.ok and res.models_count == 2
    sent = route.calls.last.request
    assert sent.url.host == "generativelanguage.googleapis.com" and sent.url.path == "/v1beta/openai/models"
    assert sent.headers["authorization"] == f"Bearer {CANARY_KEY}"


@pytest.mark.parametrize(
    "resp,code",
    [
        # Google answers a bad key with HTTP 400, sometimes wrapped in a one-element list
        (httpx.Response(400, json=[{"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}}]), "PROVIDER_AUTH_INVALID"),
        (httpx.Response(400, json={"error": {"code": 400, "message": "API key not valid", "status": "INVALID_ARGUMENT"}}), "PROVIDER_AUTH_INVALID"),
        (httpx.Response(403, json=[{"error": {"code": 403, "message": "Permission denied", "status": "PERMISSION_DENIED"}}]), "PROVIDER_AUTH_INVALID"),
        (httpx.Response(429, json=[{"error": {"code": 429, "message": "You exceeded your current quota, please check your plan and billing details.", "status": "RESOURCE_EXHAUSTED"}}]), "QUOTA_EXCEEDED"),
        (httpx.Response(429, json=[{"error": {"code": 429, "message": "Too many requests", "status": "RESOURCE_EXHAUSTED"}}]), "PROVIDER_RATE_LIMITED"),
        (httpx.Response(503, json=[{"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}}]), "PROVIDER_UNAVAILABLE"),
    ],
)
async def test_gemini_error_shapes_are_classified_and_never_leak_the_key(settings, resp, code):
    with respx.mock as m:
        m.get(G + "/models").mock(return_value=resp)
        res = await GeminiProvider(settings).test(KEY)
    assert not res.ok and res.code == code
    assert CANARY_KEY not in (res.message or "")


async def test_a_400_that_is_not_about_the_key_is_not_called_an_auth_error(settings):
    with respx.mock as m:
        m.get(G + "/models").mock(return_value=httpx.Response(400, json=err_body("Unsupported parameter: foo")))
        res = await GeminiProvider(settings).test(KEY)
    assert not res.ok and res.code == "PROVIDER_ERROR"


def test_a_google_api_key_is_redacted_from_text():
    leaked = "failed for key AIzaSyA-1234567890abcdefghijklmnopqrstuv at /v1beta"
    out = scrub(leaked)
    assert "AIzaSy" not in out and "[REDACTED]" in out


# ---------------------------------------------------------------------------------------------------------- connection validation
async def test_validate_native_size_sends_no_dimensions_and_measures_3072(client):
    with respx.mock as m:
        chat, emb = mock_ok(m)
        r = await client.post(URL, json=body())
        hosts = {c.request.url.host for c in m.calls}
    out = r.json()
    assert r.status_code == 200 and out["ok"] is True and out["provider"] == "gemini" and out["embedding_dimension"] == 3072
    assert hosts == {"generativelanguage.googleapis.com"}
    assert json.loads(chat.calls.last.request.content)["max_tokens"] <= 8
    sent = json.loads(emb.calls.last.request.content)
    assert sent["model"] == "gemini-embedding-001" and "dimensions" not in sent
    assert CANARY_KEY not in r.text


async def test_validate_a_smaller_size_that_google_honours_is_accepted(client):
    with respx.mock as m:
        mock_ok(m, dim=3072)

        def answer(request: httpx.Request) -> httpx.Response:
            asked = json.loads(request.content).get("dimensions")
            return httpx.Response(200, json=embed_json(1, asked or 3072))

        m.post(f"{G}/embeddings").mock(side_effect=answer)
        r = await client.post(URL, json=body(embedding_dimension=1536))
    out = r.json()
    assert out["ok"] is True and out["embedding_dimension"] == 1536
    assert out["checks"]["embedding"]["native_dimension"] == 3072 and out["checks"]["embedding"]["request_dimensions"] == 1536


async def test_validate_reports_when_the_endpoint_ignores_dimensions_and_saves_nothing(client):
    """The OpenAI-compatible endpoint's `dimensions` support is undocumented: an ignored parameter must be reported, not assumed."""
    with respx.mock as m:
        mock_ok(m, dim=3072)  # always answers 3072, whatever was asked
        r = await client.post(URL, json=body(embedding_dimension=1536))
    out = r.json()
    emb = out["checks"]["embedding"]
    assert out["ok"] is False and out["embedding_dimension"] is None
    assert emb["code"] == "EMBEDDING_DIMENSION_MISMATCH" and emb["dimension"] == 3072 and "3072" in emb["message"]


async def test_validate_bad_key_stops_after_the_auth_check(client):
    with respx.mock(assert_all_called=False) as m:
        m.get(G + "/models").mock(return_value=httpx.Response(400, json=[{"error": {"code": 400, "message": "API key not valid. Please pass a valid API key."}}]))
        chat = m.post(f"{G}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json()))
        r = await client.post(URL, json=body())
    out = r.json()
    assert out["ok"] is False and out["checks"]["auth"]["code"] == "PROVIDER_AUTH_INVALID"
    assert not chat.called and CANARY_KEY not in r.text
