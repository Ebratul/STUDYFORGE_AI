"""HTTP layer for /v1/analyze/{result,plan}: auth, validation (422), response shape, usage, error mapping, disconnect."""

from __future__ import annotations

import asyncio
import copy
import socket

import httpx
import pytest
import uvicorn

from app.main import create_app
from tests.analysis_utils import CANARY_KEY, good_analysis, plan_payload, result_payload, topic
from tests.conftest import SERVICE_TOKEN
from tests.fakes import FakeProvider
from tests.test_analysis_graph import HangingProvider

PATHS = [("/v1/analyze/result", result_payload), ("/v1/analyze/plan", plan_payload)]


@pytest.mark.parametrize("path,build", PATHS)
async def test_auth_is_required(client, path, build):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://x") as anon:
        assert (await anon.post(path, json=build())).status_code == 401
        r = await anon.post(path, json=build(), headers={"Authorization": "Bearer wrong-token-0123456789abcdef"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "SERVICE_UNAUTHORIZED"


def mutate(base: dict, **changes):
    p = copy.deepcopy(base)
    for path, value in changes.items():
        node = p
        keys = path.split("__")
        for k in keys[:-1]:
            node = node[k]
        node[keys[-1]] = value
    return p


async def test_result_response_shape_and_usage(client):
    r = await client.post("/v1/analyze/result", json=result_payload())
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"result", "usage", "warnings"}
    assert set(body["result"]) == {"summary", "strengths", "weaknesses", "next_steps", "caveats"}
    assert set(body["usage"]) == {"prompt_tokens", "completion_tokens", "llm_calls"} and body["usage"]["llm_calls"] == 1
    assert body["warnings"] == [] and "x-request-id" in r.headers
    assert CANARY_KEY not in r.text


async def test_plan_response_shape(client):
    r = await client.post("/v1/analyze/plan", json=plan_payload())
    assert r.status_code == 200
    body = r.json()
    assert set(body["result"]) == {"headline", "focus", "steps", "caveats"} and body["usage"]["llm_calls"] == 1
    assert set(body["result"]["steps"][0]) == {"type", "topic", "text", "minutes"}


async def test_bangla_result(client):
    r = await client.post("/v1/analyze/result", json=result_payload(language="bn"))
    assert r.status_code == 200 and "১৬" in r.json()["result"]["summary"]


BASE_R = result_payload()
BASE_P = plan_payload()


@pytest.mark.parametrize("p", [
    mutate(BASE_R, context__exam__band="AMAZING"), mutate(BASE_R, context__exam__percent_bp=10001), mutate(BASE_R, context__exam__question_count=0),
    mutate(BASE_R, context__exam__correct=99), mutate(BASE_R, context__language="fr"), mutate(BASE_R, context__history__data_level="NONE"),
    mutate(BASE_R, context__weak_topics=["Not a topic"]), mutate(BASE_R, context__strong_topics=["x"] * 9),
    mutate(BASE_R, context__topics=[topic("A", 1, 1)] * 2), mutate(BASE_R, context__topics=[topic(f"T{i}", 1, 1) for i in range(41)]),
    mutate(BASE_R, context__incorrect_items=[{"topic": "Cells", "stem": "x" * 301}]), mutate(BASE_R, context__incorrect_items=[{"topic": "Other", "stem": "x"}]),
    mutate(BASE_R, context__incorrect_items=[{"topic": "Cells", "stem": "s"}] * 26), mutate(BASE_R, chat__api_key=None), mutate(BASE_R, chat__provider=""),
    mutate(BASE_R, request_id=""), mutate(BASE_R, chat__params__max_output_tokens=0),
    {k: v for k, v in BASE_R.items() if k != "context"},
])
async def test_result_validation_422(client, p):
    r = await client.post("/v1/analyze/result", json=p)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    assert CANARY_KEY not in r.text


@pytest.mark.parametrize("p", [
    mutate(BASE_P, context__data_level="NONE"), mutate(BASE_P, context__language="fr"), mutate(BASE_P, context__results=[{"percent_bp": -1}]),
    mutate(BASE_P, context__results=[{"percent_bp": 5000}] * 51), mutate(BASE_P, context__weak_topics=["Not a topic"]), mutate(BASE_P, context__topics=[{"topic": ""}]),
    mutate(BASE_P, context__topics=[topic("A" * 61, 1, 1)]),
])
async def test_plan_validation_422(client, p):
    r = await client.post("/v1/analyze/plan", json=p)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"


async def test_oversized_request_body_is_rejected(client):
    p = mutate(BASE_R, context__exam__title="x" * 2_000_000)
    r = await client.post("/v1/analyze/result", json=p)
    assert r.status_code in (413, 422)


async def test_unknown_provider_is_a_422_before_any_work(client):
    r = await client.post("/v1/analyze/result", json=result_payload(provider="nope"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"


async def test_provider_and_generation_errors_use_the_standard_error_shape(client):
    r = await client.post("/v1/analyze/result", json=result_payload(key="wrong-key"))
    assert r.status_code == 502 and r.json()["error"]["code"] == "PROVIDER_AUTH_INVALID" and "wrong-key" not in r.text
    r = await client.post("/v1/analyze/result", json=result_payload(title="Quiz [[rate-limit]]"))
    assert r.status_code == 429 and r.headers["retry-after"] == "3" and r.json()["error"]["retryable"] is True
    r = await client.post("/v1/analyze/result", json=result_payload(title="Quiz [[ungrounded]]"))
    err = r.json()["error"]
    assert r.status_code == 502 and err["code"] == "GENERATION_FAILED" and err["reason"] == "UNGROUNDED_OUTPUT" and err["retryable"] is True
    r = await client.post("/v1/analyze/plan", json=plan_payload(topics=[topic("Cells [[bad-json-always]]", 8, 3)], weak=("Cells [[bad-json-always]]",), strong=()))
    assert r.status_code == 502 and r.json()["error"]["reason"] == "INVALID_OUTPUT"


async def test_scripted_provider_through_http_counts_calls_and_never_echoes_the_key(client, registry):
    fake = FakeProvider("openai", structured_script=[good_analysis()])
    registry.register_for_tests(fake)
    r = await client.post("/v1/analyze/result", json=result_payload(provider="openai", model="gpt-x", key=CANARY_KEY))
    assert r.status_code == 200 and fake.llm_calls == 1 and CANARY_KEY not in r.text


# ------------------------------------------------------------------------------------------------ disconnect
@pytest.fixture
async def live_server(settings, pool, registry):
    app = create_app(settings, registry=registry, pool=pool)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve())
    for _ in range(100):
        if server.started:
            break
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    await task


async def test_client_disconnect_cancels_the_provider_call(live_server, registry):
    hang = HangingProvider("openai")
    registry.register_for_tests(hang)
    p = result_payload(provider="openai", model="gpt-x")
    async with httpx.AsyncClient(base_url=live_server, headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}, timeout=10) as c:
        call = asyncio.ensure_future(c.post("/v1/analyze/result", json=p))
        for _ in range(100):
            if hang.llm_calls:
                break
            await asyncio.sleep(0.02)
        assert hang.llm_calls == 1
        call.cancel()
        with pytest.raises((asyncio.CancelledError, httpx.HTTPError)):
            await call
    for _ in range(100):
        if hang.cancelled:
            break
        await asyncio.sleep(0.05)
    assert hang.cancelled, "the provider call must be cancelled promptly when the backend gives up"
