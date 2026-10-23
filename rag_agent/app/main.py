"""FastAPI application factory."""

from __future__ import annotations

import logging
import re
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api import analyze, chat, generate, health, ingest, providers, reindex
from app.api import vectors as vectors_api
from app.config import Settings, load_settings_or_exit
from app.db import make_pool
from app.errors import AppError, ErrorCode
from app.logging import configure_logging, request_id_var
from app.providers.registry import ProviderRegistry
from app.tracing import apply_tracing_env
from app.vectorstore import VectorRuntime

log = logging.getLogger("rag.app")
_RID = re.compile(r"^[A-Za-z0-9._\-]{1,64}$")


class RequestContextMiddleware:
    """Request id propagation (x-request-id) and a hard cap on request body size."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.json_limit = 1024 * 1024
        self.upload_limit = settings.max_upload_bytes + 1024 * 1024

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope["headers"]}
        rid = headers.get("x-request-id", "")
        rid = rid if _RID.match(rid) else uuid.uuid4().hex
        request_id_var.set(rid)
        limit = self.upload_limit if scope["path"] == "/v1/ingest" else self.json_limit
        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            err = AppError(ErrorCode.FILE_TOO_LARGE, "The request body is too large.")
            resp = JSONResponse(err.body(), status_code=413, headers={"x-request-id": rid})
            await resp(scope, receive, send)
            return
        seen = 0

        async def limited_receive() -> Message:
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise AppError(ErrorCode.FILE_TOO_LARGE, "The request body is too large.")
            return msg

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = [*message["headers"], (b"x-request-id", rid.encode())]
            await send(message)

        await self.app(scope, limited_receive, send_with_id)


def create_app(settings: Settings | None = None, *, registry: ProviderRegistry | None = None, pool=None, vectors: VectorRuntime | None = None) -> FastAPI:
    settings = settings or load_settings_or_exit()
    configure_logging(settings.log_level)
    apply_tracing_env(settings)
    if settings.ocr_enabled:
        log.warning("ocr_enabled_but_no_engine_configured: scanned PDFs will be reported as NEEDS_OCR")
    own_vectors = vectors is None
    vectors = vectors if vectors is not None else VectorRuntime.from_settings(settings)  # builds no network client in pgvector mode
    own_pool = pool is None and bool(settings.database_url.get_secret_value())
    if own_pool:
        pool = make_pool(settings.database_url.get_secret_value())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if own_pool:
            await pool.open(wait=False)
        yield
        if own_pool:
            await pool.close()
        if own_vectors:
            await vectors.aclose()

    app = FastAPI(title="StudyForge rag_agent", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.registry = registry or ProviderRegistry(settings)
    app.state.pool = pool
    app.state.vectors = vectors
    app.state.ingests_active = 0
    app.add_middleware(RequestContextMiddleware, settings=settings)

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):
        headers = {}
        if exc.retry_after_seconds is not None and exc.http_status == 429:
            headers["Retry-After"] = str(exc.retry_after_seconds)
        return JSONResponse(exc.body(), status_code=exc.http_status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        # never echo the input (it may contain API keys): field paths only
        fields = sorted({".".join(str(x) for x in e["loc"] if x != "body") for e in exc.errors()})
        err = AppError(ErrorCode.VALIDATION, "Invalid request: " + ", ".join(f for f in fields if f)[:300])
        return JSONResponse(err.body(), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        code = ErrorCode.VALIDATION if exc.status_code in (400, 404, 405, 413, 415, 422) else ErrorCode.INTERNAL
        err = AppError(code, "Not found." if exc.status_code == 404 else None, http_status=exc.status_code)
        return JSONResponse(err.body(), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log.error("unhandled_exception", extra={"exc_type": type(exc).__name__})
        return JSONResponse(AppError(ErrorCode.INTERNAL).body(), status_code=500)

    app.include_router(health.router)
    app.include_router(providers.router)
    app.include_router(ingest.router)
    app.include_router(reindex.router)
    app.include_router(vectors_api.router)
    app.include_router(chat.router)
    app.include_router(generate.router)
    app.include_router(analyze.router)
    return app


def app_factory() -> FastAPI:
    return create_app()


# `uvicorn app.main:app`: created lazily so importing this module (e.g. in tests) never requires a token.
def __getattr__(name: str):
    if name == "app":
        global _app
        try:
            return _app  # type: ignore[name-defined]
        except NameError:
            _app = create_app()
            return _app
    raise AttributeError(name)
