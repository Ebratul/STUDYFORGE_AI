from __future__ import annotations

import io
import json
import logging

import pytest
from pydantic import SecretStr, ValidationError

from app import tracing
from app.config import Settings, load_settings_or_exit
from app.errors import AppError, ErrorCode, HTTP_STATUS, SAFE_MESSAGES
from app.logging import JsonFormatter, RedactingFilter, configure_logging
from app.providers.mock import MockProvider, hash_embed, parse_sources, tokenize, VALID_KEY
from app.providers.base import ChatMessage, ChatParams, ChatRequest, EmbedRequest
from app.redact import REDACTED, bind_secrets, contains_secret, scrub, scrub_obj
from app.security import extract_bearer, token_matches
from tests.conftest import CANARY_KEY, SERVICE_TOKEN, make_settings

# ------------------------------------------------------------------------------------------------ config
def test_service_refuses_to_start_without_or_with_short_token(monkeypatch):
    monkeypatch.delenv("RAG_AGENT_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
    with pytest.raises(ValidationError) as ei:
        Settings(_env_file=None, rag_agent_token="short-token-123")
    assert "short-token-123" not in str(ei.value.errors(include_input=False))


def test_startup_exit_message_never_contains_the_token(monkeypatch):
    monkeypatch.setenv("RAG_AGENT_TOKEN", "tooshort-secret-value")
    monkeypatch.setenv("APP_ENV", "production")  # no .env.local
    with pytest.raises(SystemExit) as ei:
        load_settings_or_exit()
    assert "tooshort-secret-value" not in str(ei.value) and "RAG_AGENT_TOKEN" in str(ei.value).upper()


def test_defaults_match_contract(monkeypatch):
    for k in list(__import__("os").environ):
        if k.upper() in {f.upper() for f in Settings.model_fields}:
            monkeypatch.delenv(k)
    s = Settings(_env_file=None, rag_agent_token=SERVICE_TOKEN)
    assert (s.host, s.port) == ("127.0.0.1", 8100)
    assert s.max_upload_bytes == 25 * 1024 * 1024 and s.max_pages == 500 and s.max_text_chars == 2_000_000
    assert s.parse_timeout_seconds == 60 and s.chunk_target_chars == 3200 and s.chunk_overlap_chars == 400
    assert s.provider_timeout_seconds == 60 and s.max_chat_chars == 60_000 and s.retrieval_top_k == 6
    assert s.retrieval_min_similarity == 0.30 and s.retrieval_max_context_chars == 12_000
    assert s.max_concurrent_ingests == 2 and s.ocr_enabled is False
    assert not hasattr(s, "embedding_dimensions")  # the dimension is per request now (backend owns the setting)
    assert s.langsmith_tracing is False and s.langsmith_include_content is False


def test_invalid_config_is_rejected():
    for kw in ({"chunk_overlap_chars": 5000}, {"port": 0}, {"app_env": "staging"}):
        with pytest.raises(ValidationError):
            make_settings(**kw)


def test_mock_provider_only_when_enabled_and_not_production():
    assert make_settings(allow_mock_provider=True, app_env="development").mock_enabled
    assert not make_settings(allow_mock_provider=False).mock_enabled
    assert not make_settings(allow_mock_provider=True, app_env="production").mock_enabled


def test_secrets_are_secretstr_and_hidden_in_repr():
    s = make_settings()
    assert isinstance(s.rag_agent_token, SecretStr) and isinstance(s.database_url, SecretStr)
    assert SERVICE_TOKEN not in repr(s) and SERVICE_TOKEN not in str(s.model_dump())


def test_env_example_has_only_placeholders_and_all_variables():
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / ".env.example").read_text()
    for var in ("APP_ENV", "HOST", "PORT", "DATABASE_URL", "RAG_AGENT_TOKEN", "ALLOW_MOCK_PROVIDER", "MAX_UPLOAD_BYTES",
                "MAX_PAGES", "MAX_TEXT_CHARS", "PARSE_TIMEOUT_SECONDS", "CHUNK_TARGET_CHARS", "CHUNK_OVERLAP_CHARS", "PROVIDER_TIMEOUT_SECONDS",
                "MAX_CHAT_CHARS", "RETRIEVAL_TOP_K", "RETRIEVAL_MIN_SIMILARITY", "RETRIEVAL_MAX_CONTEXT_CHARS", "MAX_CONCURRENT_INGESTS",
                "OCR_ENABLED", "LOG_LEVEL", "LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_INCLUDE_CONTENT"):
        assert f"{var}=" in text
    assert "studyforge_dev_only" not in text and "sk-" not in text


def test_gitignore_covers_env_and_venv():
    from pathlib import Path

    gi = (Path(__file__).resolve().parents[1] / ".gitignore").read_text()
    for needle in (".venv", "__pycache__", ".pytest_cache", ".env"):
        assert needle in gi


# ------------------------------------------------------------------------------------------------ auth helper
def test_token_compare_and_bearer_parsing():
    assert token_matches(SERVICE_TOKEN, SERVICE_TOKEN) and not token_matches("x", SERVICE_TOKEN) and not token_matches(None, SERVICE_TOKEN)
    assert not token_matches("", SERVICE_TOKEN) and not token_matches(SERVICE_TOKEN + "x", SERVICE_TOKEN)
    assert extract_bearer("Bearer abc") == "abc" and extract_bearer("bearer  abc ") == "abc"
    assert extract_bearer("abc") is None and extract_bearer("Basic abc") is None and extract_bearer(None) is None


# ------------------------------------------------------------------------------------------------ redaction
def test_scrub_bound_secret_and_patterns():
    secret = "my-custom-provider-secret-98765"
    with bind_secrets([secret]):
        assert secret not in scrub(f"error talking to host with {secret} inside")
        assert contains_secret(f"x {secret} y") and not contains_secret("nothing here")
    assert contains_secret("x") is False
    for raw in (CANARY_KEY, "sk-proj-abcdefghijklmnopqrstuv", "sk-or-v1-0123456789abcdef", "gsk_abcdefghijklmnop", "Bearer abcdefghijklmnop12345",
                'api_key="hunter2hunter2"', "Authorization: Basic dXNlcjpwYXNz"):
        out = scrub(f"prefix {raw} suffix")
        assert raw.split()[-1] not in out or raw.startswith("Authorization"), raw
    assert scrub("normal text with sk-short and nothing secret") == "normal text with sk-short and nothing secret"


def test_scrub_obj_redacts_secret_keys_recursively():
    obj = {"api_key": "abc", "nested": [{"Authorization": "Bearer zzzzzzzzzzzz", "ok": f"has {CANARY_KEY}"}], "n": 5}
    out = scrub_obj(obj)
    assert out["api_key"] == REDACTED and out["nested"][0]["Authorization"] == REDACTED
    assert CANARY_KEY not in json.dumps(out) and out["n"] == 5


def test_logs_never_contain_secrets_or_bodies():
    buf = io.StringIO()
    configure_logging("DEBUG")
    root = logging.getLogger()
    handler = [h for h in root.handlers if getattr(h, "_rag_handler", False)][0]
    handler.stream = buf
    log = logging.getLogger("rag.test")
    with bind_secrets(["bound-secret-value-123"]):
        log.info("calling with %s and bound-secret-value-123", CANARY_KEY, extra={"event": "x", "note": f"k={CANARY_KEY}", "api_key": "plain"})
        try:
            raise RuntimeError(f"upstream said {CANARY_KEY}")
        except RuntimeError:
            log.exception("failed")
    out = buf.getvalue()
    assert CANARY_KEY not in out and "bound-secret-value-123" not in out and '"plain"' not in out
    lines = [json.loads(x) for x in out.strip().split("\n")]
    assert lines[0]["level"] == "INFO" and lines[0]["event"] == "x" and "ts" in lines[0]
    assert lines[1]["exc_type"] == "RuntimeError" and "upstream said" not in out  # exception text is never logged
    # leave the handler on stderr for other tests
    handler.stream = __import__("sys").stderr


def test_app_errors_have_safe_messages_and_contract_http_codes():
    expected = {"VALIDATION": 422, "SERVICE_UNAUTHORIZED": 401, "PROVIDER_AUTH_INVALID": 502, "PROVIDER_RATE_LIMITED": 429, "PROVIDER_TIMEOUT": 504,
                "PROVIDER_UNAVAILABLE": 502, "MODEL_NOT_FOUND": 502, "CONTEXT_TOO_LONG": 502, "CAPABILITY_UNSUPPORTED": 422, "CONTENT_FILTERED": 502,
                "QUOTA_EXCEEDED": 502, "PROVIDER_ERROR": 502, "EMBEDDING_DIMENSION_MISMATCH": 422, "INTERNAL": 500, "BUSY": 429}
    for code, status in expected.items():
        assert HTTP_STATUS[ErrorCode(code)] == status
    for code in ErrorCode:
        msg = SAFE_MESSAGES[code]
        assert "sk-" not in msg and "http" not in msg.lower()
    e = AppError(ErrorCode.PROVIDER_RATE_LIMITED, retry_after_seconds=12)
    assert e.to_dict() == {"code": "PROVIDER_RATE_LIMITED", "message": e.message, "retryable": True, "retry_after_seconds": 12}
    assert str(e) == "PROVIDER_RATE_LIMITED"


# ------------------------------------------------------------------------------------------------ LangSmith config logic
def _ls(**kw):
    return make_settings(**kw)


def test_tracing_off_by_default_and_forced_off():
    env = {"LANGSMITH_TRACING": "true", "LANGCHAIN_TRACING_V2": "true"}  # hostile ambient env
    vals = tracing.apply_tracing_env(_ls(), env)
    assert env["LANGSMITH_TRACING"] == "false" and env["LANGCHAIN_TRACING_V2"] == "false" and vals == tracing.tracing_env(_ls())
    assert tracing.build_callbacks(_ls()) == []
    assert not tracing.tracing_enabled(_ls(langsmith_tracing=True))  # flag without a key is still off
    assert tracing.build_callbacks(_ls(langsmith_tracing=True)) == []


def test_tracing_on_hides_content_unless_opted_in():
    s = _ls(langsmith_tracing=True, langsmith_api_key="lsv2_pt_dummy_key_for_tests", langsmith_project="proj")
    env = tracing.tracing_env(s)
    assert env["LANGSMITH_HIDE_INPUTS"] == "true" and env["LANGSMITH_HIDE_OUTPUTS"] == "true" and env["LANGSMITH_PROJECT"] == "proj"
    assert "LANGSMITH_API_KEY" not in env  # the key is never placed in the environment by us
    s2 = _ls(langsmith_tracing=True, langsmith_api_key="lsv2_pt_dummy_key_for_tests", langsmith_include_content=True)
    env2 = tracing.tracing_env(s2)
    assert env2["LANGSMITH_HIDE_INPUTS"] == "false" and env2["LANGSMITH_HIDE_OUTPUTS"] == "false"


def test_tracer_client_hooks_hide_or_scrub():
    s = _ls(langsmith_tracing=True, langsmith_api_key="lsv2_pt_dummy_key_for_tests")
    hin, hout = tracing.make_hooks(s)
    assert hin({"messages": ["secret doc text"], "api_key": CANARY_KEY}) == {} and hout({"x": 1}) == {}
    s2 = _ls(langsmith_tracing=True, langsmith_api_key="lsv2_pt_dummy_key_for_tests", langsmith_include_content=True)
    hin2, _ = tracing.make_hooks(s2)
    out = hin2({"text": f"key {CANARY_KEY}", "api_key": "abc", "authorization": "Bearer abcdefghijkl"})
    assert CANARY_KEY not in json.dumps(out) and out["api_key"] == REDACTED


def test_build_callbacks_wires_hooks_without_touching_the_network(monkeypatch):
    """The real langsmith.Client would call api.smith.langchain.com: replace it. Live LangSmith is NOT tested."""
    import langchain_core.tracers.langchain as lct
    import langsmith

    made = {}

    class FakeClient:
        def __init__(self, **kw):
            made.update(kw)

    class FakeTracer:
        def __init__(self, client, project_name):
            self.client, self.project_name = client, project_name

    monkeypatch.setattr(langsmith, "Client", FakeClient)
    monkeypatch.setattr(lct, "LangChainTracer", FakeTracer)
    s = _ls(langsmith_tracing=True, langsmith_api_key="lsv2_pt_dummy_key_for_tests", langsmith_project="p")
    (tracer,) = tracing.build_callbacks(s)
    assert tracer.project_name == "p" and made["hide_inputs"]({"a": 1}) == {} and made["api_key"] == "lsv2_pt_dummy_key_for_tests"


# ------------------------------------------------------------------------------------------------ mock provider contract
def mreq(text, key=VALID_KEY, system=None):
    msgs = ([ChatMessage(role="system", content=system)] if system else []) + [ChatMessage(role="user", content=text)]
    return ChatRequest("mock-chat", SecretStr(key), msgs, ChatParams())


async def test_mock_embeddings_are_deterministic_normalised_and_lexical():
    m = MockProvider()
    r = await m.embed(EmbedRequest("mock-embed", SecretStr(VALID_KEY), ["Hello, World!", "hello world", "completely different words", ""]))
    v = r.vectors
    assert all(len(x) == 1536 for x in v)
    assert v[0] == v[1]  # case/punctuation-insensitive, identical text => identical vector
    assert sum(x * x for x in v[2]) == pytest.approx(1.0) and sum(x * x for x in v[3]) == pytest.approx(1.0)
    cos = lambda a, b: sum(x * y for x, y in zip(a, b))
    assert cos(hash_embed("mitochondria produce ATP"), hash_embed("ATP production in mitochondria cells")) > cos(hash_embed("mitochondria produce ATP"), hash_embed("ribosomes translate proteins"))
    assert tokenize("হ্যালো বিশ্ব, দুনিয়া!") == ["হ্যালো", "বিশ্ব", "দুনিয়া"]
    with pytest.raises(Exception):
        await m.embed(EmbedRequest("mock-embed", SecretStr("bad"), ["x"]))


async def test_mock_structured_grounded_json():
    from app.citations import GroundedAnswer

    block = "<<<SOURCES:abc123>>>\n[1] (doc.pdf, page 2)\n" + "First source text. " * 20 + "\n\n[2] (doc.pdf)\nSecond.\n<<<END:abc123>>>\n\nQuestion: q"
    m = MockProvider()
    r = await m.generate_structured(mreq(block), GroundedAnswer)
    first = ("First source text. " * 20).strip()[:120]
    assert r.parsed.answer == f"{first} [1]" and r.parsed.supported and r.parsed.citations[0].source == 1 and r.parsed.citations[0].quote == first
    r = await m.generate_structured(mreq(block + " [[bad-citation]]"), GroundedAnswer)
    assert r.parsed.citations[0].source == 99
    r = await m.generate_structured(mreq(block + " [[unsupported]]"), GroundedAnswer)
    assert r.parsed.supported is False and r.parsed.answer == "" and r.parsed.citations == []
    assert parse_sources(block)[2] == "Second."


async def test_mock_markers_chat():
    from app.errors import ProviderError

    m = MockProvider()
    with pytest.raises(ProviderError) as ei:
        await m.generate(mreq("x [[rate-limit]]"))
    assert ei.value.code == ErrorCode.PROVIDER_RATE_LIMITED and ei.value.retry_after_seconds == 3
    with pytest.raises(ProviderError) as ei:
        [c async for c in m.stream(mreq("[[fail]]"))]
    assert ei.value.code == ErrorCode.PROVIDER_UNAVAILABLE
    r = await m.generate(mreq("hello"))
    assert r.text == "Mock reply: hello" and r.usage.total_tokens == r.usage.prompt_tokens + r.usage.completion_tokens
    from app.prompts import CANARY

    leak = await m.generate(mreq("[[leak]]"))
    assert VALID_KEY in leak.text and CANARY in leak.text
    chunks = [c async for c in m.stream(mreq("one two three"))]
    assert "".join(c.delta for c in chunks) == "Mock reply: one two three" and chunks[-1].done and chunks[-1].usage.total_tokens


async def test_with_disconnect_cancels_source_and_propagates_errors():
    import asyncio

    from app.streaming import with_disconnect

    class Req:
        def __init__(self):
            self.ev = asyncio.Event()

        async def receive(self):
            await self.ev.wait()
            return {"type": "http.disconnect"}

    state = {"cancelled": False}

    async def src():
        try:
            yield 1
            await asyncio.sleep(30)
            yield 2
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise

    r = Req()
    got = []
    async for x in with_disconnect(r, src()):
        got.append(x)
        r.ev.set()
    await asyncio.sleep(0.05)
    assert got == [1] and state["cancelled"]

    async def boom():
        yield 1
        raise RuntimeError("x")

    with pytest.raises(RuntimeError):
        async for _ in with_disconnect(Req(), boom()):
            pass
