"""Payload builders and a graph runner for the Part 5 analysis tests."""

from __future__ import annotations

import uuid
from typing import Any

from app.analysis.schemas import LlmAnalysis, LlmPlan, PlanBody, PlanContext, ResultBody, ResultContext
from app.graphs.analysis import make_analysis_context, run_analysis
from app.providers.mock import VALID_KEY
from app.providers.registry import ProviderRegistry
from tests.conftest import CANARY_KEY, make_settings


def topic(name: str, questions: int, correct: int, incorrect: int | None = None, unanswered: int = 0) -> dict:
    incorrect = questions - correct - unanswered if incorrect is None else incorrect
    return {"topic": name, "questions": questions, "correct": correct, "incorrect": incorrect, "unanswered": unanswered,
            "accuracy_bp": int((correct * 10000 * 2 + questions) // (2 * questions)) if questions else 0}


def default_topics() -> list[dict]:
    return [topic("Cells", 8, 3), topic("Energy", 6, 6), topic("Genetics", 2, 1)]


def chat(provider: str = "mock", key: str = VALID_KEY, model: str = "mock-chat") -> dict:
    return {"provider": provider, "api_key": key, "model": model, "params": {"temperature": 0.2, "top_p": None, "max_output_tokens": 1500}}


def result_context(*, language: str = "en", level: str = "INITIAL", title: str = "Cell biology test", topics: list[dict] | None = None,
                   strong=("Energy",), weak=("Cells",), incorrect_items=None, previous=(), results_total: int = 1) -> dict:
    topics = topics if topics is not None else default_topics()
    q = sum(t["questions"] for t in topics)
    c = sum(t["correct"] for t in topics)
    i = sum(t["incorrect"] for t in topics)
    u = sum(t["unanswered"] for t in topics)
    bp = int((c * 10000 * 2 + q) // (2 * q))
    band = "EXCELLENT" if bp >= 9000 else "GOOD" if bp >= 8000 else "NEEDS_IMPROVEMENT" if bp >= 7000 else "BAD" if bp >= 6000 else "VERY_BAD"
    return {
        "language": language,
        "exam": {"title": title, "question_count": q, "percent_bp": bp, "band": band, "correct": c, "incorrect": i, "unanswered": u},
        "topics": topics, "strong_topics": list(strong), "weak_topics": list(weak),
        "incorrect_items": incorrect_items if incorrect_items is not None else [
            {"topic": "Cells", "stem": "Which organelle makes ATP?", "selected_text": "Nucleus", "correct_text": "Mitochondrion", "explanation": "Mitochondria make ATP.", "note": "Powerhouse."}],
        "history": {"data_level": level, "results_total": results_total, "previous_same_exam": [{"percent_bp": p} for p in previous], "topic_history": []},
    }


def plan_context(*, language: str = "en", level: str = "INITIAL", topics: list[dict] | None = None, strong=("Energy",), weak=("Cells",), results=(6250,)) -> dict:
    return {"language": language, "data_level": level, "topics": topics if topics is not None else default_topics(), "strong_topics": list(strong),
            "weak_topics": list(weak), "results": [{"percent_bp": p} for p in results]}


def result_payload(**kw: Any) -> dict:
    chat_kw = {k: kw.pop(k) for k in ("provider", "key", "model") if k in kw}
    return {"request_id": uuid.uuid4().hex, "user_id": "alice", "chat": chat(**chat_kw), "context": result_context(**kw)}


def plan_payload(**kw: Any) -> dict:
    chat_kw = {k: kw.pop(k) for k in ("provider", "key", "model") if k in kw}
    return {"request_id": uuid.uuid4().hex, "user_id": "alice", "chat": chat(**chat_kw), "context": plan_context(**kw)}


def good_analysis(**over: Any) -> LlmAnalysis:
    base = {
        "summary": "You answered 10 of 16 questions correctly (62.5%).",
        "strengths": [{"topic": "Energy", "detail": "6 of 6 correct."}],
        "weaknesses": [{"topic": "Cells", "detail": "A little more practice will help.", "evidence": "3 of 8 correct (37.5%)"}],
        "next_steps": [{"type": "REVIEW_NOTES", "topic": "Cells", "text": "Re-read the notes for Cells for 15 minutes."},
                       {"type": "REVISIT_QUESTIONS", "topic": "Cells", "text": "Retry the questions you missed."}],
        "caveats": ["This is an initial suggestion based on limited results."],
    }
    base.update(over)
    return LlmAnalysis.model_validate(base)


def good_plan(**over: Any) -> LlmPlan:
    base = {
        "headline": "A focused plan based on your results so far.",
        "focus": [{"topic": "Cells", "reason": "3 of 8 correct (37.5%)."}],
        "steps": [{"type": "REVIEW_NOTES", "topic": "Cells", "text": "Re-read your notes on Cells.", "minutes": 15},
                  {"type": "PRACTICE_MCQ", "topic": "Cells", "text": "Generate a short practice set.", "minutes": None}],
        "caveats": ["This is an initial suggestion based on limited results."],
    }
    base.update(over)
    return LlmPlan.model_validate(base)


async def run_analysis_graph(payload: dict, kind: str = "RESULT", *, extra=(), settings=None):
    settings = settings or make_settings()
    reg = ProviderRegistry(settings)
    for p in extra:
        reg.register_for_tests(p)
    body = (ResultBody if kind == "RESULT" else PlanBody).model_validate(payload)
    ctx = make_analysis_context(settings, reg, body, kind)
    out = await run_analysis(ctx)
    return out, reg


def ctx_models(payload: dict) -> ResultContext:
    return ResultContext.model_validate(payload["context"])


def plan_ctx_model(payload: dict) -> PlanContext:
    return PlanContext.model_validate(payload["context"])


__all__ = ["CANARY_KEY", "ctx_models", "good_analysis", "good_plan", "plan_ctx_model", "plan_context", "plan_payload", "result_context",
           "result_payload", "run_analysis_graph", "topic"]
