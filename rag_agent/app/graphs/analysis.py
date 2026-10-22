"""Analysis workflows (PART5_SPEC §6): validate -> prepare -> generate (structured) -> verify -> [repair once] -> finalize | error.

Bounded: at most two provider rounds (the second only after a rejected first), a hard whole-run deadline, explicit cancellation of the
in-flight provider call. API keys live only in `AnalysisContext` (closures), never in graph state. Nothing is persisted or shared between users.
"""

from __future__ import annotations

import asyncio
import logging
import operator
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

from app.analysis import verify as V
from app.analysis.prompting import analysis_messages
from app.analysis.schemas import LlmAnalysis, LlmPlan, PlanBody, ResultBody
from app.config import Settings
from app.errors import AppError, ErrorCode
from app.graphs.state import tracked
from app.logging import log_event
from app.providers.base import ChatRequest, Provider
from app.providers.registry import ProviderRegistry
from app.redact import bind_secrets

log = logging.getLogger("rag.analysis")

MAX_ROUNDS = 2  # first attempt + one repair

WARNING_TEXT = {
    "NO_STRUCTURED_OUTPUT_NATIVE": "This model does not support native structured output; JSON was requested in the prompt instead.",
    "REPAIRED": "The first answer failed verification and was regenerated once.",
}


@dataclass
class AnalysisContext:
    settings: Settings
    body: ResultBody | PlanBody
    kind: str  # "RESULT" | "PLAN"
    chat_provider: Provider
    secrets: list[str] = field(default_factory=list)
    closed: bool = False
    live_tasks: set = field(default_factory=set)

    async def shutdown(self) -> None:
        self.closed = True
        tasks = [t for t in self.live_tasks if not t.done() and t is not asyncio.current_task()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class AnalysisState(TypedDict, total=False):
    attempt: int
    fix: list[str]
    parsed: Any
    ok: bool
    ungrounded: bool
    content: dict[str, Any]
    calls: int
    parse_failures: int
    usage: dict[str, int | None]
    prompt_json: bool
    started: float
    final: dict[str, Any]
    trail: Annotated[list[str], operator.add]


def _add_usage(prev: dict[str, int | None], u: Any) -> dict[str, int | None]:
    cur = {"prompt_tokens": getattr(u, "prompt_tokens", None), "completion_tokens": getattr(u, "completion_tokens", None)}
    return {k: (None if cur[k] is None and prev.get(k) is None else (cur[k] or 0) + (prev.get(k) or 0)) for k in cur}


def make_analysis_context(settings: Settings, registry: ProviderRegistry, body: ResultBody | PlanBody, kind: str) -> AnalysisContext:
    provider = registry.get(body.chat.provider)  # unknown provider -> 422 before any work
    return AnalysisContext(settings=settings, body=body, kind=kind, chat_provider=provider, secrets=[body.chat.api_key.get_secret_value()])


def build_analysis_graph(ctx: AnalysisContext):
    body = ctx.body
    ctx_data = body.context
    is_result = ctx.kind == "RESULT"
    schema = LlmAnalysis if is_result else LlmPlan
    deadline = min(150.0, ctx.settings.provider_timeout_seconds * 2 + 5)

    async def bounded(state: AnalysisState, coro: Awaitable[Any]) -> Any:
        remaining = deadline - (time.monotonic() - state["started"])
        if remaining <= 0:
            getattr(coro, "close", lambda: None)()
            raise AppError(ErrorCode.PROVIDER_TIMEOUT)
        try:
            return await asyncio.wait_for(coro, timeout=remaining)
        except TimeoutError:
            raise AppError(ErrorCode.PROVIDER_TIMEOUT) from None

    async def validate(state: AnalysisState) -> AnalysisState:
        # the request models already enforced shapes and caps; this is the explicit gate of the workflow
        return {
            "attempt": 0, "fix": [], "calls": 0, "parse_failures": 0, "usage": {"prompt_tokens": None, "completion_tokens": None},
            "prompt_json": False, "started": time.monotonic(), "ok": False, "ungrounded": False, "trail": ["validate"],
        }

    async def prepare(state: AnalysisState) -> AnalysisState:
        log_event(log, "analysis_start", request_id=body.request_id, kind=ctx.kind, provider=body.chat.provider, topics=len(ctx_data.topics))
        return {"trail": ["prepare"]}

    async def generate(state: AnalysisState) -> AnalysisState:
        attempt = state["attempt"]
        messages = analysis_messages(kind=ctx.kind, ctx=ctx_data, attempt=attempt, fix=state["fix"])
        req = ChatRequest(model=body.chat.model, api_key=body.chat.api_key, messages=messages, params=body.chat.params.to_chat_params())
        try:
            res = await bounded(state, ctx.chat_provider.generate_structured(req, schema))
        except AppError as e:
            if e.code != ErrorCode.STRUCTURED_OUTPUT_FAILED:
                raise  # auth / rate limit / timeout / unavailable ...: the run fails with the normalised provider error (no fallback provider)
            log_event(log, "analysis_unparseable", logging.WARNING, request_id=body.request_id, attempt=attempt)
            return {"parsed": None, "calls": state["calls"] + 2, "parse_failures": state["parse_failures"] + 1, "fix": [*state["fix"], "invalid_json"], "trail": ["generate_unparseable"]}
        parsed = res.parsed if isinstance(res.parsed, schema) else schema.model_validate(res.parsed.model_dump())
        return {
            "parsed": parsed, "calls": state["calls"] + 1 + (1 if res.repaired else 0), "usage": _add_usage(state["usage"], res.usage),
            "prompt_json": state["prompt_json"] or res.method == "prompt", "trail": ["generate"],
        }

    async def verify(state: AnalysisState) -> AnalysisState:
        if state["parsed"] is None:
            return {"ok": False, "ungrounded": False, "trail": ["verify"]}
        check = V.verify_analysis if is_result else V.verify_plan
        content, reasons, ungrounded, leak = check(state["parsed"], ctx_data)  # type: ignore[arg-type]
        if leak:
            # security event: no secrets, no content. No repair, no retry: the answer is discarded.
            log_event(log, "security_leak_blocked", logging.WARNING, request_id=body.request_id, kind=ctx.kind)
            raise AppError(ErrorCode.GENERATION_FAILED, "The AI model returned an unusable answer. Please try again.", retryable=False, reason="INVALID_OUTPUT")
        log_event(log, "analysis_verify", request_id=body.request_id, ok=content is not None, reasons=[r.split(":", 1)[0] for r in reasons], attempt=state["attempt"])
        if content is not None:
            return {"ok": True, "content": content, "trail": ["verify"]}
        return {"ok": False, "ungrounded": ungrounded, "fix": [*[f for f in state["fix"] if f != "invalid_json"], *reasons][:8], "trail": ["verify"]}

    def after_verify(state: AnalysisState) -> str:
        if state["ok"]:
            return "finalize"
        return "repair" if state["attempt"] + 1 < MAX_ROUNDS else "fail"

    async def repair(state: AnalysisState) -> AnalysisState:
        return {"attempt": state["attempt"] + 1, "trail": ["repair"]}

    async def fail(state: AnalysisState) -> AnalysisState:
        if state["ungrounded"]:
            raise AppError(ErrorCode.GENERATION_FAILED, "The AI feedback could not be verified against your data, so it was discarded.", retryable=True, reason="UNGROUNDED_OUTPUT")
        raise AppError(ErrorCode.GENERATION_FAILED, "The AI model did not return feedback in a usable format. Try a different model.", retryable=True, reason="INVALID_OUTPUT")

    async def finalize(state: AnalysisState) -> AnalysisState:
        codes = []
        if state["prompt_json"]:
            codes.append("NO_STRUCTURED_OUTPUT_NATIVE")
        if state["attempt"] > 0:
            codes.append("REPAIRED")
        usage = state["usage"]
        final = {
            "result": state["content"],
            "usage": {"prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"), "llm_calls": state["calls"]},
            "warnings": [{"code": c, "message": WARNING_TEXT[c]} for c in codes],
        }
        log_event(log, "analysis_done", request_id=body.request_id, kind=ctx.kind, calls=state["calls"])
        return {"final": final, "trail": ["finalize"]}

    g = StateGraph(AnalysisState)
    for name, fn in (("validate", validate), ("prepare", prepare), ("generate", generate), ("verify", verify), ("repair", repair), ("fail", fail), ("finalize", finalize)):
        g.add_node(name, tracked(ctx, fn))  # type: ignore[arg-type]
    g.add_edge(START, "validate")
    g.add_edge("validate", "prepare")
    g.add_edge("prepare", "generate")
    g.add_edge("generate", "verify")
    g.add_conditional_edges("verify", after_verify, {"finalize": "finalize", "repair": "repair", "fail": "fail"})
    g.add_edge("repair", "generate")  # bounded: after_verify allows exactly one repair
    g.add_edge("finalize", END)
    g.add_edge("fail", END)
    return g.compile()


async def run_analysis(ctx: AnalysisContext) -> dict[str, Any]:
    """Runs the workflow; returns {"result", "usage", "warnings"} or raises AppError (never anything else)."""
    graph = build_analysis_graph(ctx)
    with bind_secrets(ctx.secrets):
        try:
            state = await graph.ainvoke({}, config={"recursion_limit": 25})
            return state["final"]
        except AppError as e:
            log_event(log, "analysis_error", logging.WARNING, request_id=ctx.body.request_id, code=e.code.value, reason=e.reason)
            raise
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log_event(log, "analysis_internal_error", logging.ERROR, request_id=ctx.body.request_id, exc_type=type(exc).__name__)
            raise AppError(ErrorCode.INTERNAL) from None
        finally:
            await ctx.shutdown()
