"""Central redaction. Every log line, exception message and trace payload passes through `scrub`.

Two layers: (1) exact-value redaction of the secrets bound to the current request (contextvar),
(2) pattern redaction of anything that *looks* like an API key / bearer token.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Iterable, Iterator
from contextvars import ContextVar
from typing import Any

REDACTED = "[REDACTED]"

_secrets: ContextVar[frozenset[str]] = ContextVar("rag_secrets", default=frozenset())

_PATTERNS = [
    re.compile(r"sk-or-v1-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"sk-(?:proj-)?[A-Za-z0-9_\-]{12,}"),
    re.compile(r"gsk_[A-Za-z0-9]{8,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-~+/=]{8,}"),
    re.compile(r"(?i)(api[_-]?key|authorization|x-api-key)(['\"]?\s*[:=]\s*['\"]?)[^\s'\",}]{6,}"),
]

MIN_SECRET_LEN = 6  # shorter values would shred ordinary text when exact-matched


def bound_secrets() -> frozenset[str]:
    return _secrets.get()


@contextlib.contextmanager
def bind_secrets(values: Iterable[str]) -> Iterator[None]:
    """Register request-scoped secrets (API keys) for exact-match redaction and the leak filter."""
    current = _secrets.get()
    new = frozenset(current | {v for v in values if v and len(v) >= MIN_SECRET_LEN})
    token = _secrets.set(new)
    try:
        yield
    finally:
        try:
            _secrets.reset(token)
        except ValueError:  # generator finalised in another context (e.g. cancelled stream): nothing to restore
            pass


def scrub(text: str, extra: Iterable[str] = ()) -> str:
    if not text:
        return text
    out = text
    for s in sorted(_secrets.get() | {e for e in extra if e and len(e) >= MIN_SECRET_LEN}, key=len, reverse=True):
        if s in out:
            out = out.replace(s, REDACTED)
    for pat in _PATTERNS:
        if pat.groups >= 2:
            out = pat.sub(lambda m: f"{m.group(1)}{m.group(2)}{REDACTED}", out)
        else:
            out = pat.sub(REDACTED, out)
    return out


def scrub_obj(obj: Any, extra: Iterable[str] = ()) -> Any:
    """Recursively scrub strings in dict/list/tuple structures (used for trace payloads and log fields)."""
    if isinstance(obj, str):
        return scrub(obj, extra)
    if isinstance(obj, dict):
        return {k: (REDACTED if _is_secret_key(k) else scrub_obj(v, extra)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub_obj(v, extra) for v in obj]
    if isinstance(obj, tuple):
        return tuple(scrub_obj(v, extra) for v in obj)
    return obj


def _is_secret_key(k: Any) -> bool:
    return isinstance(k, str) and k.lower() in {"api_key", "apikey", "authorization", "x-api-key", "openai_api_key", "password"}


def contains_secret(text: str, extra: Iterable[str] = ()) -> bool:
    """True if `text` contains any bound secret or extra literal (used by the output leak filter)."""
    if not text:
        return False
    for s in _secrets.get() | {e for e in extra if e}:
        if len(s) >= MIN_SECRET_LEN and s in text:
            return True
    return False
