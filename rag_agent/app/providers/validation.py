"""Connection validation (AI_CONNECTION_SPEC §1): three sequential, minimal, safe checks — auth, chat, embedding.

Nothing here is persisted. Messages are the fixed safe strings of `app.errors`; upstream bodies and keys never appear.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.config import Settings
from app.errors import ErrorCode, ProviderError
from app.logging import log_event
from app.providers.base import ChatMessage, ChatParams, ChatRequest, EmbedRequest, Provider

log = logging.getLogger("rag.validate")

CHECK_TIMEOUT_SECONDS = 20.0
CHAT_PROMPT = "Reply with OK."
CHAT_MAX_OUTPUT_TOKENS = 8
EMBEDDING_SAMPLE = "StudyForge connection test"


class ValidateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1, max_length=32)
    api_key: SecretStr = Field(min_length=1, max_length=4096)
    chat_model: str = Field(min_length=1, max_length=200)
    embedding_model: str = Field(min_length=1, max_length=200)

    @field_validator("chat_model", "embedding_model")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("model id must not be blank")
        return v


class CheckResult(BaseModel):
    ok: bool | None
    skipped: bool | None = None
    code: str | None = None
    message: str | None = None
    latency_ms: int | None = None
    dimension: int | None = None


class ValidateResult(BaseModel):
    ok: bool
    provider: str
    embedding_dimension: int | None
    checks: dict[str, CheckResult]

    def to_wire(self) -> dict[str, Any]:
        """`ok` is always present on a check (null = skipped); other keys only when set."""
        checks = {k: {"ok": c.ok, **{f: v for f, v in c.model_dump(exclude={"ok"}).items() if v is not None}} for k, c in self.checks.items()}
        return {"ok": self.ok, "provider": self.provider, "embedding_dimension": self.embedding_dimension, "checks": checks}


def _skipped() -> CheckResult:
    return CheckResult(ok=None, skipped=True)


def _failed(err: ProviderError, started: float, **extra: Any) -> CheckResult:
    return CheckResult(ok=False, code=err.code.value, message=err.message, latency_ms=_ms(started), **extra)


def _ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


async def _guarded(provider: Provider, started: float, coro: Any) -> Any:
    """Run one check under its own timeout; any failure becomes a normalised ProviderError."""
    try:
        async with asyncio.timeout(CHECK_TIMEOUT_SECONDS):
            return await coro
    except asyncio.CancelledError:
        raise
    except ProviderError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise provider.normalize_error(exc) from None


async def validate_connection(provider: Provider, body: ValidateBody, settings: Settings, request_id: str | None = None) -> ValidateResult:
    key = body.api_key
    expected = settings.embedding_dimensions

    # 1. auth ---------------------------------------------------------------------------------------------------
    started = time.perf_counter()
    try:
        res = await _guarded(provider, started, provider.test(key))
        auth = CheckResult(ok=True, latency_ms=res.latency_ms if res.ok else _ms(started)) if res.ok else CheckResult(
            ok=False, code=res.code, message=res.message, latency_ms=_ms(started)
        )
    except ProviderError as err:
        auth = _failed(err, started)
    if not auth.ok:
        log_event(log, "validate_done", request_id=request_id, provider=provider.id, auth=False)
        return ValidateResult(ok=False, provider=provider.id, embedding_dimension=None, checks={"auth": auth, "chat": _skipped(), "embedding": _skipped()})

    # 2. chat -----------------------------------------------------------------------------------------------------
    started = time.perf_counter()
    try:
        pre = getattr(provider, "precheck_model", None)
        if pre is not None:
            pre("chat", body.chat_model)
        await _guarded(
            provider,
            started,
            provider.generate(
                ChatRequest(
                    body.chat_model, key, [ChatMessage(role="user", content=CHAT_PROMPT)],
                    ChatParams(temperature=0, max_output_tokens=CHAT_MAX_OUTPUT_TOKENS),
                )
            ),
        )
        chat = CheckResult(ok=True, latency_ms=_ms(started))
    except ProviderError as err:
        chat = _failed(err, started)

    # 3. embedding ---------------------------------------------------------------------------------------------
    started = time.perf_counter()
    dimension: int | None = None
    try:
        dimension = await _guarded(provider, started, provider.probe_embedding(EmbedRequest(model=body.embedding_model, api_key=key, inputs=[EMBEDDING_SAMPLE])))
        if dimension != expected:
            embedding = CheckResult(
                ok=False,
                code=ErrorCode.EMBEDDING_DIMENSION_MISMATCH.value,
                message=f"This model produces {dimension}-dimensional vectors; StudyForge stores {expected}-dimensional vectors. Choose a model that returns {expected} (for example openai/text-embedding-3-small).",
                latency_ms=_ms(started),
                dimension=dimension,
            )
        else:
            embedding = CheckResult(ok=True, latency_ms=_ms(started), dimension=dimension)
    except ProviderError as err:
        embedding = _failed(err, started)

    ok = bool(chat.ok and embedding.ok)
    log_event(log, "validate_done", request_id=request_id, provider=provider.id, auth=True, chat=chat.ok, embedding=embedding.ok, dimension=dimension)
    return ValidateResult(ok=ok, provider=provider.id, embedding_dimension=dimension, checks={"auth": auth, "chat": chat, "embedding": embedding})
