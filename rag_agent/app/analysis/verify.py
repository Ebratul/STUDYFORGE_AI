"""Deterministic verification of analysis/plan output (PART5_SPEC §6). Pure code: no I/O, no model calls.

What it guarantees (and what it does not):
* every topic named in a structured field exists in the supplied context, and strengths / weaknesses only use the
  backend-computed strong / weak lists;
* every number in the text is derivable from the context (counts, percentages rounded to an integer / one decimal /
  two decimals, digits in topic names); advice quantities such as "15 minutes" are allowed in step text only;
* no mastery / trend / "improving" claims unless the backend says `data_level == BASED_ON_HISTORY`;
* sizes, language script, links, step types and leaks are checked.
It does NOT prove the prose is wise or well written, and a model can still phrase true numbers misleadingly.
"""

from __future__ import annotations

import json
import re
import unicodedata
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from app.analysis.schemas import STEP_TYPES, LlmAnalysis, LlmPlan, PlanContext, ResultContext, TopicIn
from app.citations import has_leak
from app.generation.text import clean, script_ratios

# reason codes whose presence means "the content was not grounded in the data" (-> UNGROUNDED_OUTPUT)
UNGROUNDED = {"unknown_topic", "topic_not_allowed", "number_not_in_data", "mastery_claim", "weakness_evidence"}

LIMITS = {"summary": 600, "detail": 300, "evidence": 200, "step": 300, "caveat": 250, "headline": 200, "reason": 250}
MAX_LIST = 4
MAX_STEPS = 5
MIN_STEPS = 2
MAX_CAVEATS = 3
MAX_MINUTES = 180
MAX_ADVICE_QUESTIONS = 30

# Claims of mastery / long-term change / trends that a single exam (or a handful of results) cannot support.
BANNED_PHRASES_EN = (
    "mastery", "mastered", "you have mastered", "consistently", "consistent improvement", "steadily", "improving", "improved", "has improved",
    "improvement over time", "progress over time", "long-term", "long term", "trend", "getting better", "getting worse", "upward", "downward",
    "on track to", "always ", "never ", "proves", "proven",
)
BANNED_PHRASES_BN = (
    "আয়ত্ত", "পারদর্শী", "ক্রমাগত", "ধারাবাহিক", "প্রবণতা", "দীর্ঘমেয়াদি", "দীর্ঘমেয়াদী", "উন্নতি হচ্ছে", "উন্নতি করেছ", "ক্রমশ", "প্রমাণ করে", "সবসময়", "কখনোই",
)
_LINK = re.compile(r"(?i)(https?://|www\.|\]\(|<\s*a\b|<\s*/|data:|javascript:)")
_NUM = re.compile(r"(?<![\d.,])(\d+(?:[.,]\d+)*)")
_ADVICE = re.compile(r"(?i)(\d+)\s*(?:-\s*)?(minutes?|mins?|questions?|মিনিট|টি\s*প্রশ্ন|প্রশ্ন)")


# ----------------------------------------------------------------------------------------------------------- helpers
def canon(s: str) -> str:
    return " ".join(unicodedata.normalize("NFC", s).replace("​", "").casefold().split())


def to_ascii_digits(s: str) -> str:
    out = []
    for ch in s:
        if ch.isdigit() and not ch.isascii():
            try:
                out.append(str(unicodedata.decimal(ch)))
                continue
            except ValueError:
                pass
        out.append(ch)
    return "".join(out)


def _dec(token: str) -> Decimal | None:
    t = token
    if "," in t:
        parts = t.split(",")
        t = "".join(parts) if all(len(p) == 3 for p in parts[1:]) and 1 <= len(parts[0]) <= 3 else t.replace(",", ".")
    try:
        return Decimal(t).normalize()
    except Exception:  # noqa: BLE001
        return None


def pct_forms(bp: int) -> set[Decimal]:
    """Every way the percentage may be quoted: exact (2 dp), 1 dp and integer, round half up."""
    p = Decimal(bp) / 100
    return {p.normalize(), p.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP).normalize(), p.quantize(Decimal("1"), rounding=ROUND_HALF_UP).normalize()}


def _ints(*vals: int) -> set[Decimal]:
    return {Decimal(v).normalize() for v in vals}


def allowed_numbers(ctx: ResultContext | PlanContext) -> set[Decimal]:
    allowed = _ints(0, 100)
    for t in ctx.topics:
        allowed |= _ints(t.questions, t.correct, t.incorrect, t.unanswered) | pct_forms(t.accuracy_bp)
        allowed |= _digits_in(t.topic)
    if isinstance(ctx, ResultContext):
        e = ctx.exam
        allowed |= _ints(e.question_count, e.correct, e.incorrect, e.unanswered) | pct_forms(e.percent_bp)
        allowed |= _ints(ctx.history.results_total, len(ctx.history.previous_same_exam))
        for p in ctx.history.previous_same_exam:
            allowed |= pct_forms(p.percent_bp)
        for h in ctx.history.topic_history:
            allowed |= _ints(h.answered) | pct_forms(h.accuracy_bp)
    else:
        allowed |= _ints(len(ctx.results))
        for r in ctx.results:
            allowed |= pct_forms(r.percent_bp)
    return allowed


def _digits_in(text: str) -> set[Decimal]:
    return {d for m in _NUM.findall(to_ascii_digits(text)) if (d := _dec(m)) is not None}


def _strip_topics(text: str, topics: list[str]) -> str:
    out = text
    for t in sorted(topics, key=len, reverse=True):
        out = re.sub(re.escape(t), " ", out, flags=re.I)
    return out


def numbers_in(text: str, topics: list[str], *, allow_advice: bool = False) -> list[Decimal]:
    """Numbers in `text` after removing topic names (they may contain digits) and, for step text, advice quantities."""
    t = to_ascii_digits(_strip_topics(text, topics))
    if allow_advice:
        def _drop(m: re.Match[str]) -> str:
            n = _dec(m.group(1))
            unit = m.group(2).lower()
            limit = MAX_MINUTES if unit.startswith(("min", "মিনিট")) else MAX_ADVICE_QUESTIONS
            return " " if n is not None and n <= limit else m.group(0)
        t = _ADVICE.sub(_drop, t)
    return [d for m in _NUM.findall(t) if (d := _dec(m)) is not None]


def _fmt(d: Decimal) -> str:
    return format(d, "f")


class _Report:
    def __init__(self) -> None:
        self.reasons: list[str] = []

    def add(self, code: str) -> None:
        if code not in self.reasons:
            self.reasons.append(code)

    @property
    def ungrounded(self) -> bool:
        return any(r.split(":", 1)[0] in UNGROUNDED for r in self.reasons)


def _blob(*parts: Any) -> str:
    return json.dumps(parts, ensure_ascii=False, default=str)


def _text(r: _Report, field: str, value: str | None, limit: int, *, topics: list[str], allowed: set[Decimal], advice: bool = False, allow_empty: bool = False) -> str:
    v = clean(value)
    if not v and not allow_empty:
        r.add(f"empty_text:{field}")
        return v
    if len(v) > limit:
        r.add(f"too_long:{field}")
    if _LINK.search(v):
        r.add("link_or_markup")
    for n in numbers_in(v, topics, allow_advice=advice):
        if n not in allowed:
            r.add(f"number_not_in_data:{_fmt(n)}")
    return v


def _claims(texts: list[str], topics: list[str]) -> bool:
    low = _strip_topics(" ".join(texts), topics).casefold()
    return any(p in low for p in BANNED_PHRASES_EN) or any(p in " ".join(texts) for p in BANNED_PHRASES_BN)


def _language_ok(texts: list[str], topics: list[str], language: str) -> bool:
    bn, _latin = script_ratios(_strip_topics(" ".join(texts), topics))
    if language == "bn":
        return bn >= 0.25
    return bn <= 0.3


def _topic(r: _Report, raw: str | None, topic_map: dict[str, str], *, field: str, allowed_keys: set[str] | None, nullable: bool) -> str | None:
    if raw is None or not clean(raw):
        if not nullable:
            r.add(f"unknown_topic:{field}")
        return None
    key = canon(raw)
    if key not in topic_map:
        r.add(f"unknown_topic:{field}")
        return None
    if allowed_keys is not None and key not in allowed_keys:
        r.add(f"topic_not_allowed:{field}")
        return None
    return topic_map[key]


def _steps(r: _Report, steps: list[Any], ctx: ResultContext | PlanContext, topic_map: dict[str, str], topics: list[str], allowed: set[Decimal], *, plan: bool) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if len(steps) > MAX_STEPS:
        r.add("too_many_steps")
    if len(steps) < MIN_STEPS:
        r.add("too_few_steps")
    for s in steps[:MAX_STEPS]:
        if s.type not in STEP_TYPES:
            r.add("bad_step_type")
            continue
        topic = _topic(r, s.topic, topic_map, field="step", allowed_keys=None, nullable=True)
        text = _text(r, "step", s.text, LIMITS["step"], topics=topics, allowed=allowed, advice=True)
        item: dict[str, Any] = {"type": s.type, "topic": topic, "text": text}
        if plan:
            minutes = s.minutes  # type: ignore[union-attr]
            if minutes is not None and not (1 <= minutes <= MAX_MINUTES):
                r.add("bad_minutes")
                minutes = None
            item["minutes"] = minutes
        out.append(item)
    return out


def _caveats(r: _Report, caveats: list[str], topics: list[str], allowed: set[Decimal], data_level: str) -> list[str]:
    if len(caveats) > MAX_CAVEATS:
        r.add("too_many_caveats")
    out = [c for c in (_text(r, "caveat", c, LIMITS["caveat"], topics=topics, allowed=allowed, allow_empty=True) for c in caveats[:MAX_CAVEATS]) if c]
    if data_level != "BASED_ON_HISTORY" and not out:
        r.add("missing_caveat")  # initial suggestions must say so
    return out


def _topic_numbers(t: TopicIn) -> set[Decimal]:
    return _ints(t.questions, t.correct, t.incorrect, t.unanswered) | pct_forms(t.accuracy_bp)


# ----------------------------------------------------------------------------------------------------------- public API
def verify_analysis(out: LlmAnalysis, ctx: ResultContext) -> tuple[dict[str, Any] | None, list[str], bool, bool]:
    """-> (content | None, reasons, ungrounded, leak). `content` is None when anything failed."""
    r = _Report()
    if has_leak(_blob(out.model_dump())):
        return None, ["leak"], False, True
    topics = [t.topic for t in ctx.topics]
    topic_map = {canon(t): t for t in topics}
    allowed = allowed_numbers(ctx)
    stats = {canon(t.topic): t for t in ctx.topics}
    level = ctx.history.data_level

    summary = _text(r, "summary", out.summary, LIMITS["summary"], topics=topics, allowed=allowed)

    if len(out.strengths) > MAX_LIST:
        r.add("too_many_strengths")
    strong_keys = {canon(t) for t in ctx.strong_topics}
    strengths, seen = [], set()
    for s in out.strengths[:MAX_LIST]:
        topic = _topic(r, s.topic, topic_map, field="strength", allowed_keys=strong_keys, nullable=False)
        detail = _text(r, "detail", s.detail, LIMITS["detail"], topics=topics, allowed=allowed)
        if topic and canon(topic) not in seen:
            seen.add(canon(topic))
            strengths.append({"topic": topic, "detail": detail})

    if len(out.weaknesses) > MAX_LIST:
        r.add("too_many_weaknesses")
    weak_keys = {canon(t) for t in ctx.weak_topics}
    weaknesses, seen = [], set()
    for w in out.weaknesses[:MAX_LIST]:
        topic = _topic(r, w.topic, topic_map, field="weakness", allowed_keys=weak_keys, nullable=False)
        detail = _text(r, "detail", w.detail, LIMITS["detail"], topics=topics, allowed=allowed)
        evidence = _text(r, "evidence", w.evidence, LIMITS["evidence"], topics=topics, allowed=allowed)
        if topic:
            own = _topic_numbers(stats[canon(topic)])
            if not any(n in own for n in numbers_in(evidence, topics)):
                r.add("weakness_evidence")  # must quote that topic's own counts/accuracy
            if canon(topic) not in seen:
                seen.add(canon(topic))
                weaknesses.append({"topic": topic, "detail": detail, "evidence": evidence})

    steps = _steps(r, out.next_steps, ctx, topic_map, topics, allowed, plan=False)
    caveats = _caveats(r, out.caveats, topics, allowed, level)

    texts = [summary, *(s["detail"] for s in strengths), *(w["detail"] + " " + w["evidence"] for w in weaknesses), *(s["text"] for s in steps), *caveats]
    if level != "BASED_ON_HISTORY" and _claims(texts, topics):
        r.add("mastery_claim")
    if not _language_ok(texts, topics, ctx.language):
        r.add("wrong_language")
    if has_leak(_blob(texts)):
        return None, ["leak"], False, True
    if r.reasons:
        return None, r.reasons, r.ungrounded, False
    return {"summary": summary, "strengths": strengths, "weaknesses": weaknesses, "next_steps": steps, "caveats": caveats}, [], False, False


def verify_plan(out: LlmPlan, ctx: PlanContext) -> tuple[dict[str, Any] | None, list[str], bool, bool]:
    r = _Report()
    if has_leak(_blob(out.model_dump())):
        return None, ["leak"], False, True
    topics = [t.topic for t in ctx.topics]
    topic_map = {canon(t): t for t in topics}
    allowed = allowed_numbers(ctx)
    level = ctx.data_level

    headline = _text(r, "headline", out.headline, LIMITS["headline"], topics=topics, allowed=allowed)
    if len(out.focus) > MAX_STEPS:
        r.add("too_many_focus")
    focus_keys = {canon(t) for t in ctx.weak_topics} or None  # no weak topics: any listed topic may be a focus
    focus, seen = [], set()
    for f in out.focus[:MAX_STEPS]:
        topic = _topic(r, f.topic, topic_map, field="focus", allowed_keys=focus_keys, nullable=False)
        reason = _text(r, "reason", f.reason, LIMITS["reason"], topics=topics, allowed=allowed)
        if topic and canon(topic) not in seen:
            seen.add(canon(topic))
            focus.append({"topic": topic, "reason": reason})
    steps = _steps(r, out.steps, ctx, topic_map, topics, allowed, plan=True)
    caveats = _caveats(r, out.caveats, topics, allowed, level)

    texts = [headline, *(f["reason"] for f in focus), *(s["text"] for s in steps), *caveats]
    if level != "BASED_ON_HISTORY" and _claims(texts, topics):
        r.add("mastery_claim")
    if not _language_ok(texts, topics, ctx.language):
        r.add("wrong_language")
    if has_leak(_blob(texts)):
        return None, ["leak"], False, True
    if r.reasons:
        return None, r.reasons, r.ungrounded, False
    return {"headline": headline, "focus": focus, "steps": steps, "caveats": caveats}, [], False, False
