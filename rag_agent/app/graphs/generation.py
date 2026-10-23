"""Generation workflow (PART3_SPEC §7): prepare -> gate -> [next_batch -> generate -> validate -> (regenerate <= N) -> cross_check]* -> finalize.

Bounded everywhere: questions per run (caller), batch size, <= `max_regen_per_batch` regenerations per batch, <= `max_llm_calls` provider calls
per run, a soft deadline (no new batch after 85 % of the timeout; partial results are returned) and a hard per-call deadline.
API keys live only in `GenContext` (closures), never in graph state. Nothing is persisted; the backend owns persistence.
"""

from __future__ import annotations

import asyncio
import logging
import operator
import time
from dataclasses import dataclass, field
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.generation import validate as V
from app.generation.prompting import generation_messages, solver_messages
from app.generation.schemas import CqGenBody, LlmCqBatch, LlmMcqBatch, McqGenBody, SolverBatch
from app.generation.sources import (
    POOL_MAX_CHUNKS,
    TOPIC_POOL_K,
    SourceChunk,
    context_budget,
    from_retrieved,
    sample_chunks,
    select_for_batch,
    split_pasted,
)
from app.graphs.state import emit, tracked
from app.logging import log_event
from app.providers.base import ChatRequest, EmbedRequest, Provider
from app.providers.registry import ProviderRegistry
from app.retrieval.search import search_chunks
from app.vectorstore import VectorRuntime

log = logging.getLogger("rag.generation")

SOFT_DEADLINE = 0.85

WARNING_TEXT = {
    "FEWER_THAN_REQUESTED": "Fewer questions than requested passed validation.",
    "SOME_REJECTED": "Some generated questions were rejected by validation and replaced or dropped.",
    "LANGUAGE_MISMATCH": "Some questions may not be fully in the requested language.",
    "NO_STRUCTURED_OUTPUT_NATIVE": "This model does not support native structured output; JSON was requested in the prompt instead.",
    "CROSS_CHECK_SKIPPED": "The independent answer-key check was skipped for some or all questions.",
    "CONTEXT_TRUNCATED": "Part of the source material was cut to fit the model's context window.",
    "MARKS_ADJUSTED": "Marks were adjusted to the requested distribution.",
}


class _Deadline(Exception):
    """Internal: the run's time budget is exhausted (never leaves this module)."""


@dataclass
class GenContext:
    settings: Settings
    registry: ProviderRegistry
    pool: AsyncConnectionPool | None
    body: McqGenBody | CqGenBody
    kind: str  # "MCQ" | "CQ"
    chat_provider: Provider
    embed_provider: Provider | None
    secrets: list[str] = field(default_factory=list)
    closed: bool = False
    live_tasks: set = field(default_factory=set)
    vectors: VectorRuntime | None = None  # None = pgvector mode

    async def shutdown(self) -> None:
        """Cancel every in-flight node (and thereby its provider HTTP call)."""
        self.closed = True
        tasks = [t for t in self.live_tasks if not t.done() and t is not asyncio.current_task()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


class GenState(TypedDict, total=False):
    pool: list[SourceChunk]
    dups: Any
    batches: list[int]
    batch_idx: int
    cursor: int
    selection: list[SourceChunk]
    need: int
    attempt: int
    fix: list[str]
    items: list[Any]
    batch_accepted: list[dict[str, Any]]
    accepted: list[dict[str, Any]]
    rejected: int
    parse_failures: int
    calls: int
    usage: dict[str, int | None]
    warnings: list[str]
    shown: dict[str, dict[str, Any]]
    started: float
    stop: bool
    timed_out: bool
    prompt_json: bool
    trail: Annotated[list[str], operator.add]


def _add_usage(prev: dict[str, int | None], u: Any) -> dict[str, int | None]:
    cur = {"prompt_tokens": getattr(u, "prompt_tokens", None), "completion_tokens": getattr(u, "completion_tokens", None)}
    return {k: (None if cur[k] is None and prev.get(k) is None else (cur[k] or 0) + (prev.get(k) or 0)) for k in cur}


def _meta(ctx: GenContext) -> dict[str, Any]:
    b = ctx.body
    return {"request_id": b.request_id, "provider": b.chat.provider, "model": b.chat.model, "kind": ctx.kind}


async def assemble_pool(ctx: GenContext) -> list[SourceChunk]:
    """Pasted text -> pseudo-chunks; documents -> topic retrieval (needs embeddings) or deterministic coverage sampling."""
    body = ctx.body
    src = body.sources
    pool = split_pasted(src.pasted_text or "")
    if src.document_ids:
        if ctx.pool is None:
            raise AppError(ErrorCode.INTERNAL, "Database is not available.")
        topic = (src.topic or "").strip()
        emit("status", {"stage": "retrieving"})
        try:
            if topic:
                if body.embedding is None or ctx.embed_provider is None:
                    raise AppError(ErrorCode.CAPABILITY_UNSUPPORTED, "Searching your documents for a topic needs an embedding provider, but none is configured.")
                subject = getattr(body.spec, "subject", None) or ""
                query = f"{topic} {subject}".strip()[:2000]
                emb = await ctx.embed_provider.embed(
                    EmbedRequest(model=body.embedding.model, api_key=body.embedding.api_key, inputs=[query],
                                 dimensions=body.embedding.request_dimensions, expected_dimension=body.embedding.dimension)
                )
                if not emb.vectors:
                    raise AppError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected response.", retryable=False)
                async with ctx.pool.connection() as conn:
                    found = await search_chunks(
                        conn, owner_id=body.user_id, document_ids=body.sources.document_ids, query_embedding=emb.vectors[0],
                        query_text=query, embedding_provider=body.embedding.provider, embedding_model=body.embedding.model,
                        embedding_dimension=body.embedding.dimension, top_k=TOPIC_POOL_K, min_similarity=ctx.settings.retrieval_min_similarity,
                        max_context_chars=None, vectors=ctx.vectors,
                    )
                floor = ctx.settings.retrieval_min_similarity
                found = [c for c in found if c.similarity >= floor] if found and max(c.similarity for c in found) >= floor else []
            else:
                async with ctx.pool.connection() as conn:
                    found = await sample_chunks(conn, owner_id=body.user_id, document_ids=body.sources.document_ids, max_chunks=POOL_MAX_CHUNKS)
        except AppError:
            raise
        except Exception as exc:  # noqa: BLE001  database/infra failure
            log_event(log, "generation_retrieval_db_error", logging.ERROR, exc_type=type(exc).__name__)
            raise AppError(ErrorCode.INTERNAL, "Document search is temporarily unavailable.") from None
        pool = [*pool, *(from_retrieved(c) for c in found)]
    pool = pool[:POOL_MAX_CHUNKS]
    log_event(log, "generation_pool", request_id=body.request_id, chunks=len(pool))
    return pool


def build_generation_graph(ctx: GenContext):
    body = ctx.body
    spec = body.spec
    limits = body.limits
    is_mcq = ctx.kind == "MCQ"
    schema = LlmMcqBatch if is_mcq else LlmCqBatch
    rules = V.McqRules(spec, body.grounding) if is_mcq else V.CqRules(spec, body.grounding)  # type: ignore[arg-type]
    budget = context_budget(limits.max_context_chars, body.context_tokens, body.chat.params.max_output_tokens)
    size = limits.batch_size
    plan = [size] * (spec.count // size) + ([spec.count % size] if spec.count % size else [])

    spec_payload = spec.model_dump()
    if not is_mcq:
        spec_payload["part_marks"] = spec.resolved_part_marks()  # type: ignore[union-attr]
        spec_payload["stimulus"] = spec.effective_stimulus  # type: ignore[union-attr]
        spec_payload.pop("part_count", None)
    spec_payload.pop("count", None)
    spec_payload["total_count"] = spec.count

    def expired(state: GenState, fraction: float = 1.0) -> bool:
        return time.monotonic() - state["started"] >= limits.timeout_seconds * fraction

    async def bounded(state: GenState, coro):
        remaining = limits.timeout_seconds - (time.monotonic() - state["started"])
        if remaining <= 0:
            coro.close()
            raise _Deadline()
        try:
            return await asyncio.wait_for(coro, timeout=remaining)
        except TimeoutError:
            raise _Deadline() from None

    # ---------------------------------------------------------------------------------------- nodes
    async def prepare(state: GenState) -> GenState:
        emit("meta", _meta(ctx))
        emit("status", {"stage": "preparing"})
        pool = await assemble_pool(ctx)
        return {
            "pool": pool, "dups": V.DuplicateIndex.seeded(body.avoid), "batches": plan, "batch_idx": -1, "cursor": 0,
            "accepted": [], "rejected": 0, "parse_failures": 0, "calls": 0, "usage": {"prompt_tokens": None, "completion_tokens": None},
            "warnings": [], "shown": {}, "started": time.monotonic(), "stop": False, "timed_out": False, "prompt_json": False,
            "trail": ["prepare"],
        }

    async def gate(state: GenState) -> GenState:
        if body.grounding != "GENERAL" and not state["pool"]:
            # deterministic: no source material to ground the questions in -> no LLM call at all
            raise AppError(
                ErrorCode.GENERATION_FAILED,
                "No usable source material was found for these questions. Check that the selected documents are processed and match your topic, or paste some text.",
                retryable=False, reason="INSUFFICIENT_SOURCES",
            )
        return {"trail": ["gate"]}

    async def next_batch(state: GenState) -> GenState:
        idx = state["batch_idx"] + 1
        pool = state["pool"]
        selection, cursor, truncated = select_for_batch(pool, state["cursor"], budget) if pool else ([], 0, False)
        warnings = list(state["warnings"])
        if truncated and "CONTEXT_TRUNCATED" not in warnings:
            warnings.append("CONTEXT_TRUNCATED")
        shown = dict(state["shown"])
        for c in selection:
            shown[f"{c.document_id}|{c.document_name}"] = {"document_id": c.document_id, "document_name": c.document_name}
        return {
            "batch_idx": idx, "need": state["batches"][idx], "attempt": 0, "fix": [], "batch_accepted": [], "items": [],
            "selection": selection, "cursor": cursor, "warnings": warnings, "shown": shown, "trail": ["next_batch"],
        }

    async def generate(state: GenState) -> GenState:
        attempt = state["attempt"]
        emit("status", {"stage": "repairing" if attempt else "generating", "batch": state["batch_idx"] + 1, "batches": len(state["batches"])})
        if state["calls"] >= limits.max_llm_calls or expired(state):
            return {"stop": True, "timed_out": expired(state), "items": [], "trail": ["generate_skipped"]}
        have = len(state["accepted"]) + len(state["batch_accepted"])
        messages = generation_messages(
            kind=ctx.kind, grounding=body.grounding, spec=spec_payload, topic=body.sources.topic, selection=state["selection"],
            avoid=[*body.avoid, *[_stem(q) for q in state["accepted"]], *[_stem(q) for q in state["batch_accepted"]]],
            attempt=attempt, batch_count=state["need"] - len(state["batch_accepted"]), start_index=have, fix=state["fix"],
        )
        req = ChatRequest(model=body.chat.model, api_key=body.chat.api_key, messages=messages, params=body.chat.params.to_chat_params())
        try:
            res = await bounded(state, ctx.chat_provider.generate_structured(req, schema))
        except _Deadline:
            return {"stop": True, "timed_out": True, "items": [], "trail": ["generate_deadline"]}
        except AppError as e:
            if e.code != ErrorCode.STRUCTURED_OUTPUT_FAILED:
                raise  # auth / rate limit / timeout / unavailable ...: the run fails with the normalised provider error
            log_event(log, "generation_unparseable", logging.WARNING, request_id=body.request_id, batch=state["batch_idx"], attempt=attempt)
            return {"items": [], "calls": state["calls"] + 2, "parse_failures": state["parse_failures"] + 1,
                    "fix": [*state["fix"], "invalid_json"], "trail": ["generate_unparseable"]}
        parsed = res.parsed if isinstance(res.parsed, schema) else schema.model_validate(res.parsed.model_dump())
        return {
            "items": list(parsed.questions), "calls": state["calls"] + 1 + (1 if res.repaired else 0),
            "usage": _add_usage(state["usage"], res.usage), "prompt_json": state["prompt_json"] or res.method == "prompt",
            "trail": ["generate"],
        }

    async def validate(state: GenState) -> GenState:
        emit("status", {"stage": "validating", "batch": state["batch_idx"] + 1, "batches": len(state["batches"])})
        dups: V.DuplicateIndex = state["dups"]
        batch = list(state["batch_accepted"])
        rejected = state["rejected"]
        fix: list[str] = [f for f in state["fix"] if f != "invalid_json"]
        for item in state["items"]:
            if len(batch) >= state["need"]:
                break
            position = len(state["accepted"]) + len(batch)
            if is_mcq:
                q, why = V.check_mcq(item, rules, state["selection"], position)  # type: ignore[arg-type]
                text, key = (V.mcq_dedupe_key(q) if q else (None, None))
            else:
                q, why = V.check_cq(item, rules, state["selection"], position)  # type: ignore[arg-type]
                text, key = (V.cq_dedupe_text(q), None) if q else (None, None)
            if q is not None and text is not None:
                why = dups.check(text, key)
                if why is None:
                    if dups.nearest(text) >= V.NEAR_DUPLICATE_FLAG:
                        q["review_reasons"].append(V.NEAR_DUPLICATE_REASON)
                    dups.add(text, key)
                    batch.append(q)
                    continue
            rejected += 1
            if why and why not in fix:
                fix.append(why)
        return {"batch_accepted": batch, "rejected": rejected, "fix": fix[:8], "trail": ["validate"]}

    def after_validate(state: GenState) -> str:
        short = len(state["batch_accepted"]) < state["need"]
        if short and not state["stop"] and state["attempt"] < limits.max_regen_per_batch and state["calls"] < limits.max_llm_calls and not expired(state):
            return "regenerate"
        return "cross_check"

    async def regenerate(state: GenState) -> GenState:
        return {"attempt": state["attempt"] + 1, "trail": ["regenerate"]}

    async def cross_check(state: GenState) -> GenState:
        batch = list(state["batch_accepted"])
        warnings = list(state["warnings"])
        calls = state["calls"]
        usage = state["usage"]
        stop, timed_out = state["stop"], state["timed_out"]
        if is_mcq and body.cross_check and batch and not stop:
            remaining_batches = len(state["batches"]) - state["batch_idx"] - 1
            if calls + 1 + remaining_batches > limits.max_llm_calls or expired(state, SOFT_DEADLINE):
                warnings.append("CROSS_CHECK_SKIPPED")
            else:
                emit("status", {"stage": "checking", "batch": state["batch_idx"] + 1, "batches": len(state["batches"])})
                req = ChatRequest(
                    model=body.chat.model, api_key=body.chat.api_key,
                    messages=solver_messages(questions=batch, selection=state["selection"], language=spec.language, topic=body.sources.topic),
                    params=body.chat.params.to_chat_params(),
                )
                try:
                    res = await bounded(state, ctx.chat_provider.generate_structured(req, SolverBatch))
                except _Deadline:
                    warnings.append("CROSS_CHECK_SKIPPED")
                    stop = timed_out = True
                except AppError as e:
                    if e.code == ErrorCode.PROVIDER_AUTH_INVALID:
                        raise
                    log_event(log, "cross_check_skipped", logging.WARNING, request_id=body.request_id, code=e.code.value)
                    warnings.append("CROSS_CHECK_SKIPPED")
                    calls += 1
                else:
                    calls += 1 + (1 if res.repaired else 0)
                    usage = _add_usage(usage, res.usage)
                    parsed = res.parsed if isinstance(res.parsed, SolverBatch) else SolverBatch.model_validate(res.parsed.model_dump())
                    chosen = {a.index: V.positional(a.label) for a in parsed.answers}
                    for i, q in enumerate(batch, start=1):
                        pick = chosen.get(i)
                        key = next(j for j, o in enumerate(q["options"]) if o["id"] == q["correct_option_id"])
                        if pick is not None and pick < len(q["options"]) and pick != key and V.SOLVER_DISAGREES not in q["review_reasons"]:
                            q["review_reasons"].append(V.SOLVER_DISAGREES)
        return {
            "accepted": [*state["accepted"], *batch], "batch_accepted": [], "warnings": warnings, "calls": calls, "usage": usage,
            "stop": stop, "timed_out": timed_out, "trail": ["cross_check"],
        }

    def after_batch(state: GenState) -> str:
        more = state["batch_idx"] + 1 < len(state["batches"])
        if more and not state["stop"] and state["calls"] < limits.max_llm_calls and not expired(state, SOFT_DEADLINE):
            return "next_batch"
        return "finalize"

    async def finalize(state: GenState) -> GenState:
        accepted = state["accepted"][: spec.count]
        if not accepted:
            if state["timed_out"]:
                raise AppError(ErrorCode.PROVIDER_TIMEOUT, "Question generation took too long. Try fewer questions or a faster model.")
            if state["rejected"] == 0 and state["parse_failures"] > 0:
                raise AppError(
                    ErrorCode.GENERATION_FAILED, "The AI model did not return questions in a usable format. Try a different model.",
                    retryable=True, reason="INVALID_OUTPUT",
                )
            raise AppError(
                ErrorCode.GENERATION_FAILED, "None of the generated questions passed validation. Try again, choose a different model, or adjust your settings.",
                retryable=True, reason="NO_VALID_QUESTIONS",
            )
        codes = list(state["warnings"])
        if len(accepted) < spec.count:
            codes.append("FEWER_THAN_REQUESTED")
        if state["rejected"] > 0:
            codes.append("SOME_REJECTED")
        flagged = {r for q in accepted for r in q["review_reasons"]}
        for r in (V.LANGUAGE_MISMATCH, V.MARKS_ADJUSTED):
            if r in flagged:
                codes.append(r)
        if state["prompt_json"]:
            codes.append("NO_STRUCTURED_OUTPUT_NATIVE")
        warnings = [{"code": c, "message": WARNING_TEXT[c]} for c in dict.fromkeys(codes)]
        usage = state["usage"]
        emit("result", {
            "questions": accepted, "rejected": state["rejected"], "warnings": warnings,
            "usage": {"prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens"), "llm_calls": state["calls"]},
            "sources_used": sorted(state["shown"].values(), key=lambda s: (str(s["document_name"]), str(s["document_id"]))),
        })
        log_event(log, "generation_done", request_id=body.request_id, kind=ctx.kind, accepted=len(accepted), rejected=state["rejected"], calls=state["calls"])
        return {"trail": ["finalize"]}

    g = StateGraph(GenState)
    for name, fn in (("prepare", prepare), ("gate", gate), ("next_batch", next_batch), ("generate", generate), ("validate", validate),
                     ("regenerate", regenerate), ("cross_check", cross_check), ("finalize", finalize)):
        g.add_node(name, tracked(ctx, fn))  # type: ignore[arg-type]
    g.add_edge(START, "prepare")
    g.add_edge("prepare", "gate")
    g.add_edge("gate", "next_batch")
    g.add_edge("next_batch", "generate")
    g.add_edge("generate", "validate")
    g.add_conditional_edges("validate", after_validate, {"regenerate": "regenerate", "cross_check": "cross_check"})
    g.add_edge("regenerate", "generate")  # bounded: after_validate checks attempt/calls/deadline
    g.add_conditional_edges("cross_check", after_batch, {"next_batch": "next_batch", "finalize": "finalize"})
    g.add_edge("finalize", END)
    return g.compile()


def _stem(q: dict[str, Any]) -> str:
    return q["stem"]
