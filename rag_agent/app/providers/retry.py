"""Bounded retry policy: at most 2 retries, only for 429/5xx/timeouts; never auth/validation; never a different provider."""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

from app.errors import ProviderError
from app.providers.errors import RETRYABLE_CODES

T = TypeVar("T")

MAX_RETRIES = 2
BASE_DELAY = 0.5  # seconds; tests set this to 0
MAX_WAIT = 5.0  # Retry-After is honoured but capped


def compute_delay(attempt: int, retry_after: int | None) -> float:
    if retry_after is not None:
        return min(float(retry_after), MAX_WAIT)
    backoff = BASE_DELAY * (2**attempt)
    return min(backoff + random.uniform(0, BASE_DELAY), MAX_WAIT) if BASE_DELAY > 0 else 0.0


async def with_retries(
    fn: Callable[[], Awaitable[T]],
    normalize: Callable[[BaseException], ProviderError],
    *,
    max_retries: int = MAX_RETRIES,
) -> T:
    attempt = 0
    while True:
        try:
            return await fn()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            err = normalize(exc)
            if attempt >= max_retries or err.code not in RETRYABLE_CODES:
                raise err from None  # drop the upstream exception chain
            await asyncio.sleep(compute_delay(attempt, err.retry_after_seconds))
            attempt += 1
