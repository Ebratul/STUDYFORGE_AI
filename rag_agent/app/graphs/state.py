"""Shared typed state and per-request context for the LangGraph workflows.

API keys live ONLY in `ChatContext` (captured by node closures), never in graph state, so they cannot reach
checkpoints or traces through the state.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import operator
from dataclasses import dataclass, field
from typing import Annotated, Any, TypedDict

from langgraph.config import get_stream_writer
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.logging import log_event
from app.providers.base import ChatMessage, EmbedRequest, Provider
from app.providers.registry import ProviderRegistry
from app.retrieval.search import RetrievedChunk, search_chunks
from app.schemas import ChatBody

log = logging.getLogger("rag.chat")


class ChatState(TypedDict, total=False):
    question: str
    query_text: str
    chunks: list[RetrievedChunk]
    retrieval: str  # performed | skipped | unavailable
    token: str
    attempt: int
    parsed: Any
    verdict: Any
    usage: dict[str, int | None]
    text: str
    finish_reason: str | None
    leaked: bool
    route: str
    final: dict[str, Any]
    trail: Annotated[list[str], operator.add]


@dataclass
class ChatContext:
    settings: Settings
    registry: ProviderRegistry
    pool: AsyncConnectionPool | None
    body: ChatBody
    chat_provider: Provider
    embed_provider: Provider | None
    top_k: int
    min_similarity: float
    max_context_chars: int
    secrets: list[str] = field(default_factory=list)
    closed: bool = False  # set when the consumer went away: nodes must not start/continue
    live_tasks: set = field(default_factory=set)  # node tasks, cancelled explicitly on close (see tracked)

    async def shutdown(self) -> None:
        """Cancel every in-flight node (and thereby its provider HTTP call). Does not rely on LangGraph's own cancellation,
        which can leave a node task running if cancellation lands at the wrong moment."""
        self.closed = True
        tasks = [t for t in self.live_tasks if not t.done() and t is not asyncio.current_task()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def tracked(ctx: ChatContext, fn):
    """Wrap a node so its task is registered for explicit cancellation."""

    @functools.wraps(fn)
    async def wrapper(state):
        if ctx.closed:
            raise asyncio.CancelledError()
        task = asyncio.current_task()
        ctx.live_tasks.add(task)
        try:
            return await fn(state)
        finally:
            ctx.live_tasks.discard(task)

    return wrapper


def emit(event: str, data: dict[str, Any]) -> None:
    get_stream_writer()({"event": event, "data": data})


def condense_query(messages: list[ChatMessage] | list) -> str:
    """Deterministic follow-up handling (no LLM): short follow-ups are prefixed with the previous user turn."""
    users = [m.content for m in messages if m.role == "user"]
    last = users[-1]
    if len(users) >= 2 and len(last) < 60:
        prev = users[-2]
        return (prev[:400] + " " + last).strip()
    return last


async def retrieve_chunks(ctx: ChatContext, query_text: str) -> list[RetrievedChunk]:
    """Embed the query and run the owner-scoped hybrid search. Raises AppError for provider/infra failures."""
    body = ctx.body
    if body.embedding is None or ctx.embed_provider is None:
        raise AppError(ErrorCode.CAPABILITY_UNSUPPORTED, "Document search needs an embedding provider, but none is configured.")
    if ctx.pool is None:
        raise AppError(ErrorCode.INTERNAL, "Database is not available.")
    emb = await ctx.embed_provider.embed(
        EmbedRequest(model=body.embedding.model, api_key=body.embedding.api_key, inputs=[query_text[:8000]])
    )
    if not emb.vectors:
        raise AppError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
    try:
        async with ctx.pool.connection() as conn:
            chunks = await search_chunks(
                conn,
                owner_id=body.user_id,
                document_ids=body.document_ids,
                query_embedding=emb.vectors[0],
                query_text=query_text,
                embedding_model=body.embedding.model,
                top_k=ctx.top_k,
                min_similarity=ctx.min_similarity,
                max_context_chars=ctx.max_context_chars,
            )
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001  database/infra failure
        log_event(log, "retrieval_db_error", logging.ERROR, exc_type=type(exc).__name__)
        raise AppError(ErrorCode.INTERNAL, "Document search is temporarily unavailable.") from None
    log_event(log, "retrieval_done", request_id=body.request_id, chunks=len(chunks),
              best_similarity=max((c.similarity for c in chunks), default=None))
    return chunks


def passes_gate(chunks: list[RetrievedChunk], min_similarity: float) -> bool:
    return bool(chunks) and max(c.similarity for c in chunks) >= min_similarity


def final_usage(usage: dict[str, int | None] | None) -> dict[str, int | None]:
    u = usage or {}
    return {"prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens")}
