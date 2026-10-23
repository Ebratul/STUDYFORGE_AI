"""Normalisation of every upstream failure into the service error codes (CONTRACT §0/§1.4).

Messages are FIXED safe strings: upstream bodies/headers/URLs are inspected only to classify, never copied.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from collections.abc import Mapping
from typing import Any

import httpx
import openai
from pydantic import ValidationError

from app.errors import AppError, ErrorCode, ProviderError
from app.redact import scrub

_CONTEXT_RE = re.compile(
    r"(context[_ ]length|maximum context|context window|too many tokens|reduce the length|token limit|prompt is too long|"
    r"input is too long|exceeds? the (?:max|limit)|maximum number of tokens)",
    re.I,
)
_FILTER_RE = re.compile(r"(content[_ ]filter|content[_ ]policy|content management|moderation|flagged|guardrail|safety system)", re.I)
_MODEL_RE = re.compile(r"(model[_ ]not[_ ]found|not a valid model|invalid model|model .{0,80}(does not exist|not found|decommissioned|no longer supported)|no endpoints found)", re.I)
_AUTH_RE = re.compile(r"(api[_ ]key not valid|api_key_invalid|invalid api key|incorrect api key)", re.I)  # Gemini answers a bad key with HTTP 400
_QUOTA_RE = re.compile(r"(insufficient[_ ]quota|exceeded your current quota|billing|credits|payment required|out of budget|spend limit)", re.I)


_ENDPOINTS = {"chat": "POST /chat/completions", "embed": "POST /embeddings", "models": "GET /models or /key"}
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
_SAFE_NAME = re.compile(r"^[A-Za-z0-9 ._\-]{1,40}$")


def _token(value: Any, rx: re.Pattern[str] = _SAFE_TOKEN) -> str | None:
    """A short identifier (e.g. an upstream error code) or None. Free text is never accepted, and secrets are scrubbed regardless."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value)
    return scrub(text) if rx.match(text) and scrub(text) == text else None


def build_diagnostics(status: int | None, body: Any = None, where: str = "chat", **extra: Any) -> dict[str, Any]:
    """What a developer needs to find the failing call, and nothing else: endpoint, HTTP status and short allow-listed upstream tokens.
    Upstream messages/bodies, headers, URLs and keys are never copied."""
    d: dict[str, Any] = {"endpoint": _ENDPOINTS.get(where), "http_status": status}
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        d["upstream_code"] = _token(err.get("code"))
        d["upstream_type"] = _token(err.get("type"))
        meta = err.get("metadata")
        if isinstance(meta, dict):
            d["upstream_provider"] = _token(meta.get("provider_name"), _SAFE_NAME)
    d.update(extra)
    return {k: v for k, v in d.items() if v is not None}


def _body_parts(body: Any) -> tuple[str, str]:
    """-> (code/type tokens, lowercase message) used ONLY for classification."""
    code = ""
    msg = ""
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        code = " ".join(str(err.get(k) or "") for k in ("code", "type", "param"))
        msg = str(err.get("message") or "")
        meta = err.get("metadata")
        if isinstance(meta, dict) and ("reasons" in meta or "flagged_input" in meta):
            code += " moderation"
    elif isinstance(err, str):
        msg = err
    elif isinstance(body, dict) and isinstance(body.get("message"), str):
        msg = body["message"]
    return code, msg


def parse_retry_after(headers: Mapping[str, str] | None) -> int | None:
    if not headers:
        return None
    raw = None
    for k, v in headers.items():
        if k.lower() == "retry-after":
            raw = v
            break
    if raw is None:
        return None
    try:
        secs = float(str(raw).strip())
    except ValueError:
        return None  # HTTP-date form is ignored (never invent a wait)
    if not math.isfinite(secs) or secs < 0:
        return None
    return int(math.ceil(secs))


def classify_http(status: int, body: Any = None, headers: Mapping[str, str] | None = None, *, where: str = "chat") -> ProviderError:
    """`where` is "chat"/"embed" (a 404 means the model is unknown) or "models" (a 404 is just an error)."""
    if isinstance(body, list) and len(body) == 1:
        body = body[0]  # Google sometimes wraps its error object in a one-element JSON list
    code_tokens, msg = _body_parts(body)
    probe = f"{code_tokens} {msg}"
    retry_after = parse_retry_after(headers)

    diag = build_diagnostics(status, body, where)

    def err(code: ErrorCode, *, retryable: bool | None = None, ra: int | None = None) -> ProviderError:
        return ProviderError(code, retryable=retryable, retry_after_seconds=ra, diagnostics=diag)

    if status == 401:
        return err(ErrorCode.PROVIDER_AUTH_INVALID)
    if status == 402:
        return err(ErrorCode.QUOTA_EXCEEDED)
    if status == 403:
        if _FILTER_RE.search(probe):
            return err(ErrorCode.CONTENT_FILTERED)
        return err(ErrorCode.PROVIDER_AUTH_INVALID)
    if status == 404:
        return err(ErrorCode.MODEL_NOT_FOUND) if where in ("chat", "embed") else err(ErrorCode.PROVIDER_ERROR)
    if status == 408:
        return err(ErrorCode.PROVIDER_TIMEOUT)
    if status == 429 or (status == 413 and re.search(r"rate_limit|tokens per minute", probe, re.I)):
        if _QUOTA_RE.search(probe):
            return err(ErrorCode.QUOTA_EXCEEDED)
        return err(ErrorCode.PROVIDER_RATE_LIMITED, ra=retry_after)
    if status in (400, 413, 422):
        if status == 400 and _AUTH_RE.search(probe):
            return err(ErrorCode.PROVIDER_AUTH_INVALID)
        if _CONTEXT_RE.search(probe) or status == 413:
            return err(ErrorCode.CONTEXT_TOO_LONG)
        if _FILTER_RE.search(probe):
            return err(ErrorCode.CONTENT_FILTERED)
        if _MODEL_RE.search(probe):
            return err(ErrorCode.MODEL_NOT_FOUND)
        return err(ErrorCode.PROVIDER_ERROR, retryable=False)
    if status >= 500:
        return err(ErrorCode.PROVIDER_UNAVAILABLE, ra=retry_after)
    return err(ErrorCode.PROVIDER_ERROR, retryable=False)


def _openai_status_body(exc: openai.APIStatusError) -> Any:
    body = getattr(exc, "body", None)
    if body is None:
        try:
            body = exc.response.json()
        except Exception:  # noqa: BLE001
            body = None
    if isinstance(body, dict) and "error" not in body and ("message" in body or "code" in body):
        body = {"error": body}  # the SDK unwraps {"error": {...}} to the inner dict
    return body


def normalize_exception(exc: BaseException, *, where: str = "chat") -> ProviderError:
    """Map any exception raised while talking to a provider to a ProviderError with a safe message."""
    if isinstance(exc, ProviderError):
        return exc
    if isinstance(exc, AppError):
        return ProviderError(exc.code, exc.message, retryable=exc.retryable, retry_after_seconds=exc.retry_after_seconds)
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException, openai.APITimeoutError)):
        return ProviderError(ErrorCode.PROVIDER_TIMEOUT, diagnostics=build_diagnostics(None, None, where, failure="timeout"))
    if isinstance(exc, openai.APIStatusError):
        return classify_http(exc.status_code, _openai_status_body(exc), exc.response.headers, where=where)
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            body = exc.response.json()
        except Exception:  # noqa: BLE001
            body = None
        return classify_http(exc.response.status_code, body, exc.response.headers, where=where)
    if isinstance(exc, (openai.APIConnectionError, httpx.TransportError, ConnectionError, OSError)):
        return ProviderError(ErrorCode.PROVIDER_UNAVAILABLE, diagnostics=build_diagnostics(None, None, where, failure="connection"))
    if isinstance(exc, (json.JSONDecodeError, ValidationError, KeyError, IndexError, TypeError, ValueError, AttributeError)):
        return ProviderError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False, diagnostics=build_diagnostics(None, None, where, failure="unexpected_response"))
    if isinstance(exc, openai.OpenAIError):
        return ProviderError(ErrorCode.PROVIDER_ERROR, retryable=False)
    return ProviderError(ErrorCode.PROVIDER_ERROR, retryable=False)


RETRYABLE_CODES = {ErrorCode.PROVIDER_RATE_LIMITED, ErrorCode.PROVIDER_TIMEOUT, ErrorCode.PROVIDER_UNAVAILABLE}
