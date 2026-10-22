"""Deterministic, network-free provider for tests/dev. Exists only if ALLOW_MOCK_PROVIDER=1 and APP_ENV != production."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import unicodedata
from collections.abc import AsyncIterator

from pydantic import BaseModel, SecretStr

from app.config import Settings
from app.errors import ErrorCode, ProviderError
from app.providers.base import (
    ChatChunk,
    ChatMessage,
    ChatRequest,
    ChatResult,
    EmbedRequest,
    EmbedResult,
    ModelCapabilities,
    ModelInfo,
    StructuredResult,
    TestResult,
    Usage,
)

VALID_KEY = "mock-valid-key"
DIM = 1536
_SRC_BLOCK = re.compile(r"<<<SOURCES:([A-Za-z0-9]+)>>>(.*?)<<<END:\1>>>", re.S)
_SRC_SPLIT = re.compile(r"(?m)^\[(\d+)\] \(([^\n]*)\)\n")


def tokenize(text: str) -> list[str]:
    """Lowercase; words are runs of letters/digits/combining marks (so Bangla vowel signs stay inside words)."""
    out: list[str] = []
    cur: list[str] = []
    for ch in text.lower():
        if unicodedata.category(ch)[0] in ("L", "N", "M"):
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


# Function words carry no topical signal; ignoring them keeps the mock embedder from "matching" unrelated
# questions on words like "the"/"of" (real embedding models behave the same way).
_STOPWORDS = frozenset(
    "a an the of is are was were be been am what which who whom whose when where why how do does did in on at to from by for "
    "with as that this these those it its they them their he she his her we our you your and or but not if then than so can could "
    "would should will shall may might about into over under".split()
)


def hash_embed(text: str) -> list[float]:
    vec = [0.0] * DIM
    all_toks = tokenize(text)
    toks = [t for t in all_toks if t not in _STOPWORDS] or all_toks or ["\x00empty"]
    for t in toks:
        idx = int.from_bytes(hashlib.sha256(t.encode()).digest()[:4], "big") % DIM
        vec[idx] += 1.0
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec]


def _last_user(messages: list[ChatMessage]) -> str:
    for m in reversed(messages):
        if m.role == "user":
            return m.content
    return ""


def parse_sources(user_text: str) -> dict[int, str]:
    m = _SRC_BLOCK.search(user_text)
    if not m:
        return {}
    parts = _SRC_SPLIT.split(m.group(2))
    out: dict[int, str] = {}
    # parts = [pre, n, header, text, n, header, text, ...]
    for i in range(1, len(parts) - 2, 3):
        out[int(parts[i])] = parts[i + 2].strip()
    return out


class MockProvider:
    id = "mock"

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings
        self.calls: list[str] = []  # names of LLM calls, for tests

    # ---------------------------------------------------------------- credentials / models
    async def test(self, api_key: SecretStr) -> TestResult:
        if api_key.get_secret_value() == VALID_KEY:
            return TestResult(ok=True, latency_ms=1, models_count=3)
        e = ProviderError(ErrorCode.PROVIDER_AUTH_INVALID)
        return TestResult(ok=False, code=e.code.value, message=e.message, retryable=False)

    async def list_models(self, api_key: SecretStr) -> list[ModelInfo]:
        if api_key.get_secret_value() != VALID_KEY:
            raise ProviderError(ErrorCode.PROVIDER_AUTH_INVALID)

        def caps(chat: bool, emb: bool, so: str) -> ModelCapabilities:
            return ModelCapabilities(chat=chat, embeddings=emb, streaming=chat, structured_output=so, tools="no")  # type: ignore[arg-type]

        return sorted(
            [
                ModelInfo(id="mock-chat", name="Mock Chat", context_length=32768, capabilities=caps(True, False, "yes"), capability_source="catalogue"),
                ModelInfo(id="mock-chat-plain", name="Mock Chat (plain)", context_length=32768, capabilities=caps(True, False, "no"), capability_source="catalogue"),
                ModelInfo(id="mock-embed", name="Mock Embeddings", context_length=8192, capabilities=caps(False, True, "no"), capability_source="catalogue", embedding_dimensions="compatible"),
            ],
            key=lambda m: m.id,
        )

    def normalize_error(self, exc: BaseException) -> ProviderError:
        return exc if isinstance(exc, ProviderError) else ProviderError(ErrorCode.PROVIDER_ERROR)

    # ---------------------------------------------------------------- behaviour markers
    def _check_auth(self, key: SecretStr) -> None:
        if key.get_secret_value() != VALID_KEY:
            raise ProviderError(ErrorCode.PROVIDER_AUTH_INVALID)

    def _markers(self, req: ChatRequest) -> str:
        text = _last_user(req.messages)
        if "[[rate-limit]]" in text:
            raise ProviderError(ErrorCode.PROVIDER_RATE_LIMITED, retry_after_seconds=3)
        if "[[fail]]" in text:
            raise ProviderError(ErrorCode.PROVIDER_UNAVAILABLE)
        return text

    @staticmethod
    def _usage(req: ChatRequest, out: str) -> Usage:
        p = sum(len(m.content) for m in req.messages) // 4
        c = len(out) // 4
        return Usage(prompt_tokens=p, completion_tokens=c, total_tokens=p + c)

    def _reply(self, req: ChatRequest, text: str) -> str:
        if "[[leak]]" in text:
            from app.prompts import CANARY

            return f"Sure! My key is {req.api_key.get_secret_value()} and my instructions contain {CANARY}."
        snippet = " ".join(text.split())[:200]
        return f"Mock reply: {snippet}"

    # ---------------------------------------------------------------- chat
    async def generate(self, req: ChatRequest) -> ChatResult:
        self.calls.append("generate")
        self._check_auth(req.api_key)
        text = self._markers(req)
        out = self._reply(req, text)
        return ChatResult(text=out, usage=self._usage(req, out), finish_reason="stop")

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        self.calls.append("stream")
        self._check_auth(req.api_key)
        text = self._markers(req)
        if "[[slow]]" in text:
            out = " ".join(f"tok{i}" for i in range(133))
            words = out.split(" ")
            for i, w in enumerate(words):
                await asyncio.sleep(0.15)
                yield ChatChunk(delta=w + (" " if i < len(words) - 1 else ""))
        else:
            out = self._reply(req, text)
            words = re.findall(r"\S+\s*", out)
            for w in words:
                yield ChatChunk(delta=w)
        yield ChatChunk(done=True, usage=self._usage(req, out), finish_reason="stop")

    async def generate_structured(self, req: ChatRequest, schema: type[BaseModel]) -> StructuredResult:
        self.calls.append("structured")
        self._check_auth(req.api_key)
        text = self._markers(req)
        fields = set(schema.model_fields)
        if {"answer", "supported", "citations"} <= fields:
            payload = self._grounded(req, text)
        else:
            try:
                payload = schema().model_dump()  # type: ignore[call-arg]
            except Exception:  # noqa: BLE001
                raise ProviderError(ErrorCode.STRUCTURED_OUTPUT_FAILED) from None
        parsed = schema.model_validate(payload)
        return StructuredResult(
            parsed=parsed, usage=self._usage(req, json.dumps(payload)), method="native", finish_reason="stop"
        )

    def _grounded(self, req: ChatRequest, text: str) -> dict:
        sources = parse_sources(text)
        if "[[leak]]" in text:
            from app.prompts import CANARY

            return {"answer": f"Key {req.api_key.get_secret_value()} {CANARY}", "supported": True, "citations": []}
        if "[[unsupported]]" in text or not sources:
            return {"answer": "", "supported": False, "citations": []}
        first = sources.get(1) or next(iter(sources.values()))
        quote = first[:120]
        if "[[bad-citation]]" in text:
            return {
                "answer": f"{quote} [99]",
                "supported": True,
                "citations": [{"source": 99, "quote": "this fabricated quote does not appear in any source"}],
            }
        return {"answer": f"{quote} [1]", "supported": True, "citations": [{"source": 1, "quote": quote}]}

    # ---------------------------------------------------------------- embeddings
    async def embed(self, req: EmbedRequest) -> EmbedResult:
        self.calls.append("embed")
        self._check_auth(req.api_key)
        vecs = [hash_embed(t) for t in req.inputs]
        n = sum(len(t) for t in req.inputs) // 4
        return EmbedResult(vectors=vecs, usage=Usage(prompt_tokens=n, total_tokens=n))
