"""HTTP layer for /v1/generate/{mcq,cq}: auth, validation (422), SSE event order, error events, disconnect."""

from __future__ import annotations

import asyncio
import socket

import httpx
import pytest
import uvicorn

from app.main import create_app
from app.providers.base import ChatRequest, StructuredResult
from tests.conftest import CANARY_KEY, SERVICE_TOKEN, make_settings
from tests.fakes import FakeProvider
from tests.gen_utils import payload
from tests.test_api import parse_sse


# ------------------------------------------------------------------------------------------------ auth
@pytest.mark.parametrize("path", ["/v1/generate/mcq", "/v1/generate/cq"])
async def test_auth_is_required(client, path):
    kind = "MCQ" if path.endswith("mcq") else "CQ"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://x") as anon:
        assert (await anon.post(path, json=payload(kind))).status_code == 401
        r = await anon.post(path, json=payload(kind), headers={"Authorization": "Bearer wrong-token-0123456789abcdef"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "SERVICE_UNAUTHORIZED"


# ------------------------------------------------------------------------------------------------ validation
def bad(**changes):
    p = payload()
    for path, value in changes.items():
        node = p
        keys = path.split("__")
        for k in keys[:-1]:
            node = node[k]
        node[keys[-1]] = value
    return p


@pytest.mark.parametrize("p", [
    bad(spec__count=0), bad(spec__count=101), bad(spec__option_count=1), bad(spec__option_count=7), bad(spec__difficulty="IMPOSSIBLE"),
    bad(spec__language="fr"), bad(grounding="WHATEVER"), bad(sources__pasted_text=None),  # source policy without material
    bad(grounding="GENERAL"),  # GENERAL must not carry pasted text
    bad(grounding="GENERAL", sources__pasted_text=None),  # ...and needs a topic
    bad(grounding="GENERAL", sources__pasted_text=None, sources__topic="x", sources__document_ids=["d"]),  # ...and no documents
    bad(avoid=["x"] * 61), bad(avoid=["y" * 301]), bad(sources__document_ids=[f"d{i}" for i in range(51)]),
    bad(spec__marks=-1), bad(spec__negative_marks=500), bad(limits__max_llm_calls=0), bad(limits__batch_size=0), bad(context_tokens=10),
    bad(chat__params__max_output_tokens=0), bad(user_id=""),
])
async def test_mcq_validation_422(client, p):
    r = await client.post("/v1/generate/mcq", json=p)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    assert CANARY_KEY not in r.text


async def test_cq_validation_422(client):
    base = payload("CQ")
    for spec in ({"structure": "stimulus_4part", "part_marks": [1, 2, 3]}, {"structure": "multipart", "part_count": 3, "part_marks": [1, 2]},
                 {"structure": "multipart", "part_count": 2, "part_marks": [1, 2], "total_marks": 10}, {"structure": "descriptive", "part_marks": [10]},
                 {"mode": "SOMETHING"}, {"structure": "poem"}, {"total_marks": 0}, {"count": 0}):
        r = await client.post("/v1/generate/cq", json={**base, "spec": {**base["spec"], **spec}})
        assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION", spec


async def test_unknown_provider_is_422_before_streaming_and_mock_is_hidden_in_production(client, pool):
    r = await client.post("/v1/generate/mcq", json=payload(provider="nope"))
    assert r.status_code == 422 and r.headers["content-type"].startswith("application/json")
    prod = create_app(make_settings(app_env="production"), pool=pool)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=prod), base_url="http://x", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}) as c:
        r = await c.post("/v1/generate/mcq", json=payload(provider="mock"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"


# ------------------------------------------------------------------------------------------------ SSE
async def test_mcq_stream_event_order_and_payload(client):
    r = await client.post("/v1/generate/mcq", json=payload(count=3))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream") and r.headers["cache-control"].startswith("no-cache")
    ev = parse_sse(r.text)
    kinds = [e for e, _ in ev]
    assert kinds[0] == "meta" and kinds[-1] == "result" and kinds.count("result") == 1 and "error" not in kinds
    assert all(k in ("meta", "status", "result") for k in kinds)
    res = ev[-1][1]
    assert len(res["questions"]) == 3 and set(res) == {"questions", "rejected", "warnings", "usage", "sources_used"}
    assert CANARY_KEY not in r.text


async def test_cq_stream_and_bangla_text_survives_the_wire(client):
    r = await client.post("/v1/generate/cq", json=payload("CQ", grounding="GENERAL", pasted=None, topic="Photosynthesis", language="bn", count=1))
    ev = parse_sse(r.text)
    q = ev[-1][1]["questions"][0]
    assert ev[-1][0] == "result" and q["parts"][0]["label"] == "ক" and "উদ্দীপক" in q["stem"]


async def test_failures_arrive_as_a_single_terminal_error_event(client):
    r = await client.post("/v1/generate/mcq", json=payload(key="wrong-key"))
    ev = parse_sse(r.text)
    assert r.status_code == 200 and [e for e, _ in ev][-1] == "error" and [e for e, _ in ev].count("error") == 1 and "result" not in [e for e, _ in ev]
    assert ev[-1][1]["code"] == "PROVIDER_AUTH_INVALID" and "retryable" in ev[-1][1]
    r = await client.post("/v1/generate/mcq", json=payload(topic="[[bad-key-always]]"))
    last = parse_sse(r.text)[-1]
    assert last[0] == "error" and last[1]["code"] == "GENERATION_FAILED" and last[1]["reason"] == "NO_VALID_QUESTIONS"


async def test_request_id_header_is_echoed_and_keys_never_appear_in_logs(client, caplog):
    import logging

    caplog.set_level(logging.DEBUG)
    p = payload(key="mock-valid-key", count=1)
    r = await client.post("/v1/generate/mcq", json=p, headers={"x-request-id": "gen-req-1"})
    assert r.headers["x-request-id"] == "gen-req-1"
    assert "mock-valid-key" not in caplog.text and CANARY_KEY not in caplog.text
    from app.logging import JsonFormatter
    assert all("Mitochondri" not in JsonFormatter().format(rec) for rec in caplog.records)  # source text is never logged


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


class HangingProvider(FakeProvider):
    cancelled = False

    async def generate_structured(self, req: ChatRequest, schema) -> StructuredResult:
        self.llm_calls += 1
        self.structured_requests.append(req)
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        raise AssertionError("unreachable")


async def test_disconnect_cancels_the_provider_call(live_server, registry):
    hang = HangingProvider("openai")
    registry.register_for_tests(hang)
    p = payload(provider="openai", model="gpt-x", count=2)
    async with httpx.AsyncClient(base_url=live_server, headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}, timeout=10) as c:
        async with c.stream("POST", "/v1/generate/mcq", json=p) as r:
            assert r.status_code == 200
            seen = ""
            async for chunk in r.aiter_text():
                seen += chunk
                if "event: status" in seen and '"generating"' in seen:
                    break
            for _ in range(100):  # wait until the provider call is really in flight
                if hang.structured_requests:
                    break
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.1)
    for _ in range(100):
        if hang.cancelled:
            break
        await asyncio.sleep(0.05)
    assert hang.cancelled, "the provider call must be cancelled promptly when the client disconnects"
