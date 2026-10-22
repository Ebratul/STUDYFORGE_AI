"""Service authentication (bearer token, constant-time compare)."""

from __future__ import annotations

import hashlib
import hmac

from fastapi import Request

from app.errors import AppError, ErrorCode


def token_matches(presented: str | None, expected: str) -> bool:
    if not presented:
        return False
    # hash both sides so compare_digest always runs on equal-length inputs
    a = hashlib.sha256(presented.encode()).digest()
    b = hashlib.sha256(expected.encode()).digest()
    return hmac.compare_digest(a, b)


def extract_bearer(header: str | None) -> str | None:
    if not header:
        return None
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip()


async def require_service_token(request: Request) -> None:
    settings = request.app.state.settings
    presented = extract_bearer(request.headers.get("authorization"))
    if not token_matches(presented, settings.rag_agent_token.get_secret_value()):
        raise AppError(ErrorCode.SERVICE_UNAUTHORIZED, "Unauthorized.")
