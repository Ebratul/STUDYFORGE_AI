"""Connection validation (AI_CONNECTION_SPEC §1): three sequential, minimal, safe checks — auth, chat, embedding.

Nothing here is persisted. Messages are the fixed safe strings of `app.errors`; upstream bodies and keys never appear.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.config import MAX_EMBEDDING_DIMENSION, MIN_EMBEDDING_DIMENSION, Settings
from app.errors import ErrorCode, ProviderError
from app.logging import log_event
from app.providers.base import ChatMessage, ChatParams, ChatRequest, EmbedRequest, Provider
from app.schemas import Params

log = logging.getLogger("rag.validate")

CHECK_TIMEOUT_SECONDS = 20.0
CHAT_PROMPT = "Reply with OK."
CHAT_MAX_OUTPUT_TOKENS = 8
EMBEDDING_SAMPLE = "StudyForge connection test"


class StrictParams(Params):
    model_config = ConfigDict(extra="forbid")


class ValidateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(min_length=1, max_length=32)
    api_key: SecretStr = Field(min_length=1, max_length=4096)
    chat_model: str = Field(min_length=1, max_length=200)
    embedding_model: str = Field(min_length=1, max_length=200)
    # The vector length the user wants. None = the model's native size. Whether the model can produce it is verified with a live request.
    embedding_dimension: int | None = Field(default=None, ge=MIN_EMBEDDING_DIMENSION, le=MAX_EMBEDDING_DIMENSION)
    # The generation parameters the user wants to save. Only the ones that are set are tested (and later sent).
    chat_params: StrictParams | None = None

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
    # embedding only: the model's measured native size, and the `dimensions` request parameter needed to get `dimension` (None = not sent)
    native_dimension: int | None = None
    request_dimensions: int | None = None
    # chat_params only: parameters verified / rejected (fixed vocabulary), and sanitised facts about a failing upstream call
    verified: list[str] | None = None
    unsupported: list[str] | None = None
    diagnostics: dict[str, Any] | None = None


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
    return CheckResult(ok=False, code=err.code.value, message=err.message, latency_ms=_ms(started), diagnostics=err.diagnostics, **extra)


# our parameter names -> the names providers publish in `supported_parameters`
WIRE_NAMES = {
    "temperature": "temperature",
    "top_p": "top_p",
    "max_output_tokens": "max_tokens",
    "frequency_penalty": "frequency_penalty",
    "presence_penalty": "presence_penalty",
    "seed": "seed",
}


def _requested(params: Params | None) -> dict[str, float | int]:
    return {k: v for k, v in (params.model_dump() if params else {}).items() if v is not None}


async def _check_chat_params(provider: Provider, body: ValidateBody, chat_ok: bool | None) -> CheckResult:
    """Do the chosen model and provider honour the parameters the user set? Metadata first (free), then ONE tiny live call that
    asks the router to refuse silently-dropped parameters. A model id that merely answers does not prove parameter support."""
    requested = _requested(body.chat_params)
    if not chat_ok:
        return _skipped()
    if not requested:
        return CheckResult(ok=None, skipped=True, message="No custom parameters are set, so the provider's defaults are used.")
    started = time.perf_counter()
    listed = await provider.supported_parameters(body.chat_model) if hasattr(provider, "supported_parameters") else None
    if listed is not None:
        missing = sorted(k for k in requested if WIRE_NAMES[k] not in listed)
        if missing:
            names = ", ".join(WIRE_NAMES[k] for k in missing)
            return CheckResult(
                ok=False,
                code=ErrorCode.PARAMETER_UNSUPPORTED.value,
                message=f"The provider's model listing does not include support for: {names}. Clear those settings or choose another model.",
                latency_ms=_ms(started),
                unsupported=[WIRE_NAMES[k] for k in missing],
                diagnostics={"source": "provider_metadata"},
            )
    try:
        await _guarded(
            provider,
            started,
            provider.generate(
                ChatRequest(
                    body.chat_model, body.api_key, [ChatMessage(role="user", content=CHAT_PROMPT)],
                    ChatParams(**{**requested, "max_output_tokens": CHAT_MAX_OUTPUT_TOKENS}, require_parameters=True),
                )
            ),
        )
    except ProviderError as err:
        if err.code == ErrorCode.MODEL_NOT_FOUND:
            # the model itself answered in the previous check, so "no endpoint" here means no endpoint supports these parameters
            err = ProviderError(
                ErrorCode.PARAMETER_UNSUPPORTED,
                "No provider for this model accepted the requested parameters. Clear the optional ones and try again.",
                diagnostics=err.diagnostics,
            )
        return _failed(err, started, unsupported=sorted(WIRE_NAMES[k] for k in requested))
    return CheckResult(ok=True, latency_ms=_ms(started), verified=sorted(WIRE_NAMES[k] for k in requested), diagnostics={"source": "live_call" if listed is None else "metadata_and_live_call"})


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


# A failing shortened probe is "this size is not supported" unless the failure says something else about the account or the service.
_PASS_THROUGH = {ErrorCode.PROVIDER_AUTH_INVALID, ErrorCode.PROVIDER_RATE_LIMITED, ErrorCode.QUOTA_EXCEEDED, ErrorCode.PROVIDER_TIMEOUT, ErrorCode.PROVIDER_UNAVAILABLE}


async def _check_embedding(provider: Provider, body: ValidateBody) -> tuple[CheckResult, int | None]:
    """Native probe, then (only when a different size was asked for) one probe with `dimensions=N`. Returns (check, verified dimension).

    The returned length must be exactly what was asked for: nothing is padded, truncated or trusted from a model list.
    """
    key = body.api_key
    requested = body.embedding_dimension
    started = time.perf_counter()
    try:
        native = await _guarded(provider, started, provider.probe_embedding(EmbedRequest(model=body.embedding_model, api_key=key, inputs=[EMBEDDING_SAMPLE])))
    except ProviderError as err:
        return _failed(err, started), None
    if requested is None or requested == native:
        return CheckResult(ok=True, latency_ms=_ms(started), dimension=native, native_dimension=native), native

    try:
        got = await _guarded(provider, started, provider.probe_embedding(EmbedRequest(model=body.embedding_model, api_key=key, inputs=[EMBEDDING_SAMPLE], dimensions=requested)))
    except ProviderError as err:
        if err.code not in _PASS_THROUGH:
            err = ProviderError(
                ErrorCode.EMBEDDING_DIMENSION_UNSUPPORTED,
                f"The provider rejected a size of {requested} dimensions for this model. Its native size is {native}; use that or a size the model supports.",
                retryable=False,
                diagnostics=err.diagnostics,
            )
        return _failed(err, started, native_dimension=native), None
    if got != requested:
        return CheckResult(
            ok=False,
            code=ErrorCode.EMBEDDING_DIMENSION_MISMATCH.value,
            message=f"This model returned {got}-dimensional vectors when asked for {requested}, so it does not support that size. Its native size is {native}; use that or a size the model supports.",
            latency_ms=_ms(started),
            dimension=got,
            native_dimension=native,
        ), None
    return CheckResult(ok=True, latency_ms=_ms(started), dimension=got, native_dimension=native, request_dimensions=requested), got


async def validate_connection(provider: Provider, body: ValidateBody, settings: Settings, request_id: str | None = None) -> ValidateResult:
    key = body.api_key

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
        return ValidateResult(ok=False, provider=provider.id, embedding_dimension=None, checks={"auth": auth, "chat": _skipped(), "chat_params": _skipped(), "embedding": _skipped()})

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

    # 2b. chat parameters ------------------------------------------------------------------------------------
    chat_params = await _check_chat_params(provider, body, chat.ok)

    # 3. embedding ---------------------------------------------------------------------------------------------
    embedding, dimension = await _check_embedding(provider, body)

    ok = bool(chat.ok and embedding.ok and chat_params.ok is not False)
    checks = {"auth": auth, "chat": chat, "chat_params": chat_params, "embedding": embedding}
    # Safe per-check diagnostics for the server log: names, codes, HTTP status and endpoint. No bodies, no keys, no model output.
    for name, c in checks.items():
        if c.ok is False:
            log_event(log, "validate_check_failed", logging.WARNING, request_id=request_id, provider=provider.id, check=name, code=c.code, model=(body.embedding_model if name == "embedding" else body.chat_model), **(c.diagnostics or {}))
    log_event(log, "validate_done", request_id=request_id, provider=provider.id, auth=True, chat=chat.ok, chat_params=chat_params.ok, embedding=embedding.ok, dimension=dimension, requested=body.embedding_dimension)
    return ValidateResult(ok=ok, provider=provider.id, embedding_dimension=dimension, checks=checks)
