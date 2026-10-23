"""Provider adapters against MOCKED HTTP (respx). No live calls."""

from __future__ import annotations

import asyncio
import json
import logging

import httpx
import pytest
import respx
from pydantic import SecretStr

from app.errors import ErrorCode, ProviderError
from app.providers import retry as retry_mod
from app.providers.gemini import GeminiProvider
from app.providers.groq import GroqProvider
from app.providers.openai import OpenAIProvider
from app.providers.openrouter import OpenRouterProvider
from tests.helpers import BASES, CANARY_KEY, chat_json, err_body, req, sse_response

KEY = SecretStr(CANARY_KEY)
PROVIDERS = {"openai": OpenAIProvider, "openrouter": OpenRouterProvider, "groq": GroqProvider, "gemini": GeminiProvider}


@pytest.fixture(params=list(PROVIDERS))
def prov(request, settings):
    return PROVIDERS[request.param](settings)


def url(prov) -> str:
    return BASES[prov.id] + "/chat/completions"


async def test_generate_success_and_usage(prov):
    with respx.mock as m:
        route = m.post(url(prov)).mock(return_value=httpx.Response(200, json=chat_json("hi!")))
        r = await prov.generate(req(KEY, temperature=0.3, top_p=0.9, max_output_tokens=77))
    assert r.text == "hi!"
    assert (r.usage.prompt_tokens, r.usage.completion_tokens, r.usage.total_tokens) == (11, 4, 15)
    assert r.finish_reason == "stop"
    sent = route.calls.last.request
    assert sent.headers["authorization"] == f"Bearer {CANARY_KEY}"  # key goes only to this provider's base URL
    assert sent.url.host == httpx.URL(BASES[prov.id]).host
    body = json.loads(sent.content)
    assert body["temperature"] == 0.3 and body["top_p"] == 0.9
    # OpenRouter documents max_tokens (Gemini is sent the same legacy name); OpenAI/Groq use max_completion_tokens
    assert body.get("max_tokens" if prov.id in ("openrouter", "gemini") else "max_completion_tokens") == 77


async def test_usage_is_null_when_provider_does_not_report_it(prov):
    with respx.mock as m:
        m.post(url(prov)).mock(return_value=httpx.Response(200, json=chat_json("x", usage=False)))
        r = await prov.generate(req(KEY))
    assert r.usage.prompt_tokens is None and r.usage.completion_tokens is None and r.usage.total_tokens is None


async def test_openrouter_headers_optional_title_only(settings):
    p = OpenRouterProvider(settings)
    with respx.mock as m:
        route = m.post(url(p)).mock(return_value=httpx.Response(200, json=chat_json()))
        await p.generate(req(KEY))
    h = route.calls.last.request.headers
    assert h["x-title"] == "StudyForge AI"
    assert "http-referer" not in h


async def test_stream_deltas_and_final_usage(prov):
    usage = {"prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12}
    with respx.mock as m:
        route = m.post(url(prov)).mock(return_value=sse_response(["Hel", "lo ", "world"], usage=usage))
        chunks = [c async for c in prov.stream(req(KEY))]
    assert "".join(c.delta for c in chunks) == "Hello world"
    assert chunks[-1].done and chunks[-1].usage.total_tokens == 12 and chunks[-1].finish_reason == "stop"
    body = json.loads(route.calls.last.request.content)
    assert body["stream"] is True
    if prov.id == "openrouter":  # usage arrives without stream_options
        assert "stream_options" not in body
    else:
        assert body["stream_options"] == {"include_usage": True}


async def test_stream_without_usage_chunk_degrades_to_null(prov):
    with respx.mock as m:
        m.post(url(prov)).mock(return_value=sse_response(["a", "b"]))
        chunks = [c async for c in prov.stream(req(KEY))]
    assert chunks[-1].done and chunks[-1].usage.total_tokens is None


# ------------------------------------------------------------------------------------------------ error normalisation
CASES = [
    (401, err_body(f"Incorrect API key provided: {CANARY_KEY}", code="invalid_api_key"), {}, ErrorCode.PROVIDER_AUTH_INVALID, 1),
    (403, err_body("forbidden"), {}, ErrorCode.PROVIDER_AUTH_INVALID, 1),
    (404, err_body("The model `nope` does not exist", code="model_not_found"), {}, ErrorCode.MODEL_NOT_FOUND, 1),
    (429, err_body("Rate limit reached"), {"Retry-After": "2"}, ErrorCode.PROVIDER_RATE_LIMITED, 3),
    (500, err_body("boom"), {}, ErrorCode.PROVIDER_UNAVAILABLE, 3),
    (503, err_body("unavailable"), {}, ErrorCode.PROVIDER_UNAVAILABLE, 3),
    (400, err_body("This model's maximum context length is 8192 tokens", code="context_length_exceeded"), {}, ErrorCode.CONTEXT_TOO_LONG, 1),
    (400, err_body("blocked", code="content_filter"), {}, ErrorCode.CONTENT_FILTERED, 1),
    (429, err_body("You exceeded your current quota, please check your plan and billing", code="insufficient_quota"), {}, ErrorCode.QUOTA_EXCEEDED, 1),
    (402, err_body("Insufficient credits"), {}, ErrorCode.QUOTA_EXCEEDED, 1),
    (400, err_body("some other bad request"), {}, ErrorCode.PROVIDER_ERROR, 1),
]


@pytest.mark.parametrize("status,body,headers,code,calls", CASES)
async def test_error_normalisation_and_retry_budget(prov, status, body, headers, code, calls, caplog, monkeypatch):
    async def no_sleep(_s):
        return None

    monkeypatch.setattr(retry_mod.asyncio, "sleep", no_sleep)
    caplog.set_level(logging.DEBUG)
    with respx.mock as m:
        route = m.post(url(prov)).mock(return_value=httpx.Response(status, json=body, headers=headers))
        with pytest.raises(ProviderError) as ei:
            await prov.generate(req(KEY))
    e = ei.value
    assert e.code == code
    assert route.call_count == calls  # at most 2 retries, only for 429/5xx/timeouts
    # no key / upstream text anywhere
    for text in (str(e), repr(e), e.message, json.dumps(e.to_dict())):
        assert CANARY_KEY not in text and "maximum context" not in text and "boom" not in text
    assert e.__cause__ is None and e.__suppress_context__
    assert CANARY_KEY not in caplog.text


async def test_retry_after_is_honoured_but_capped_at_5s(prov, monkeypatch):
    delays: list[float] = []

    async def fake_sleep(s):
        delays.append(s)

    monkeypatch.setattr(retry_mod.asyncio, "sleep", fake_sleep)
    with respx.mock as m:
        m.post(url(prov)).mock(return_value=httpx.Response(429, json=err_body("slow down"), headers={"Retry-After": "30"}))
        with pytest.raises(ProviderError) as ei:
            await prov.generate(req(KEY))
    assert delays == [5.0, 5.0]
    assert ei.value.retry_after_seconds == 30 and ei.value.retryable


async def test_retry_succeeds_after_transient_failure(prov):
    with respx.mock as m:
        route = m.post(url(prov)).mock(
            side_effect=[httpx.Response(503, json=err_body("x")), httpx.Response(200, json=chat_json("recovered"))]
        )
        r = await prov.generate(req(KEY))
    assert r.text == "recovered" and route.call_count == 2


async def test_auth_errors_are_never_retried_and_never_switch_provider(prov):
    with respx.mock(assert_all_called=False) as m:
        mine = m.post(url(prov)).mock(return_value=httpx.Response(401, json=err_body("bad key")))
        others = [m.post(BASES[o] + "/chat/completions").mock(return_value=httpx.Response(200, json=chat_json())) for o in BASES if o != prov.id]
        with pytest.raises(ProviderError):
            await prov.generate(req(KEY))
    assert mine.call_count == 1
    assert all(o.call_count == 0 for o in others)  # no cross-provider fallback


async def test_timeout_is_normalised(prov):
    with respx.mock as m:
        route = m.post(url(prov)).mock(side_effect=httpx.ReadTimeout("slow", request=httpx.Request("POST", url(prov))))
        with pytest.raises(ProviderError) as ei:
            await prov.generate(req(KEY))
    assert ei.value.code == ErrorCode.PROVIDER_TIMEOUT and ei.value.retryable
    assert route.call_count == 3


async def test_connection_error_is_unavailable(prov):
    with respx.mock as m:
        m.post(url(prov)).mock(side_effect=httpx.ConnectError("refused"))
        with pytest.raises(ProviderError) as ei:
            await prov.generate(req(KEY))
    assert ei.value.code == ErrorCode.PROVIDER_UNAVAILABLE


async def test_total_timeout_setting_is_enforced(settings):
    from tests.conftest import make_settings

    p = OpenAIProvider(make_settings(provider_timeout_seconds=0.05))
    with respx.mock as m:
        async def slow(request):
            await asyncio.sleep(1)
            return httpx.Response(200, json=chat_json())

        m.post(url(p)).mock(side_effect=slow)
        with pytest.raises(ProviderError) as ei:
            await p.generate(req(KEY))
    assert ei.value.code == ErrorCode.PROVIDER_TIMEOUT


async def test_malformed_success_body_is_provider_error(prov):
    with respx.mock as m:
        m.post(url(prov)).mock(return_value=httpx.Response(200, text="<html>not json</html>"))
        with pytest.raises(ProviderError) as ei:
            await prov.generate(req(KEY))
    assert ei.value.code in (ErrorCode.PROVIDER_ERROR, ErrorCode.PROVIDER_UNAVAILABLE)
    assert "html" not in ei.value.message.lower()


async def test_stream_error_before_first_chunk_is_retried_then_normalised(prov):
    with respx.mock as m:
        route = m.post(url(prov)).mock(return_value=httpx.Response(429, json=err_body("rl"), headers={"Retry-After": "1"}))
        with pytest.raises(ProviderError) as ei:
            async for _ in prov.stream(req(KEY)):
                pass
    assert ei.value.code == ErrorCode.PROVIDER_RATE_LIMITED
    assert route.call_count == 3


async def test_stream_midstream_failure_is_not_retried(prov):
    class Boom(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"par"},"finish_reason":null}]}\n\n'
            raise httpx.ReadError("connection dropped")

    with respx.mock as m:
        route = m.post(url(prov)).mock(return_value=httpx.Response(200, stream=Boom(), headers={"content-type": "text/event-stream"}))
        got = []
        with pytest.raises(ProviderError) as ei:
            async for c in prov.stream(req(KEY)):
                got.append(c.delta)
    assert got == ["par"] and route.call_count == 1
    assert ei.value.code == ErrorCode.PROVIDER_UNAVAILABLE


async def test_stream_idle_timeout(settings):
    from tests.conftest import make_settings

    p = OpenAIProvider(make_settings(stream_idle_timeout_seconds=0.05))

    class Stall(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"a"},"finish_reason":null}]}\n\n'
            await asyncio.sleep(5)

    with respx.mock as m:
        m.post(url(p)).mock(return_value=httpx.Response(200, stream=Stall(), headers={"content-type": "text/event-stream"}))
        with pytest.raises(ProviderError) as ei:
            async for _ in p.stream(req(KEY)):
                pass
    assert ei.value.code == ErrorCode.PROVIDER_TIMEOUT


async def test_openai_reasoning_models_do_not_get_sampling_params(settings):
    p = OpenAIProvider(settings)
    with respx.mock as m:
        route = m.post(url(p)).mock(return_value=httpx.Response(200, json=chat_json()))
        await p.generate(req(KEY, model="o3-mini", temperature=0.3, top_p=0.5))
    body = json.loads(route.calls.last.request.content)
    assert "temperature" not in body and "top_p" not in body


async def test_redirect_is_not_followed_with_credentials(prov):
    """list/test use httpx with follow_redirects=False: a redirect must not forward the key elsewhere."""
    with respx.mock(assert_all_called=False) as m:
        m.get(BASES[prov.id] + "/models").mock(return_value=httpx.Response(302, headers={"location": "https://evil.example/steal"}))
        m.get(BASES[prov.id] + "/key").mock(return_value=httpx.Response(302, headers={"location": "https://evil.example/steal"}))
        evil = m.get("https://evil.example/steal").mock(return_value=httpx.Response(200, json={"data": []}))
        res = await prov.test(KEY)
    assert not res.ok and evil.call_count == 0
