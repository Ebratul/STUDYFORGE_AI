"""Strict checks on embedding output, shared by every provider adapter (real and mock)."""

from __future__ import annotations

import math
from typing import Any

from app.errors import ErrorCode, ProviderError


def check_vectors(vectors: list[Any], expected: int | None) -> None:
    """Every vector must be a non-empty list of finite numbers; all of length `expected` (or, if none is given, all of one length).
    Nothing is ever padded or truncated: a wrong length is an error, not something to repair."""
    bad = ProviderError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected embedding response.", retryable=False)
    length = expected
    for v in vectors:
        if not isinstance(v, list) or not v:
            raise bad
        for x in v:
            if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
                raise bad
        if length is None:
            length = len(v)
        elif len(v) != length:
            raise ProviderError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
