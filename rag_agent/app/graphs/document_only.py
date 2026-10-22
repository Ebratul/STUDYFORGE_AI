"""Policy A: DOCUMENT_ONLY.  validate -> retrieve -> gate -> generate -> verify -> (repair once) -> finalize | fallback.

The gate, verification and fallback are deterministic code. The fallback makes ZERO LLM calls.
"""

from __future__ import annotations

import logging

from langgraph.graph import END, START, StateGraph

from app.citations import GroundedAnswer, verify_answer
from app.errors import AppError
from app.graphs.state import ChatContext, tracked, ChatState, condense_query, emit, final_usage, passes_gate, retrieve_chunks
from app.logging import log_event
from app.prompts import (
    DOCUMENT_ONLY_SYSTEM,
    FALLBACK_TEXT,
    REPAIR_INSTRUCTION,
    build_user_turn,
    new_delimiter_token,
    render_sources,
)
from app.providers.base import ChatMessage, ChatRequest

log = logging.getLogger("rag.doc_only")


def build_document_only_graph(ctx: ChatContext):
    body = ctx.body

    async def validate(state: ChatState) -> ChatState:
        question = body.messages[-1].content
        return {"question": question, "query_text": condense_query(body.messages), "attempt": 0, "chunks": [], "trail": ["validate"]}

    def after_validate(state: ChatState) -> str:
        # nothing authorised to search -> deterministic fallback (no retrieval, no LLM)
        return "retrieve" if body.document_ids else "no_documents"

    async def no_documents(state: ChatState) -> ChatState:
        emit("meta", _meta(ctx, "skipped"))
        return {"retrieval": "skipped", "trail": ["no_documents"]}

    async def retrieve(state: ChatState) -> ChatState:
        try:
            chunks = await retrieve_chunks(ctx, state["query_text"])
        except AppError:
            emit("meta", _meta(ctx, "unavailable"))
            raise
        emit("meta", _meta(ctx, "performed"))
        return {"chunks": chunks, "retrieval": "performed", "trail": ["retrieve"]}

    def gate(state: ChatState) -> str:
        return "generate" if passes_gate(state.get("chunks", []), ctx.min_similarity) else "fallback"

    async def generate(state: ChatState) -> ChatState:
        attempt = state.get("attempt", 0)
        chunks = state["chunks"]
        token = state.get("token") or new_delimiter_token()
        question = state["question"]
        user_turn = build_user_turn(question, render_sources(chunks, token))
        if attempt > 0:
            user_turn += "\n\n" + REPAIR_INSTRUCTION
        history = [ChatMessage(role=m.role, content=m.content) for m in body.messages[:-1]]
        messages = [ChatMessage(role="system", content=DOCUMENT_ONLY_SYSTEM), *history, ChatMessage(role="user", content=user_turn)]
        emit("status", {"stage": "generating"})
        req = ChatRequest(model=body.chat.model, api_key=body.chat.api_key, messages=messages, params=body.chat.params.to_chat_params())
        res = await ctx.chat_provider.generate_structured(req, GroundedAnswer)
        parsed = res.parsed if isinstance(res.parsed, GroundedAnswer) else GroundedAnswer.model_validate(res.parsed.model_dump())
        usage = {"prompt_tokens": res.usage.prompt_tokens, "completion_tokens": res.usage.completion_tokens}
        prev = state.get("usage") or {}
        usage = {k: (None if usage[k] is None and prev.get(k) is None else (usage[k] or 0) + (prev.get(k) or 0)) for k in usage}
        return {"parsed": parsed, "token": token, "usage": usage, "finish_reason": res.finish_reason, "trail": ["generate"]}

    async def verify(state: ChatState) -> ChatState:
        emit("status", {"stage": "verifying"})
        verdict = verify_answer(state["parsed"], state["chunks"])
        if verdict.leak:
            # security event: no secrets, no content
            log_event(log, "security_leak_blocked", logging.WARNING, request_id=body.request_id, mode="DOCUMENT_ONLY")
        else:
            log_event(log, "verify", request_id=body.request_id, ok=verdict.ok, reason=verdict.reason, attempt=state.get("attempt", 0))
        return {"verdict": verdict, "trail": ["verify"]}

    def after_verify(state: ChatState) -> str:
        v = state["verdict"]
        if v.ok:
            return "finalize"
        if v.leak:
            return "fallback"
        if state.get("attempt", 0) < 1:
            return "repair"
        return "fallback"

    async def repair(state: ChatState) -> ChatState:
        return {"attempt": state.get("attempt", 0) + 1, "trail": ["repair"]}

    async def finalize(state: ChatState) -> ChatState:
        v = state["verdict"]
        emit("delta", {"text": v.answer})
        emit("citations", {"citations": v.citations})
        final = {
            "content": v.answer,
            "fallback": False,
            "insufficient_evidence": False,
            "finish_reason": state.get("finish_reason") or "stop",
            "usage": final_usage(state.get("usage")),
        }
        emit("final", final)
        return {"final": final, "trail": ["finalize"]}

    async def fallback(state: ChatState) -> ChatState:
        final = {
            "content": FALLBACK_TEXT,
            "fallback": True,
            "insufficient_evidence": True,
            "finish_reason": "stop",
            "usage": final_usage(state.get("usage")),
        }
        emit("final", final)
        return {"final": final, "trail": ["fallback"]}

    g = StateGraph(ChatState)
    g.add_node("validate", tracked(ctx, validate))
    g.add_node("no_documents", tracked(ctx, no_documents))
    g.add_node("retrieve", tracked(ctx, retrieve))
    g.add_node("generate", tracked(ctx, generate))
    g.add_node("verify", tracked(ctx, verify))
    g.add_node("repair", tracked(ctx, repair))
    g.add_node("finalize", tracked(ctx, finalize))
    g.add_node("fallback", tracked(ctx, fallback))
    g.add_edge(START, "validate")
    g.add_conditional_edges("validate", after_validate, {"retrieve": "retrieve", "no_documents": "no_documents"})
    g.add_edge("no_documents", "fallback")
    g.add_conditional_edges("retrieve", gate, {"generate": "generate", "fallback": "fallback"})
    g.add_edge("generate", "verify")
    g.add_conditional_edges("verify", after_verify, {"finalize": "finalize", "repair": "repair", "fallback": "fallback"})
    g.add_edge("repair", "generate")  # bounded: attempt < 1 is checked in after_verify
    g.add_edge("finalize", END)
    g.add_edge("fallback", END)
    return g.compile()


def _meta(ctx: ChatContext, retrieval: str) -> dict:
    b = ctx.body
    return {
        "request_id": b.request_id,
        "mode": b.mode,
        "provider": b.chat.provider,
        "model": b.chat.model,
        "documents_considered": len(set(b.document_ids)),
        "retrieval": retrieval,
    }
