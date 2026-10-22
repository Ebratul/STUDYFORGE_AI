"""Policy B: GENERAL.  validate -> (retrieve) -> gate -> generate (streaming) -> finalize.

Documents are optional reference material; retrieval failures never fail the chat.
"""

from __future__ import annotations

import logging

from langgraph.graph import END, START, StateGraph

from app.citations import general_citations, has_leak
from app.errors import AppError
from app.graphs.document_only import _meta
from app.graphs.state import ChatContext, tracked, ChatState, condense_query, emit, final_usage, passes_gate, retrieve_chunks
from app.logging import log_event
from app.prompts import CANARY, GENERAL_SYSTEM, LEAK_REFUSAL, build_user_turn, new_delimiter_token, render_sources
from app.providers.base import ChatMessage, ChatRequest
from app.redact import bound_secrets

log = logging.getLogger("rag.general")


def build_general_graph(ctx: ChatContext):
    body = ctx.body

    async def validate(state: ChatState) -> ChatState:
        return {"question": body.messages[-1].content, "query_text": condense_query(body.messages), "chunks": [],
                "retrieval": "skipped", "trail": ["validate"]}

    def after_validate(state: ChatState) -> str:
        wants = body.use_documents and bool(body.document_ids) and body.embedding is not None
        return "retrieve" if wants else "meta"

    async def retrieve(state: ChatState) -> ChatState:
        try:
            chunks = await retrieve_chunks(ctx, state["query_text"])
        except AppError as e:
            log_event(log, "retrieval_failed_tolerated", logging.WARNING, request_id=body.request_id, code=e.code.value)
            return {"chunks": [], "retrieval": "unavailable", "trail": ["retrieve_failed"]}
        except Exception as exc:  # noqa: BLE001
            log_event(log, "retrieval_failed_tolerated", logging.WARNING, request_id=body.request_id, exc_type=type(exc).__name__)
            return {"chunks": [], "retrieval": "unavailable", "trail": ["retrieve_failed"]}
        return {"chunks": chunks, "retrieval": "performed", "trail": ["retrieve"]}

    async def gate(state: ChatState) -> ChatState:
        chunks = state.get("chunks", [])
        if chunks and not passes_gate(chunks, ctx.min_similarity):
            chunks = []
        return {"chunks": chunks, "trail": ["gate"]}

    async def meta(state: ChatState) -> ChatState:
        emit("meta", _meta(ctx, state.get("retrieval", "skipped")))
        return {"trail": ["meta"]}

    async def generate(state: ChatState) -> ChatState:
        chunks = state.get("chunks", [])
        token = new_delimiter_token()
        block = render_sources(chunks, token) if chunks else None
        history = [ChatMessage(role=m.role, content=m.content) for m in body.messages[:-1]]
        user_turn = build_user_turn(state["question"], block)
        messages = [ChatMessage(role="system", content=GENERAL_SYSTEM), *history, ChatMessage(role="user", content=user_turn)]
        req = ChatRequest(model=body.chat.model, api_key=body.chat.api_key, messages=messages, params=body.chat.params.to_chat_params())
        emit("status", {"stage": "generating"})

        # Streaming leak guard: hold back the last (L-1) characters so a secret split across deltas is never sent.
        secrets = [s for s in bound_secrets()] + [CANARY]
        hold = max(len(s) for s in secrets) - 1
        full = ""
        sent = 0
        leaked = False
        usage: dict[str, int | None] = {"prompt_tokens": None, "completion_tokens": None}
        finish: str | None = None
        stream = ctx.chat_provider.stream(req)
        try:
            async for ch in stream:
                if ch.done:
                    if ch.usage is not None:
                        usage = {"prompt_tokens": ch.usage.prompt_tokens, "completion_tokens": ch.usage.completion_tokens}
                    finish = ch.finish_reason
                    continue
                if not ch.delta or leaked:
                    continue
                full += ch.delta
                if has_leak(full):
                    leaked = True
                    continue
                safe_upto = len(full) - hold
                if safe_upto > sent:
                    emit("delta", {"text": full[sent:safe_upto]})
                    sent = safe_upto
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                await aclose()
        if not leaked and has_leak(full):
            leaked = True
        if not leaked and len(full) > sent:
            emit("delta", {"text": full[sent:]})
        return {"text": full, "usage": usage, "finish_reason": finish, "leaked": leaked, "trail": ["generate"]}

    async def finalize(state: ChatState) -> ChatState:
        chunks = state.get("chunks", [])
        text = state.get("text", "")
        if state.get("leaked"):
            log_event(log, "security_leak_blocked", logging.WARNING, request_id=body.request_id, mode="GENERAL")
            content = LEAK_REFUSAL
        else:
            content = text
            if chunks:
                cits = general_citations(text, chunks)
                if cits:
                    emit("citations", {"citations": cits})
        final = {
            "content": content,
            "fallback": False,
            "insufficient_evidence": False,
            "finish_reason": state.get("finish_reason") or "stop",
            "usage": final_usage(state.get("usage")),
        }
        emit("final", final)
        return {"final": final, "trail": ["finalize"]}

    g = StateGraph(ChatState)
    g.add_node("validate", tracked(ctx, validate))
    g.add_node("retrieve", tracked(ctx, retrieve))
    g.add_node("gate", tracked(ctx, gate))
    g.add_node("meta", tracked(ctx, meta))
    g.add_node("generate", tracked(ctx, generate))
    g.add_node("finalize", tracked(ctx, finalize))
    g.add_edge(START, "validate")
    g.add_conditional_edges("validate", after_validate, {"retrieve": "retrieve", "meta": "meta"})
    g.add_edge("retrieve", "gate")
    g.add_edge("gate", "meta")
    g.add_edge("meta", "generate")
    g.add_edge("generate", "finalize")
    g.add_edge("finalize", END)
    return g.compile()
