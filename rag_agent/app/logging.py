"""JSON structured logging with central redaction. Never log bodies, prompts or document text."""

from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from app.redact import scrub, scrub_obj

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001
            msg = str(record.msg)
        record.msg = scrub(msg)
        record.args = ()
        for k, v in list(record.__dict__.items()):
            if k not in _RESERVED:
                record.__dict__[k] = scrub_obj(v)
        if record.exc_info:
            # keep only the exception type; messages may contain upstream text
            record.exc_text = None
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data: dict[str, Any] = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "msg": scrub(record.getMessage()),
        }
        rid = request_id_var.get()
        if rid:
            data["request_id"] = rid
        if record.exc_info and record.exc_info[0] is not None:
            data["exc_type"] = record.exc_info[0].__name__
        for k, v in record.__dict__.items():
            if k not in _RESERVED and not k.startswith("_"):
                data[k] = v
        return json.dumps(scrub_obj(data), default=str, ensure_ascii=False)


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, "_rag_handler", False):
            root.removeHandler(h)
    handler = logging.StreamHandler(sys.stderr)
    handler._rag_handler = True  # type: ignore[attr-defined]
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())
    root.addHandler(handler)
    root.setLevel(level.upper())
    # uvicorn installs its own handlers (unscrubbed, with tracebacks): route its records through ours instead
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
    # third-party loggers can emit request URLs/headers at DEBUG; keep them quiet
    for noisy in ("httpx", "httpcore", "openai", "langsmith"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def log_event(logger: logging.Logger, event: str, level: int = logging.INFO, **fields: Any) -> None:
    """Structured event. `fields` must be scalars/ids/counts/durations: never text content."""
    logger.log(level, event, extra={"event": event, **fields})
