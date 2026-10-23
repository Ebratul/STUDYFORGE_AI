"""POST /v1/providers/validate (AI_CONNECTION_SPEC §1) against MOCKED HTTP (respx). No live calls, no real keys."""

from __future__ import annotations

import json
import logging

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.errors import ErrorCode, ProviderError
from app.main import create_app
from app.providers.base import EmbedRequest
from app.providers.openai import OpenAIProvider
from app.providers.openrouter import OpenRouterProvider
from tests.conftest import CANARY_KEY, SERVICE_TOKEN, make_settings
from tests.helpers import BASES, chat_json, embed_json, err_body

OR = BASES["openrouter"]
URL = "/v1/providers/validate"


def body(provider="openrouter", chat="deepseek/deepseek-chat", emb="openai/text-embedding-3-small", key=CANARY_KEY, **extra):
    return {"provider": provider, "api_key": key, "chat_model": chat, "embedding_model": emb, **extra}


def mock_ok(m, base=OR, *, dim=1536, chat_text="OK"):
    """Happy-path routes for an OpenAI-compatible provider rooted at `base` (OpenRouter also has /key)."""
    if base == OR:
        m.get(f"{OR}/key").mock(return_value=httpx.Response(200, json={"data": {"label": "k"}}))
    m.get(f"{base}/models").mock(return_value=httpx.Response(200, json={"data": [{"id": "x"}]}))
    chat = m.post(f"{base}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json(chat_text)))
    emb = m.post(f"{base}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1, dim)))
    return chat, emb


# ----------------------------------------------------------------------------------------------------- success + request shape
async def test_openrouter_all_checks_pass_and_requests_are_minimal(client):
    with respx.mock as m:
        chat, emb = mock_ok(m)
        r = await client.post(URL, json=body())
        calls = list(m.calls)
    assert r.status_code == 200
    out = r.json()
    assert out["ok"] is True and out["provider"] == "openrouter" and out["embedding_dimension"] == 1536
    assert set(out["checks"]) == {"auth", "chat", "embedding"} and all(c["ok"] is True for c in out["checks"].values())
    assert out["checks"]["embedding"]["dimension"] == 1536
    assert CANARY_KEY not in r.text

    sent_chat = json.loads(chat.calls.last.request.content)
    assert sent_chat["model"] == "deepseek/deepseek-chat"
    assert sent_chat["max_tokens"] <= 8 and sent_chat["temperature"] == 0 and not sent_chat.get("stream")
    assert [x["role"] for x in sent_chat["messages"]] == ["user"] and sent_chat["messages"][0]["content"] == "Reply with OK."
    sent_emb = json.loads(emb.calls.last.request.content)
    assert sent_emb["model"] == "openai/text-embedding-3-small" and sent_emb["input"] == ["StudyForge connection test"]
    assert sent_emb["dimensions"] == 1536 and sent_emb["encoding_format"] == "float"

    # the key only ever goes to https://openrouter.ai/api/v1/... in the Authorization header
    assert {c.request.url.host for c in calls} == {"openrouter.ai"}
    assert all(c.request.url.path.startswith("/api/v1/") for c in calls)
    for c in calls:
        assert c.request.headers["authorization"] == f"Bearer {CANARY_KEY}"
        assert CANARY_KEY.encode() not in c.request.content and CANARY_KEY not in str(c.request.url)


async def test_empty_chat_completion_with_valid_finish_still_counts(client):
    with respx.mock as m:
        mock_ok(m, chat_text="")
        r = await client.post(URL, json=body())
    assert r.json()["checks"]["chat"]["ok"] is True


@pytest.mark.parametrize(
    ("provider", "emb", "expect_dims"),
    [
        ("openrouter", "openai/text-embedding-3-small", True),
        ("openrouter", "openai/text-embedding-3-large", True),
        ("openrouter", "cohere/embed-english-v3.0", False),
        ("openrouter", "text-embedding-3-small", False),  # not the openai/ prefix the adapter documents
        ("openai", "text-embedding-3-large", True),
        ("openai", "text-embedding-ada-002", False),
    ],
)
async def test_dimensions_param_only_where_documented(client, provider, emb, expect_dims):
    base = BASES[provider]
    with respx.mock as m:
        if provider == "openrouter":
            m.get(f"{OR}/key").mock(return_value=httpx.Response(200, json={"data": {}}))
        m.get(f"{base}/models").mock(return_value=httpx.Response(200, json={"data": []}))
        m.post(f"{base}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json()))
        route = m.post(f"{base}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1, 1536)))
        r = await client.post(URL, json=body(provider=provider, emb=emb))
    assert r.json()["checks"]["embedding"]["ok"] is True
    sent = json.loads(route.calls.last.request.content)
    assert ("dimensions" in sent) is expect_dims
    assert sent.get("dimensions", 1536) == 1536


# ----------------------------------------------------------------------------------------------------- auth failures
async def test_bad_key_skips_the_other_checks_and_makes_no_paid_calls(client):
    with respx.mock as m:
        m.get(f"{OR}/key").mock(return_value=httpx.Response(401, json=err_body(f"No auth {CANARY_KEY}", code="invalid_api_key")))
        chat = m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json()))
        emb = m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1)))
        r = await client.post(URL, json=body())
    out = r.json()
    assert r.status_code == 200 and out["ok"] is False and out["embedding_dimension"] is None
    assert out["checks"]["auth"]["ok"] is False and out["checks"]["auth"]["code"] == "PROVIDER_AUTH_INVALID"
    assert out["checks"]["chat"] == {"ok": None, "skipped": True}
    assert out["checks"]["embedding"] == {"ok": None, "skipped": True}
    assert not chat.called and not emb.called
    assert CANARY_KEY not in r.text  # the upstream body echoed the key; it must not be copied anywhere


# ----------------------------------------------------------------------------------------------------- model failures
@pytest.mark.parametrize(
    "resp",
    [
        httpx.Response(404, json=err_body("No endpoints found for nope/nope", code=404)),
        httpx.Response(400, json=err_body("nope/nope is not a valid model ID", code=400)),
    ],
)
async def test_unknown_chat_model(client, resp):
    with respx.mock as m:
        _, emb = mock_ok(m)
        m.post(f"{OR}/chat/completions").mock(return_value=resp)
        r = await client.post(URL, json=body(chat="nope/nope"))
    out = r.json()
    assert out["ok"] is False
    assert out["checks"]["chat"]["code"] == "MODEL_NOT_FOUND" and "model" in out["checks"]["chat"]["message"].lower()
    assert out["checks"]["embedding"]["ok"] is True and emb.called  # independent checks


@pytest.mark.parametrize(
    ("resp", "code"),
    [
        (httpx.Response(404, json=err_body("No endpoints found for x", code=404)), "MODEL_NOT_FOUND"),
        (httpx.Response(400, json=err_body("model does not exist")), "MODEL_NOT_FOUND"),
        (httpx.Response(400, json=err_body("this model does not support embeddings")), "PROVIDER_ERROR"),  # a chat model id used as embedding
    ],
)
async def test_embedding_id_that_is_not_an_embedding_model(client, resp, code):
    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/embeddings").mock(return_value=resp)
        r = await client.post(URL, json=body(emb="deepseek/deepseek-chat"))
    out = r.json()
    assert out["ok"] is False and out["checks"]["chat"]["ok"] is True
    assert out["checks"]["embedding"]["code"] == code and out["embedding_dimension"] is None


# ----------------------------------------------------------------------------------------------------- embedding shape
async def test_non_finite_vector_is_rejected(client):
    raw = '{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1, NaN, 0.3]}]}'
    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(200, content=raw, headers={"content-type": "application/json"}))
        r = await client.post(URL, json=body())
    emb = r.json()["checks"]["embedding"]
    assert emb["ok"] is False and emb["code"] == "PROVIDER_ERROR" and r.json()["embedding_dimension"] is None


@pytest.mark.parametrize(
    "payload",
    [
        {"data": []},
        {"data": [{"embedding": []}]},
        {"data": [{"embedding": "AAAA"}]},  # base64 string instead of floats
        {"data": [{"embedding": [0.1, "x"]}]},
        {"data": [{"embedding": [0.1]}, {"embedding": [0.1]}]},  # exactly one vector expected
        {"nope": 1},
    ],
)
async def test_malformed_embedding_payloads(client, payload):
    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(200, json=payload))
        r = await client.post(URL, json=body())
    emb = r.json()["checks"]["embedding"]
    assert emb["ok"] is False and emb["code"] == "PROVIDER_ERROR"


async def test_malformed_json_bodies(client):
    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(200, text="<html>oops</html>"))
        m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, text="not json"))
        r = await client.post(URL, json=body())
    out = r.json()
    assert out["checks"]["embedding"]["code"] == "PROVIDER_ERROR" and out["checks"]["chat"]["code"] == "PROVIDER_ERROR"
    assert "oops" not in r.text


@pytest.mark.parametrize("dim", [3072, 768, 1024])
async def test_dimension_mismatch_names_the_measured_size(client, dim):
    with respx.mock as m:
        mock_ok(m, dim=dim)
        r = await client.post(URL, json=body(emb="openai/text-embedding-3-large"))
    out = r.json()
    emb = out["checks"]["embedding"]
    assert out["ok"] is False and out["embedding_dimension"] == dim
    assert emb["ok"] is False and emb["code"] == "EMBEDDING_DIMENSION_MISMATCH" and emb["dimension"] == dim
    assert str(dim) in emb["message"] and "1536" in emb["message"]


# ----------------------------------------------------------------------------------------------------- upstream errors
async def test_rate_limit_and_credits_and_timeout_are_normalised(client):
    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(429, json=err_body("slow down", code="rate_limit_exceeded")))
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(402, json=err_body("Insufficient credits. Add more using https://openrouter.ai/credits", code=402)))
        r = await client.post(URL, json=body())
    out = r.json()
    assert out["checks"]["chat"]["code"] == "PROVIDER_RATE_LIMITED"
    assert out["checks"]["embedding"]["code"] == "QUOTA_EXCEEDED"
    assert "credits" not in out["checks"]["embedding"]["message"].lower() or "quota" in out["checks"]["embedding"]["message"].lower()

    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/chat/completions").mock(side_effect=httpx.ReadTimeout("slow"))
        m.post(f"{OR}/embeddings").mock(side_effect=httpx.ConnectTimeout("slow"))
        r = await client.post(URL, json=body())
    out = r.json()
    assert out["checks"]["chat"]["code"] == "PROVIDER_TIMEOUT" and out["checks"]["embedding"]["code"] == "PROVIDER_TIMEOUT"


async def test_server_errors_and_connection_failures(client):
    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(503, json=err_body("down")))
        m.post(f"{OR}/embeddings").mock(side_effect=httpx.ConnectError("boom"))
        r = await client.post(URL, json=body())
    out = r.json()
    assert out["checks"]["chat"]["code"] == "PROVIDER_UNAVAILABLE" and out["checks"]["embedding"]["code"] == "PROVIDER_UNAVAILABLE"


async def test_probe_never_follows_redirects_so_the_key_cannot_leave_the_provider_host(settings):
    p = OpenRouterProvider(settings)
    with respx.mock(assert_all_called=False) as m:
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(307, headers={"location": "https://evil.example/steal"}))
        evil = m.post("https://evil.example/steal").mock(return_value=httpx.Response(200, json=embed_json(1)))
        with pytest.raises(ProviderError) as ei:
            await p.probe_embedding(EmbedRequest(model="openai/text-embedding-3-small", api_key=SecretStr(CANARY_KEY), inputs=["x"]))
    assert not evil.called
    assert CANARY_KEY not in str(ei.value) and ei.value.code in (ErrorCode.PROVIDER_ERROR, ErrorCode.PROVIDER_UNAVAILABLE)


# ----------------------------------------------------------------------------------------------------- providers without embeddings
async def test_groq_has_no_embeddings(client):
    g = BASES["groq"]
    with respx.mock as m:
        m.get(f"{g}/models").mock(return_value=httpx.Response(200, json={"data": []}))
        chat = m.post(f"{g}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json()))
        emb = m.post(f"{g}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1)))
        r = await client.post(URL, json=body(provider="groq", chat="llama-3.3-70b-versatile", emb="whatever"))
    out = r.json()
    assert out["ok"] is False and out["checks"]["chat"]["ok"] is True
    assert out["checks"]["embedding"]["code"] == "CAPABILITY_UNSUPPORTED" and "OpenRouter" in out["checks"]["embedding"]["message"]
    assert not emb.called
    assert json.loads(chat.calls.last.request.content)["max_completion_tokens"] <= 8  # Groq/OpenAI parameter name; token cap applies everywhere


# ----------------------------------------------------------------------------------------------------- secrets
async def test_canary_key_never_in_responses_logs_or_exceptions(client, caplog):
    caplog.set_level(logging.DEBUG)
    with respx.mock as m:
        mock_ok(m)
        m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(400, json=err_body(f"bad key {CANARY_KEY}")))
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(500, json=err_body(f"oops Bearer {CANARY_KEY}")))
        r = await client.post(URL, json=body())
    assert CANARY_KEY not in r.text
    assert CANARY_KEY not in caplog.text and CANARY_KEY not in "".join(rec.getMessage() for rec in caplog.records)
    assert any(rec.getMessage() == "validate_done" for rec in caplog.records)  # we do log the outcome, without content

    p = OpenAIProvider(make_settings())
    with respx.mock as m:
        m.post(f"{BASES['openai']}/embeddings").mock(return_value=httpx.Response(401, json=err_body(f"key {CANARY_KEY}")))
        with pytest.raises(ProviderError) as ei:
            await p.probe_embedding(EmbedRequest(model="text-embedding-3-small", api_key=SecretStr(CANARY_KEY), inputs=["x"]))
    assert CANARY_KEY not in str(ei.value) and CANARY_KEY not in ei.value.message and ei.value.code == ErrorCode.PROVIDER_AUTH_INVALID


# ----------------------------------------------------------------------------------------------------- endpoint contract
async def test_endpoint_requires_the_service_token(settings, pool):
    app = create_app(settings, pool=pool)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x") as c:
        assert (await c.post(URL, json=body())).status_code == 401
        assert (await c.post(URL, json=body(), headers={"Authorization": "Bearer wrong"})).status_code == 401


@pytest.mark.parametrize(
    "bad",
    [
        {"provider": ""},
        {"provider": "nope"},
        {"api_key": ""},
        {"chat_model": "   "},
        {"embedding_model": ""},
        {"chat_model": "x" * 201},
        {"extra": 1},
        {"provider": 5},
    ],
)
async def test_validation_errors_do_not_echo_the_key(client, bad):
    r = await client.post(URL, json={**body(key=CANARY_KEY), **bad})
    assert r.status_code == 422 and CANARY_KEY not in r.text


async def test_missing_fields_are_422(client):
    for key in ("provider", "api_key", "chat_model", "embedding_model"):
        payload = body()
        payload.pop(key)
        assert (await client.post(URL, json=payload)).status_code == 422


async def test_model_ids_are_trimmed(client):
    with respx.mock as m:
        chat, _ = mock_ok(m)
        r = await client.post(URL, json=body(chat="  deepseek/deepseek-chat  "))
    assert r.json()["ok"] is True and json.loads(chat.calls.last.request.content)["model"] == "deepseek/deepseek-chat"


# ----------------------------------------------------------------------------------------------------- mock provider
async def test_mock_all_ok(client):
    r = await client.post(URL, json=body(provider="mock", key="mock-valid-key", chat="mock-chat", emb="mock-embed"))
    out = r.json()
    assert out["ok"] is True and out["embedding_dimension"] == 1536 and all(c["ok"] for c in out["checks"].values())
    r = await client.post(URL, json=body(provider="mock", key="mock-valid-key", chat="mock-chat-plain", emb="mock-embed"))
    assert r.json()["ok"] is True


async def test_mock_behaviours(client):
    async def run(**kw):
        return (await client.post(URL, json=body(provider="mock", **{"key": "mock-valid-key", "chat": "mock-chat", "emb": "mock-embed", **kw}))).json()

    bad_key = await run(key="nope")
    assert bad_key["checks"]["auth"]["code"] == "PROVIDER_AUTH_INVALID" and bad_key["checks"]["chat"]["skipped"] is True

    out = await run(chat="gpt-4o")
    assert out["checks"]["chat"]["code"] == "MODEL_NOT_FOUND" and out["checks"]["embedding"]["ok"] is True

    out = await run(emb="text-embedding-3-small")
    assert out["checks"]["embedding"]["code"] == "MODEL_NOT_FOUND"

    out = await run(emb="mock-embed-3072")
    assert out["checks"]["embedding"]["code"] == "EMBEDDING_DIMENSION_MISMATCH" and out["embedding_dimension"] == 3072 and "3072" in out["checks"]["embedding"]["message"]

    out = await run(emb="mock-embed-nan")
    assert out["checks"]["embedding"]["code"] == "PROVIDER_ERROR"


async def test_mock_is_not_validatable_when_disabled_or_in_production(pool):
    for kw in ({"allow_mock_provider": False}, {"app_env": "production", "allow_mock_provider": True}):
        app = create_app(make_settings(**kw), pool=pool)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}) as c:
            r = await c.post(URL, json=body(provider="mock", key="mock-valid-key", chat="mock-chat", emb="mock-embed"))
            assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
