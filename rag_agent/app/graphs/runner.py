"""Runs a compiled graph and yields (event, data) pairs for SSE. Maps every failure to an `error` event."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.graphs.document_only import build_document_only_graph
from app.graphs.general import build_general_graph
from app.graphs.state import ChatContext
from app.logging import log_event
from app.providers.registry import ProviderRegistry
from app.redact import bind_secrets
from app.schemas import ChatBody
from app.tracing import build_callbacks

log = logging.getLogger("rag.chat")


def make_context(settings: Settings, registry: ProviderRegistry, pool: Any, body: ChatBody) -> ChatContext:
    chat_provider = registry.get(body.chat.provider)
    embed_provider = registry.get(body.embedding.provider) if body.embedding else None
    r = body.retrieval
    secrets = [body.chat.api_key.get_secret_value()]
    if body.embedding:
        secrets.append(body.embedding.api_key.get_secret_value())
    return ChatContext(
        settings=settings,
        registry=registry,
        pool=pool,
        body=body,
        chat_provider=chat_provider,
        embed_provider=embed_provider,
        top_k=(r.top_k if r and r.top_k else settings.retrieval_top_k),
        min_similarity=(r.min_similarity if r and r.min_similarity is not None else settings.retrieval_min_similarity),
        max_context_chars=(r.max_context_chars if r and r.max_context_chars else settings.retrieval_max_context_chars),
        secrets=secrets,
    )


async def run_chat(ctx: ChatContext) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    graph = build_document_only_graph(ctx) if ctx.body.mode == "DOCUMENT_ONLY" else build_general_graph(ctx)
    config: dict[str, Any] = {"callbacks": build_callbacks(ctx.settings)}
    terminal = False
    with bind_secrets(ctx.secrets):
        stream = graph.astream({}, config=config, stream_mode="custom")
        try:
            async for item in stream:
                event, data = item["event"], item["data"]
                if event in ("final", "error"):
                    terminal = True
                yield event, data
        except AppError as e:
            log_event(log, "chat_error", logging.WARNING, request_id=ctx.body.request_id, code=e.code.value)
            terminal = True
            yield "error", e.to_dict()
        except Exception as exc:  # noqa: BLE001
            log_event(log, "chat_internal_error", logging.ERROR, request_id=ctx.body.request_id, exc_type=type(exc).__name__)
            terminal = True
            yield "error", AppError(ErrorCode.INTERNAL).to_dict()
        finally:
            await ctx.shutdown()  # explicit: cancels any node (and its provider call) still running
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except BaseException:  # noqa: BLE001
                    pass
        if not terminal:  # defensive: a stream must end with final or error
            yield "error", AppError(ErrorCode.INTERNAL).to_dict()
