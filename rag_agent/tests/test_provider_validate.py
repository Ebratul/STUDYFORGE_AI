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
    assert set(out["checks"]) == {"auth", "chat", "chat_params", "embedding"}
    assert out["checks"]["chat_params"] == {"ok": None, "skipped": True, "message": "No custom parameters are set, so the provider's defaults are used."}
    assert all(out["checks"][k]["ok"] is True for k in ("auth", "chat", "embedding"))
    assert out["checks"]["embedding"]["dimension"] == 1536 and out["checks"]["embedding"]["native_dimension"] == 1536
    assert "request_dimensions" not in out["checks"]["embedding"]
    assert CANARY_KEY not in r.text

    sent_chat = json.loads(chat.calls.last.request.content)
    assert sent_chat["model"] == "deepseek/deepseek-chat"
    assert sent_chat["max_tokens"] <= 8 and sent_chat["temperature"] == 0 and not sent_chat.get("stream")
    assert [x["role"] for x in sent_chat["messages"]] == ["user"] and sent_chat["messages"][0]["content"] == "Reply with OK."
    sent_emb = json.loads(emb.calls.last.request.content)
    assert sent_emb["model"] == "openai/text-embedding-3-small" and sent_emb["input"] == ["StudyForge connection test"]
    assert "dimensions" not in sent_emb and sent_emb["encoding_format"] == "float"  # no size asked for: the native size is measured, nothing is sent
    assert emb.call_count == 1

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
    ("provider", "emb"),
    [
        ("openrouter", "openai/text-embedding-3-small"),
        ("openrouter", "openai/text-embedding-3-large"),
        ("openrouter", "cohere/embed-english-v3.0"),
        ("openai", "text-embedding-3-large"),
        ("openai", "text-embedding-ada-002"),
    ],
)
async def test_dimensions_param_is_never_sent_unless_a_different_size_is_requested(client, provider, emb):
    base = BASES[provider]
    with respx.mock as m:
        if provider == "openrouter":
            m.get(f"{OR}/key").mock(return_value=httpx.Response(200, json={"data": {}}))
        m.get(f"{base}/models").mock(return_value=httpx.Response(200, json={"data": []}))
        m.post(f"{base}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json()))
        route = m.post(f"{base}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1, 1536)))
        r = await client.post(URL, json=body(provider=provider, emb=emb))
        same = await client.post(URL, json=body(provider=provider, emb=emb, embedding_dimension=1536))  # requested == native
    assert r.json()["checks"]["embedding"]["ok"] is True and same.json()["checks"]["embedding"]["ok"] is True
    assert all("dimensions" not in json.loads(c.request.content) for c in route.calls) and route.call_count == 2


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
async def test_a_model_that_ignores_the_requested_size_is_a_mismatch_naming_both_sizes(client, dim):
    with respx.mock as m:
        _, emb_route = mock_ok(m, dim=dim)  # always answers `dim`, whatever is asked
        r = await client.post(URL, json=body(emb="openai/text-embedding-3-large", embedding_dimension=1536))
    out = r.json()
    emb = out["checks"]["embedding"]
    assert out["ok"] is False and out["embedding_dimension"] is None
    assert emb["ok"] is False and emb["code"] == "EMBEDDING_DIMENSION_MISMATCH" and emb["dimension"] == dim and emb["native_dimension"] == dim
    assert str(dim) in emb["message"] and "1536" in emb["message"]
    sent = [json.loads(c.request.content) for c in emb_route.calls]
    assert [("dimensions" in s) for s in sent] == [False, True] and sent[1]["dimensions"] == 1536


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
    assert out["ok"] is True and out["embedding_dimension"] == 1536 and all(out["checks"][k]["ok"] for k in ("auth", "chat", "embedding"))
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
    assert out["checks"]["embedding"]["ok"] is True and out["embedding_dimension"] == 3072  # no size requested: the native size is used
    out = await run(emb="mock-embed-3072", embedding_dimension=1536)
    assert out["checks"]["embedding"]["code"] == "EMBEDDING_DIMENSION_MISMATCH" and out["embedding_dimension"] is None and "3072" in out["checks"]["embedding"]["message"]

    out = await run(emb="mock-embed-nan")
    assert out["checks"]["embedding"]["code"] == "PROVIDER_ERROR"


async def test_mock_is_not_validatable_when_disabled_or_in_production(pool):
    for kw in ({"allow_mock_provider": False}, {"app_env": "production", "allow_mock_provider": True}):
        app = create_app(make_settings(**kw), pool=pool)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}) as c:
            r = await c.post(URL, json=body(provider="mock", key="mock-valid-key", chat="mock-chat", emb="mock-embed"))
            assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"


# ----------------------------------------------------------------------------------------- Increment 1: parameters + diagnostics
from app.providers.openrouter import clear_public_cache  # noqa: E402

PUBLIC_FREE = {"data": [{"id": "nvidia/nemotron-3-ultra-550b-a55b:free", "name": "Nemotron (free)", "context_length": 1000000, "pricing": {"prompt": "0", "completion": "0"}, "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["max_tokens", "seed", "temperature", "top_p"]}]}
FREE_CHAT = "nvidia/nemotron-3-ultra-550b-a55b:free"


@pytest.fixture(autouse=True)
def _clear_public_cache():
    clear_public_cache()
    yield
    clear_public_cache()


def _with_metadata(m, listing=PUBLIC_FREE):
    m.get(f"{OR}/key").mock(return_value=httpx.Response(200, json={"data": {}}))
    m.get(f"{OR}/models").mock(return_value=httpx.Response(200, json=listing))
    m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(200, json=embed_json(1, 1536)))


async def test_unset_parameters_are_skipped_and_nothing_extra_is_sent(client):
    with respx.mock as m:
        chat, _ = mock_ok(m)
        r = await client.post(URL, json=body(chat_params={}))
    assert r.json()["checks"]["chat_params"]["skipped"] is True
    assert chat.call_count == 1  # no second paid call when there is nothing to verify


async def test_parameter_the_models_listing_does_not_include_is_refused_without_any_paid_call(client):
    with respx.mock as m:
        _with_metadata(m)
        chat = m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json("OK")))
        r = await client.post(URL, json=body(chat=FREE_CHAT, chat_params={"temperature": 0.3, "frequency_penalty": 0.5, "presence_penalty": 0.1}))
    out = r.json()
    cp = out["checks"]["chat_params"]
    assert out["ok"] is False and cp["ok"] is False and cp["code"] == "PARAMETER_UNSUPPORTED"
    assert cp["unsupported"] == ["frequency_penalty", "presence_penalty"]
    assert "temperature" not in cp["message"] and "frequency_penalty" in cp["message"]
    assert chat.call_count == 1  # only the availability check; the unsupported parameters were never sent
    assert out["checks"]["chat"]["ok"] is True and out["checks"]["embedding"]["ok"] is True


async def test_supported_parameters_are_verified_with_one_tiny_call_that_requires_them(client):
    with respx.mock as m:
        _with_metadata(m)
        chat = m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json("OK")))
        r = await client.post(URL, json=body(chat=FREE_CHAT, chat_params={"temperature": 0.2, "top_p": 0.9, "seed": 7, "max_output_tokens": 4000}))
    out = r.json()
    assert out["ok"] is True
    assert out["checks"]["chat_params"] == {"ok": True, "latency_ms": out["checks"]["chat_params"]["latency_ms"], "verified": ["max_tokens", "seed", "temperature", "top_p"], "diagnostics": {"source": "metadata_and_live_call"}}
    assert chat.call_count == 2
    sent = json.loads(chat.calls.last.request.content)
    assert sent["temperature"] == 0.2 and sent["top_p"] == 0.9 and sent["seed"] == 7
    assert sent["max_tokens"] <= 8  # the test never spends the user's real limit
    assert sent["provider"] == {"require_parameters": True}
    first = json.loads(chat.calls[0].request.content)
    assert "provider" not in first and "seed" not in first  # the availability check stays minimal


async def test_without_metadata_the_live_call_decides_and_a_router_refusal_is_reported_as_unsupported_parameters(client):
    with respx.mock as m:
        _with_metadata(m, listing={"data": []})
        calls = {"n": 0}

        def respond(request):
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(200, json=chat_json("OK"))
            return httpx.Response(404, json={"error": {"code": 404, "message": "No endpoints found that can handle the requested parameters"}})

        m.post(f"{OR}/chat/completions").mock(side_effect=respond)
        r = await client.post(URL, json=body(chat_params={"frequency_penalty": 1}))
    cp = r.json()["checks"]["chat_params"]
    assert cp["ok"] is False and cp["code"] == "PARAMETER_UNSUPPORTED" and cp["unsupported"] == ["frequency_penalty"]
    assert cp["diagnostics"]["http_status"] == 404 and cp["diagnostics"]["endpoint"] == "POST /chat/completions"


async def test_chat_params_are_skipped_when_the_chat_model_itself_fails(client):
    with respx.mock as m:
        _with_metadata(m)
        m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(404, json={"error": {"code": 404, "message": "No endpoints found for x"}}))
        r = await client.post(URL, json=body(chat_params={"temperature": 0.2}))
    out = r.json()["checks"]
    assert out["chat"]["code"] == "MODEL_NOT_FOUND" and out["chat_params"]["skipped"] is True


@pytest.mark.parametrize("bad", [{"temperature": 2.5}, {"top_p": -0.1}, {"frequency_penalty": 3}, {"presence_penalty": -2.1}, {"seed": -1}, {"max_output_tokens": 0}, {"unknown": 1}])
async def test_out_of_range_or_unknown_parameters_are_422(client, bad):
    r = await client.post(URL, json=body(chat_params=bad))
    assert r.status_code == 422 and CANARY_KEY not in r.text


async def test_failures_carry_sanitised_diagnostics_but_never_upstream_text_or_the_key(client, caplog):
    caplog.set_level(logging.INFO)
    upstream = {"error": {"code": 400, "message": f"Provider returned error for key {CANARY_KEY} and prompt SECRET-PROMPT", "metadata": {"provider_name": "Nvidia", "raw": f"{CANARY_KEY} RAW BODY"}}}
    with respx.mock as m:
        m.get(f"{OR}/key").mock(return_value=httpx.Response(200, json={"data": {}}))
        m.get(f"{OR}/models").mock(return_value=httpx.Response(200, json={"data": []}))
        m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json("OK")))
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(400, json=upstream))
        r = await client.post(URL, json=body(emb="nvidia/nemotron-3.5-embed-1b:free"))
    emb = r.json()["checks"]["embedding"]
    assert emb["ok"] is False and emb["code"] == "PROVIDER_ERROR"
    assert emb["diagnostics"] == {"endpoint": "POST /embeddings", "http_status": 400, "upstream_code": "400", "upstream_provider": "Nvidia"}
    everything = r.text + caplog.text
    assert CANARY_KEY not in everything and "SECRET-PROMPT" not in everything and "RAW BODY" not in everything
    logged = [rec for rec in caplog.records if rec.getMessage() == "validate_check_failed"]
    assert logged and logged[0].check == "embedding" and logged[0].http_status == 400 and logged[0].endpoint == "POST /embeddings"


async def test_an_error_wrapped_in_http_200_is_classified_not_called_unexpected(client):
    wrapped = {"error": {"code": 429, "message": "rate limited upstream", "metadata": {"provider_name": "Nvidia"}}}
    with respx.mock as m:
        m.get(f"{OR}/key").mock(return_value=httpx.Response(200, json={"data": {}}))
        m.get(f"{OR}/models").mock(return_value=httpx.Response(200, json={"data": []}))
        m.post(f"{OR}/chat/completions").mock(return_value=httpx.Response(200, json=chat_json("OK")))
        m.post(f"{OR}/embeddings").mock(return_value=httpx.Response(200, json=wrapped))
        r = await client.post(URL, json=body())
    emb = r.json()["checks"]["embedding"]
    assert emb["code"] == "PROVIDER_RATE_LIMITED" and emb["diagnostics"]["wrapped_in_http_200"] is True and emb["diagnostics"]["http_status"] == 429


async def test_public_models_endpoint_is_keyless_cached_and_trimmed(client):
    listing = {"data": [
        {"id": "a/free-chat:free", "name": "Free chat", "context_length": 4096, "pricing": {"prompt": "0", "completion": "0"}, "architecture": {"output_modalities": ["text"]}, "supported_parameters": ["temperature", "BAD PARAM!", 5]},
        {"id": "b/paid-chat", "pricing": {"prompt": "0.000001", "completion": "0.000002"}, "architecture": {"output_modalities": ["text"]}},
        {"id": "c/embedder", "architecture": {"output_modalities": ["embeddings"]}},
        {"id": "d/image-only", "architecture": {"output_modalities": ["image"]}},
    ]}
    with respx.mock as m:
        route = m.get(f"{OR}/models").mock(return_value=httpx.Response(200, json=listing))
        r1 = await client.get("/v1/providers/openrouter/public-models?kind=chat")
        r2 = await client.get("/v1/providers/openrouter/public-models?kind=chat")
        sent_auth = route.calls.last.request.headers.get("authorization")
    out = r1.json()
    assert [x["id"] for x in out["models"]] == ["a/free-chat:free", "b/paid-chat"]
    assert out["models"][0] == {"id": "a/free-chat:free", "name": "Free chat", "context_length": 4096, "free": True, "supported_parameters": ["temperature"]}
    assert out["models"][1]["free"] is False and out["models"][1]["supported_parameters"] is None
    assert route.call_count == 1 and r2.json()["models"] == out["models"]  # cached
    assert sent_auth is None  # keyless: no Authorization header at all


async def test_public_models_for_a_provider_without_a_listing(client):
    r = await client.get("/v1/providers/groq/public-models?kind=chat")
    assert r.status_code == 200 and r.json()["available"] is False and r.json()["models"] == []
    assert (await client.get("/v1/providers/openrouter/public-models?kind=bogus")).status_code == 422


async def test_mock_parameter_behaviour(client):
    ok = (await client.post(URL, json=body(provider="mock", key="mock-valid-key", chat="mock-chat", emb="mock-embed", chat_params={"frequency_penalty": 0.5, "seed": 1}))).json()
    assert ok["checks"]["chat_params"]["ok"] is True
    limited = (await client.post(URL, json=body(provider="mock", key="mock-valid-key", chat="mock-chat-limited", emb="mock-embed", chat_params={"frequency_penalty": 0.5, "seed": 1}))).json()
    assert limited["ok"] is False and limited["checks"]["chat_params"]["unsupported"] == ["frequency_penalty"]
