"""HTTP layer: auth, validation, SSE/NDJSON endpoints, end-to-end with the mock provider, real-socket disconnect."""

from __future__ import annotations

import asyncio
import json
import socket

import httpx
import pytest
import uvicorn

from app.main import create_app
from app.prompts import FALLBACK_TEXT, LEAK_REFUSAL
from app.providers.mock import VALID_KEY
from tests.conftest import CANARY_KEY, SERVICE_TOKEN, add_doc, make_settings
from tests.fakes import FakeProvider
from tests import fixtures_files as ff


def parse_sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = block.split("\n")
        assert lines[0].startswith("event: ") and lines[1].startswith("data: "), block
        out.append((lines[0][7:], json.loads(lines[1][6:])))
    return out


def chat_payload(mode="GENERAL", text="hello there", docs=(), provider="mock", key=VALID_KEY, emb=True, **extra):
    p = {
        "request_id": "req-1", "user_id": "alice", "mode": mode,
        "chat": {"provider": provider, "api_key": key, "model": "mock-chat", "params": {"temperature": 0.3, "top_p": None, "max_output_tokens": 256}},
        "embedding": {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": 1536} if emb else None,
        "messages": [{"role": "user", "content": text}], "document_ids": list(docs), "use_documents": True,
        "retrieval": {"top_k": 6, "min_similarity": 0.3, "max_context_chars": 12000},
    }
    p.update(extra)
    return p


async def post_chat(client, payload, **kw):
    r = await client.post("/v1/chat/stream", json=payload, **kw)
    return r


# ------------------------------------------------------------------------------------------------ auth / health
async def test_health_and_ready_are_unauthenticated_and_expose_nothing(client):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://x") as anon:
        r = await anon.get("/health")
        assert r.status_code == 200 and r.json() == {"status": "ok"}
        r = await anon.get("/ready")
        assert r.status_code == 200 and r.json() == {"status": "ready"}


async def test_ready_is_503_when_db_down(settings):
    from app.db import make_pool

    pool = make_pool("postgresql://u:p@127.0.0.1:1/nope", min_size=1, max_size=1)
    app = create_app(settings, pool=pool)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x") as c:
        r = await c.get("/ready")
    assert r.status_code == 503 and r.json() == {"status": "unavailable"}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong-token-wrong-token-wrong"}, {"Authorization": SERVICE_TOKEN},
                                     {"Authorization": "Basic abc"}, {"Authorization": "Bearer "}])
@pytest.mark.parametrize("method,path", [("GET", "/v1/providers"), ("POST", "/v1/providers/test"), ("POST", "/v1/providers/models"),
                                         ("POST", "/v1/chat/stream"), ("POST", "/v1/ingest")])
async def test_v1_requires_service_token(client, headers, method, path):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://x") as anon:
        r = await anon.request(method, path, headers=headers, json={"provider": "mock", "api_key": VALID_KEY})
    assert r.status_code == 401
    assert r.json() == {"error": {"code": "SERVICE_UNAUTHORIZED", "message": "Unauthorized.", "retryable": False}}


async def test_request_id_is_propagated(client):
    r = await client.get("/health", headers={"x-request-id": "abc-123"})
    assert r.headers["x-request-id"] == "abc-123"
    r = await client.get("/health", headers={"x-request-id": "bad id with spaces\n"})
    assert r.headers["x-request-id"] != "bad id with spaces"
    assert (await client.get("/health")).headers["x-request-id"]


async def test_unknown_route_uses_error_shape(client):
    r = await client.get("/v1/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "VALIDATION"


# ------------------------------------------------------------------------------------------------ providers with mock
async def test_mock_provider_credential_test(client):
    r = await client.post("/v1/providers/test", json={"provider": "mock", "api_key": VALID_KEY})
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["models_count"] == 3
    r = await client.post("/v1/providers/test", json={"provider": "mock", "api_key": "something-else"})
    assert r.status_code == 200 and r.json() == {"ok": False, "code": "PROVIDER_AUTH_INVALID", "message": r.json()["message"], "retryable": False}
    assert "something-else" not in r.text


async def test_mock_models(client):
    r = await client.post("/v1/providers/models", json={"provider": "mock", "api_key": VALID_KEY})
    by = {m["id"]: m for m in r.json()["models"]}
    assert set(by) == {"mock-chat", "mock-chat-plain", "mock-embed"}
    assert by["mock-chat"]["capabilities"]["structured_output"] == "yes" and by["mock-chat-plain"]["capabilities"]["structured_output"] == "no"
    assert by["mock-embed"]["capabilities"]["embeddings"] is True
    r = await client.post("/v1/providers/models", json={"provider": "mock", "api_key": "bad"})
    assert r.status_code == 502 and r.json()["error"]["code"] == "PROVIDER_AUTH_INVALID"


async def test_mock_is_unknown_when_disabled_or_in_production(pool):
    for kw in ({"allow_mock_provider": False}, {"app_env": "production", "allow_mock_provider": True}):
        s = make_settings(**kw)
        assert not s.mock_enabled
        app = create_app(s, pool=pool)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}) as c:
            r = await c.post("/v1/providers/test", json={"provider": "mock", "api_key": VALID_KEY})
            assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
            assert "mock" not in {p["id"] for p in (await c.get("/v1/providers")).json()["providers"]}
            r = await c.post("/v1/chat/stream", json=chat_payload())
            assert r.status_code == 422


async def test_unknown_provider_and_validation_do_not_echo_keys(client):
    r = await client.post("/v1/providers/test", json={"provider": "nope", "api_key": CANARY_KEY})
    assert r.status_code == 422 and CANARY_KEY not in r.text
    r = await client.post("/v1/providers/test", json={"provider": 5, "api_key": CANARY_KEY})
    assert r.status_code == 422 and CANARY_KEY not in r.text and r.json()["error"]["code"] == "VALIDATION"
    r = await client.post("/v1/chat/stream", json=chat_payload(key=CANARY_KEY, mode="BOGUS"))
    assert r.status_code == 422 and CANARY_KEY not in r.text


# ------------------------------------------------------------------------------------------------ chat validation
@pytest.mark.parametrize("mutate", [
    lambda p: p.update(messages=[{"role": "user", "content": "x"}] * 41),
    lambda p: p.update(messages=[{"role": "assistant", "content": "x"}]),
    lambda p: p.update(messages=[]),
    lambda p: p.update(messages=[{"role": "system", "content": "x"}]),
    lambda p: p.update(messages=[{"role": "user", "content": "x" * 61_000}]),
    lambda p: p.update(document_ids=[f"d{i}" for i in range(51)]),
    lambda p: p["chat"]["params"].update(temperature=2.5),
    lambda p: p["chat"]["params"].update(temperature=-0.1),
    lambda p: p["chat"]["params"].update(top_p=1.5),
    lambda p: p["chat"]["params"].update(max_output_tokens=0),
    lambda p: p["chat"]["params"].update(max_output_tokens=40000),
    lambda p: p.update(mode="NOPE"),
    lambda p: p["chat"].update(provider="nope"),
    lambda p: p.update(user_id=""),
    lambda p: p["chat"].pop("api_key"),
])
async def test_chat_validation_422(client, mutate):
    p = chat_payload()
    mutate(p)
    r = await client.post("/v1/chat/stream", json=p)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION" and "traceback" not in r.text.lower()


async def test_chat_boundaries_are_accepted(client):
    p = chat_payload(text="x" * 100)
    p["messages"] = [{"role": "user", "content": "q"}] * 40
    p["chat"]["params"] = {"temperature": 2, "top_p": 1, "max_output_tokens": 32768}
    r = await client.post("/v1/chat/stream", json=p)
    assert r.status_code == 200


async def test_oversized_json_body_rejected(client):
    r = await client.post("/v1/chat/stream", content=b"x" * (1024 * 1024 + 10), headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "FILE_TOO_LARGE"


# ------------------------------------------------------------------------------------------------ chat SSE
async def test_general_chat_sse_headers_and_event_order(client):
    r = await client.post("/v1/chat/stream", json=chat_payload(text="hello there"))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"].startswith("no-cache") and r.headers["x-accel-buffering"] == "no"
    ev = parse_sse(r.text)
    names = [n for n, _ in ev]
    assert names[0] == "meta" and names[-1] == "final" and names.count("final") == 1 and "error" not in names
    assert ev[0][1] == {"request_id": "req-1", "mode": "GENERAL", "provider": "mock", "model": "mock-chat", "documents_considered": 0, "retrieval": "skipped"}
    text = "".join(d["text"] for n, d in ev if n == "delta")
    assert text.startswith("Mock reply: ") and "hello there" in text
    final = ev[-1][1]
    assert final["content"] == text and final["usage"]["prompt_tokens"] is not None


async def test_mock_markers_rate_limit_and_fail_are_error_events(client):
    ev = parse_sse((await client.post("/v1/chat/stream", json=chat_payload(text="please [[rate-limit]]"))).text)
    assert ev[-1][0] == "error" and ev[-1][1] == {"code": "PROVIDER_RATE_LIMITED", "message": ev[-1][1]["message"], "retryable": True, "retry_after_seconds": 3}
    assert "final" not in [n for n, _ in ev]
    ev = parse_sse((await client.post("/v1/chat/stream", json=chat_payload(text="[[fail]]"))).text)
    assert ev[-1][0] == "error" and ev[-1][1]["code"] == "PROVIDER_UNAVAILABLE"


async def test_bad_chat_key_is_an_error_event_without_key(client):
    r = await client.post("/v1/chat/stream", json=chat_payload(key=CANARY_KEY))
    ev = parse_sse(r.text)
    assert ev[-1][0] == "error" and ev[-1][1]["code"] == "PROVIDER_AUTH_INVALID" and CANARY_KEY not in r.text


async def test_leak_marker_is_filtered_in_general_mode(client):
    r = await client.post("/v1/chat/stream", json=chat_payload(text="[[leak]]"))
    assert VALID_KEY not in r.text and "CANARY-" not in r.text
    final = parse_sse(r.text)[-1][1]
    assert final["content"] == LEAK_REFUSAL


async def test_end_to_end_ingest_then_document_only_chat_with_mock(client, db):
    await add_doc(db, "alice", "doc-1", name="Cell Biology.txt", version=0)
    text = ("Mitochondria are organelles that produce ATP through oxidative phosphorylation.\n\n"
            "Ribosomes translate messenger RNA into proteins inside the cell.")
    meta = {"document_id": "doc-1", "owner_id": "alice", "filename": "Cell Biology.txt", "mime_type": "text/plain", "processing_version": 1,
            "embedding": {"provider": "mock", "api_key": VALID_KEY, "model": "mock-embed", "dimension": 1536}}
    r = await client.post("/v1/ingest", data={"meta": json.dumps(meta)}, files={"file": ("Cell Biology.txt", text.encode(), "text/plain")})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(x) for x in r.text.strip().split("\n")]
    assert lines[-1]["type"] == "result" and lines[-1]["status"] == "READY" and lines[-1]["chunk_count"] == 1
    assert VALID_KEY not in r.text

    # grounded answer, verified quote
    r = await client.post("/v1/chat/stream", json=chat_payload("DOCUMENT_ONLY", "Mitochondria produce ATP oxidative phosphorylation", docs=["doc-1"]))
    ev = parse_sse(r.text)
    names = [n for n, _ in ev]
    assert names == ["meta", "status", "status", "delta", "citations", "final"]
    cit = ev[names.index("citations")][1]["citations"][0]
    assert cit["document_name"] == "Cell Biology.txt" and cit["quote_verified"] is True and cit["ordinal"] == 1
    from app.citations import norm

    assert norm(cit["quote"]) in norm(text)
    assert ev[-1][1]["fallback"] is False

    # irrelevant question -> deterministic fallback (no LLM)
    r = await client.post("/v1/chat/stream", json=chat_payload("DOCUMENT_ONLY", "quantum chromodynamics gluon lattice", docs=["doc-1"]))
    ev = parse_sse(r.text)
    assert [n for n, _ in ev] == ["meta", "final"] and ev[-1][1]["content"] == FALLBACK_TEXT

    # another user can't read it even with the id
    p = chat_payload("DOCUMENT_ONLY", "Mitochondria produce ATP oxidative phosphorylation", docs=["doc-1"])
    p["user_id"] = "mallory"
    ev = parse_sse((await client.post("/v1/chat/stream", json=p)).text)
    assert ev[-1][1]["fallback"] is True and "citations" not in [n for n, _ in ev]

    # mock markers on the grounded path
    for marker in ("[[bad-citation]]", "[[unsupported]]"):
        r = await client.post("/v1/chat/stream", json=chat_payload("DOCUMENT_ONLY", f"Mitochondria produce ATP oxidative {marker}", docs=["doc-1"]))
        ev = parse_sse(r.text)
        assert ev[-1][1]["fallback"] is True and ev[-1][1]["content"] == FALLBACK_TEXT, marker
    r = await client.post("/v1/chat/stream", json=chat_payload("DOCUMENT_ONLY", "Mitochondria produce ATP oxidative [[leak]]", docs=["doc-1"]))
    assert VALID_KEY not in r.text and "CANARY-" not in r.text and parse_sse(r.text)[-1][1]["fallback"] is True


# ------------------------------------------------------------------------------------------------ ingest endpoint
def ingest_meta(doc="doc-x", owner="alice", filename="a.txt", version=1, provider="mock", key=VALID_KEY, model="mock-embed"):
    return json.dumps({"document_id": doc, "owner_id": owner, "filename": filename, "processing_version": version,
                       "embedding": {"provider": provider, "api_key": key, "model": model, "dimension": 1536}})


async def test_ingest_validation_errors_are_plain_4xx(client, db):
    await add_doc(db, "alice", "doc-x")
    f = {"file": ("a.txt", b"hello world " * 20, "text/plain")}
    r = await client.post("/v1/ingest", data={"meta": "not json"}, files=f)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    r = await client.post("/v1/ingest", data={"meta": ingest_meta(owner="mallory")}, files=f)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION"
    r = await client.post("/v1/ingest", data={"meta": ingest_meta(doc="missing")}, files=f)
    assert r.status_code == 422
    r = await client.post("/v1/ingest", data={"meta": ingest_meta(provider="nope", key=CANARY_KEY)}, files=f)
    assert r.status_code == 422 and CANARY_KEY not in r.text
    r = await client.post("/v1/ingest", data={"meta": ingest_meta()})
    assert r.status_code == 422
    r = await client.post("/v1/ingest", data={"meta": json.dumps({"document_id": "x", "embedding": {"api_key": CANARY_KEY}})}, files=f)
    assert r.status_code == 422 and CANARY_KEY not in r.text


async def test_ingest_expected_failure_is_a_result_line(client, db):
    await add_doc(db, "alice", "doc-x", name="scan.pdf")
    r = await client.post("/v1/ingest", data={"meta": ingest_meta(filename="scan.pdf")}, files={"file": ("scan.pdf", ff.make_blank_pdf(2), "application/pdf")})
    last = json.loads(r.text.strip().split("\n")[-1])
    assert r.status_code == 200 and last["type"] == "result" and last["status"] == "NEEDS_OCR" and last["code"] == "NEEDS_OCR"


async def test_ingest_provider_error_is_an_error_line(client, db):
    await add_doc(db, "alice", "doc-x")
    r = await client.post("/v1/ingest", data={"meta": ingest_meta(key="wrong-key")}, files={"file": ("a.txt", b"hello " * 50, "text/plain")})
    last = json.loads(r.text.strip().split("\n")[-1])
    assert last["type"] == "error" and last["code"] == "PROVIDER_AUTH_INVALID" and "wrong-key" not in r.text


async def test_ingest_busy_when_concurrency_exceeded(db, pool):
    s = make_settings(max_concurrent_ingests=1)
    from app.providers.registry import ProviderRegistry

    reg = ProviderRegistry(s)
    release, started = asyncio.Event(), asyncio.Event()

    class Slow(FakeProvider):
        async def embed(self, req):
            started.set()
            await release.wait()
            return await super().embed(req)

    reg.register_for_tests(Slow("openai"))
    app = create_app(s, registry=reg, pool=pool)
    await add_doc(db, "alice", "doc-x")
    await add_doc(db, "alice", "doc-y")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://x", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}) as c:
        files = lambda: {"file": ("a.txt", b"hello world " * 30, "text/plain")}
        m1 = ingest_meta("doc-x", provider="openai", key=CANARY_KEY, model="m")
        t1 = asyncio.create_task(c.post("/v1/ingest", data={"meta": m1}, files=files()))
        await asyncio.wait_for(started.wait(), 10)
        r2 = await c.post("/v1/ingest", data={"meta": ingest_meta("doc-y", provider="openai", key=CANARY_KEY, model="m")}, files=files())
        assert r2.status_code == 429 and r2.json()["error"] == {"code": "BUSY", "message": r2.json()["error"]["message"], "retryable": True, "retry_after_seconds": 5}
        assert r2.headers["retry-after"] == "5"
        release.set()
        r1 = await t1
        assert json.loads(r1.text.strip().split("\n")[-1])["status"] == "READY"
        assert app.state.ingests_active == 0
        r3 = await c.post("/v1/ingest", data={"meta": ingest_meta("doc-y", provider="openai", key=CANARY_KEY, model="m")}, files=files())
        assert r3.status_code == 200  # slot was released


async def test_ingest_oversize_upload(client, db):
    await add_doc(db, "alice", "doc-x")
    s = client.app.state.settings
    big = b"a" * (s.max_upload_bytes + 10)
    r = await client.post("/v1/ingest", data={"meta": ingest_meta()}, files={"file": ("a.txt", big, "text/plain")})
    assert r.status_code == 200 and json.loads(r.text.strip().split("\n")[-1])["code"] == "FILE_TOO_LARGE"
    huge = b"a" * (s.max_upload_bytes + 2 * 1024 * 1024)
    r = await client.post("/v1/ingest", data={"meta": ingest_meta()}, files={"file": ("a.txt", huge, "text/plain")})
    assert r.status_code == 413


# ------------------------------------------------------------------------------------------------ real socket: disconnect
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
    yield f"http://127.0.0.1:{port}", app
    server.should_exit = True
    await task


async def test_disconnect_cancels_upstream_provider_stream(live_server, registry):
    base, app = live_server
    fake = FakeProvider("openai", stream_script=[["hello ", "__sleep__", "never"]])
    registry.register_for_tests(fake)
    p = chat_payload(provider="openai")
    p["chat"]["model"] = "gpt-x"
    async with httpx.AsyncClient(base_url=base, headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}, timeout=10) as c:
        async with c.stream("POST", "/v1/chat/stream", json=p) as r:
            assert r.status_code == 200
            seen = ""
            async for chunk in r.aiter_text():
                seen += chunk
                if "event: status" in seen:
                    break
            for _ in range(100):  # wait until the upstream call is really in flight
                if fake.stream_requests:
                    break
                await asyncio.sleep(0.02)
            await asyncio.sleep(0.1)
        # leaving the context closes the connection
    for _ in range(100):
        if fake.stream_closed:
            break
        await asyncio.sleep(0.05)
    assert fake.stream_cancelled and fake.stream_closed, "upstream provider call must be cancelled promptly on client disconnect"


async def test_slow_mock_stream_can_be_stopped(live_server):
    base, app = live_server
    async with httpx.AsyncClient(base_url=base, headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}, timeout=10) as c:
        async with c.stream("POST", "/v1/chat/stream", json=chat_payload(text="[[slow]]")) as r:
            got = ""
            async for chunk in r.aiter_text():
                got += chunk
                if got.count("event: delta") >= 2:
                    break
    assert "tok0" in got


async def test_disconnect_during_ingest_cancels_embedding_and_stores_nothing(live_server, registry, db):
    base, app = live_server
    await add_doc(db, "alice", "doc-live")
    started = asyncio.Event()

    class Hang(FakeProvider):
        cancelled = False

        async def embed(self, req):
            started.set()
            try:
                await asyncio.sleep(60)
            except asyncio.CancelledError:
                Hang.cancelled = True
                raise

    registry.register_for_tests(Hang("openai"))
    meta = ingest_meta("doc-live", provider="openai", key=CANARY_KEY, model="m")
    async with httpx.AsyncClient(base_url=base, headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}, timeout=10) as c:
        req = c.build_request("POST", "/v1/ingest", data={"meta": meta}, files={"file": ("a.txt", b"hello world " * 40, "text/plain")})
        r = await c.send(req, stream=True)
        assert r.status_code == 200
        await asyncio.wait_for(started.wait(), 10)
        await r.aclose()
    for _ in range(100):
        if Hang.cancelled:
            break
        await asyncio.sleep(0.05)
    assert Hang.cancelled
    for _ in range(100):
        if app.state.ingests_active == 0:
            break
        await asyncio.sleep(0.05)
    assert app.state.ingests_active == 0
    async with db.connection() as conn:
        cur = await conn.execute('SELECT count(*) FROM "DocumentChunk" WHERE "documentId"=%s', ("doc-live",))
        assert (await cur.fetchone())[0] == 0
