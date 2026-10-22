"""Error codes, the wire error shape, and the single exception type used across the service."""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    VALIDATION = "VALIDATION"
    SERVICE_UNAUTHORIZED = "SERVICE_UNAUTHORIZED"
    PROVIDER_AUTH_INVALID = "PROVIDER_AUTH_INVALID"
    PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED"
    PROVIDER_TIMEOUT = "PROVIDER_TIMEOUT"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    MODEL_NOT_FOUND = "MODEL_NOT_FOUND"
    CONTEXT_TOO_LONG = "CONTEXT_TOO_LONG"
    CAPABILITY_UNSUPPORTED = "CAPABILITY_UNSUPPORTED"
    CONTENT_FILTERED = "CONTENT_FILTERED"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    PROVIDER_ERROR = "PROVIDER_ERROR"
    STRUCTURED_OUTPUT_FAILED = "STRUCTURED_OUTPUT_FAILED"
    EMBEDDING_DIMENSION_MISMATCH = "EMBEDDING_DIMENSION_MISMATCH"
    BUSY = "BUSY"
    GENERATION_FAILED = "GENERATION_FAILED"
    FILE_TOO_LARGE = "FILE_TOO_LARGE"
    INTERNAL = "INTERNAL"


HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.VALIDATION: 422,
    ErrorCode.SERVICE_UNAUTHORIZED: 401,
    ErrorCode.PROVIDER_AUTH_INVALID: 502,
    ErrorCode.PROVIDER_RATE_LIMITED: 429,
    ErrorCode.PROVIDER_TIMEOUT: 504,
    ErrorCode.PROVIDER_UNAVAILABLE: 502,
    ErrorCode.MODEL_NOT_FOUND: 502,
    ErrorCode.CONTEXT_TOO_LONG: 502,
    ErrorCode.CAPABILITY_UNSUPPORTED: 422,
    ErrorCode.CONTENT_FILTERED: 502,
    ErrorCode.QUOTA_EXCEEDED: 502,
    ErrorCode.PROVIDER_ERROR: 502,
    ErrorCode.STRUCTURED_OUTPUT_FAILED: 502,
    ErrorCode.EMBEDDING_DIMENSION_MISMATCH: 422,
    ErrorCode.BUSY: 429,
    ErrorCode.GENERATION_FAILED: 502,
    ErrorCode.FILE_TOO_LARGE: 413,
    ErrorCode.INTERNAL: 500,
}

# Safe, fixed, user-facing messages. Upstream bodies are NEVER copied into messages.
SAFE_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.VALIDATION: "The request was invalid.",
    ErrorCode.SERVICE_UNAUTHORIZED: "Unauthorized.",
    ErrorCode.PROVIDER_AUTH_INVALID: "The AI provider rejected the API key. Check that the key is valid and has access.",
    ErrorCode.PROVIDER_RATE_LIMITED: "The AI provider is rate limiting requests. Please wait a moment and try again.",
    ErrorCode.PROVIDER_TIMEOUT: "The AI provider took too long to respond. Please try again.",
    ErrorCode.PROVIDER_UNAVAILABLE: "The AI provider is currently unavailable. Please try again later.",
    ErrorCode.MODEL_NOT_FOUND: "The selected model was not found or is not available for this key.",
    ErrorCode.CONTEXT_TOO_LONG: "The conversation or document context is too long for the selected model.",
    ErrorCode.CAPABILITY_UNSUPPORTED: "The selected provider or model does not support this operation.",
    ErrorCode.CONTENT_FILTERED: "The AI provider blocked this request or response with its content filter.",
    ErrorCode.QUOTA_EXCEEDED: "The AI provider reports that the quota or billing limit for this key has been reached.",
    ErrorCode.PROVIDER_ERROR: "The AI provider returned an error. Please try again.",
    ErrorCode.STRUCTURED_OUTPUT_FAILED: "The model did not return a valid structured answer.",
    ErrorCode.EMBEDDING_DIMENSION_MISMATCH: "The selected embedding model does not produce 1536-dimensional vectors.",
    ErrorCode.BUSY: "The service is busy. Please retry shortly.",
    ErrorCode.GENERATION_FAILED: "The questions could not be generated. Please try again.",
    ErrorCode.FILE_TOO_LARGE: "The uploaded file is too large.",
    ErrorCode.INTERNAL: "An internal error occurred.",
}

DEFAULT_RETRYABLE = {
    ErrorCode.PROVIDER_RATE_LIMITED,
    ErrorCode.PROVIDER_TIMEOUT,
    ErrorCode.PROVIDER_UNAVAILABLE,
    ErrorCode.BUSY,
}


class AppError(Exception):
    """Service error. `message` is always safe to show to a user."""

    def __init__(
        self,
        code: ErrorCode | str,
        message: str | None = None,
        *,
        retryable: bool | None = None,
        retry_after_seconds: int | None = None,
        http_status: int | None = None,
        reason: str | None = None,
    ) -> None:
        self.code = ErrorCode(code)
        self.reason = reason  # GENERATION_FAILED only: INVALID_OUTPUT | NO_VALID_QUESTIONS | INSUFFICIENT_SOURCES | UNGROUNDED_OUTPUT
        self.message = message or SAFE_MESSAGES[self.code]
        self.retryable = (self.code in DEFAULT_RETRYABLE) if retryable is None else retryable
        self.retry_after_seconds = retry_after_seconds
        self.http_status = http_status or HTTP_STATUS[self.code]
        super().__init__(f"{self.code.value}")  # str(exc) never contains upstream text

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code.value, "message": self.message, "retryable": self.retryable}
        if self.retry_after_seconds is not None:
            out["retry_after_seconds"] = self.retry_after_seconds
        if self.reason is not None:
            out["reason"] = self.reason
        return out

    def body(self) -> dict[str, Any]:
        return {"error": self.to_dict()}


# A provider failure is an AppError too; the subclass is a marker used by retry logic.
class ProviderError(AppError):
    pass
