"""Deterministic validation of model-produced questions (no LLM involved).

`check_mcq` / `check_cq` turn one provider item into a wire-shape question dict (snake_case, PART3_SPEC §3/§7) or a rejection
reason. Evidence quotes are verified against the text that was actually shown to the model; document names/ids always come
from the retrieved chunk, never from the model. Review reasons are flags for the user, never silent deletions.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
from dataclasses import dataclass, field
from typing import Any

from app.citations import MIN_QUOTE_CHARS, has_leak, norm
from app.generation.schemas import BN_PART_LABELS, EN_PART_LABELS, LEVELS, CqSpec, LlmCq, LlmEvidence, LlmMcq, McqSpec
from app.generation.sources import SourceChunk
from app.generation.text import clean, jaccard, norm_loose, script_ratios, token_set, truncate_words
from app.logging import log_event
from app.prompts import neutralise

log = logging.getLogger("rag.generation")

STEM_MAX = 2000
OPTION_MAX = 500
EXPLANATION_MAX = 2000
NOTE_MAX = 600
STIMULUS_MAX = 3000
PROMPT_MAX = 1000
ANSWER_MAX = 4000
QUOTE_MAX = 1000
TOPIC_MAX = 120
TAG_MAX = 40
TAGS_MAX = 10
NEAR_DUPLICATE = 0.8
NEAR_DUPLICATE_FLAG = 0.65  # accepted but flagged for review
DIFFICULTIES = ("EASY", "MEDIUM", "HARD")

# review reason codes (PART3_SPEC §1)
SOLVER_DISAGREES = "SOLVER_DISAGREES"
EXPLANATION_NAMES_OTHER_OPTION = "EXPLANATION_NAMES_OTHER_OPTION"
KEY_NOT_IN_EVIDENCE = "KEY_NOT_IN_EVIDENCE"
NEAR_DUPLICATE_REASON = "NEAR_DUPLICATE"
LANGUAGE_MISMATCH = "LANGUAGE_MISMATCH"
PART_INSUFFICIENT_EVIDENCE = "PART_INSUFFICIENT_EVIDENCE"
MARKS_ADJUSTED = "MARKS_ADJUSTED"


def new_id(prefix: str = "g", nbytes: int = 6) -> str:
    return f"{prefix}_{secrets.token_hex(nbytes)}"


# ------------------------------------------------------------------------------------------------ duplicates
@dataclass
class DuplicateIndex:
    """Normalised-exact and token-set near-duplicate detection across batches and against `avoid`."""

    seen: list[tuple[str, frozenset[str], str | None]] = field(default_factory=list)

    @classmethod
    def seeded(cls, avoid: list[str]) -> "DuplicateIndex":
        idx = cls()
        for a in avoid:
            idx.add(a)
        return idx

    def check(self, text: str, key_text: str | None = None) -> str | None:
        n = norm_loose(text)
        ts = token_set(text)
        for sn, sts, skey in self.seen:
            if n == sn or jaccard(ts, sts) >= NEAR_DUPLICATE:
                if key_text is not None and skey is not None and norm_loose(key_text) != skey:
                    return "conflicting_duplicate"  # same question, different answer key
                return "duplicate"
        return None

    def nearest(self, text: str) -> float:
        ts = token_set(text)
        return max((jaccard(ts, sts) for _, sts, _ in self.seen), default=0.0)

    def add(self, text: str, key_text: str | None = None) -> None:
        self.seen.append((norm_loose(text), token_set(text), norm_loose(key_text) if key_text is not None else None))


# ------------------------------------------------------------------------------------------------ evidence
def verify_evidence(evidence: list[LlmEvidence], selection: list[SourceChunk]) -> list[dict[str, Any]]:
    """Keep only quotes found verbatim (whitespace/case/NFKC-normalised) in the chunk the model pointed at."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    normalised = [(norm(c.content), norm(neutralise(c.content))) for c in selection]
    for ev in evidence[:8]:
        if not (1 <= ev.source <= len(selection)):
            continue
        q = norm(ev.quote)
        raw_n, neut_n = normalised[ev.source - 1]
        if not q or len(q) < min(MIN_QUOTE_CHARS, len(raw_n)) or (q not in raw_n and q not in neut_n):
            continue
        if (ev.source, q) in seen:
            continue
        seen.add((ev.source, q))
        c = selection[ev.source - 1]
        out.append({
            "document_id": c.document_id, "document_name": c.document_name, "chunk_id": c.chunk_id,
            "page": c.page, "section": c.section, "quote": " ".join(ev.quote.split())[:QUOTE_MAX], "quote_verified": True,
        })
    return out


# ------------------------------------------------------------------------------------------------ small helpers
def normalise_difficulty(raw: str | None, setting: str, position: int) -> str:
    if setting in DIFFICULTIES:
        return setting
    d = (raw or "").strip().upper()
    return d if d in DIFFICULTIES else DIFFICULTIES[position % 3]


def clean_tags(tags: list[str]) -> list[str]:
    out: list[str] = []
    for t in tags:
        t = " ".join(clean(t).casefold().split())[:TAG_MAX].strip()
        if t and t not in out:
            out.append(t)
    return out[:TAGS_MAX]


def language_verdict(text: str, language: str) -> str:
    """'ok' | 'flag' | 'reject'. bn: Bangla share of letters (>=0.3 ok, <0.1 reject). en: Latin share (>=0.5 ok, <0.1 reject)."""
    bn, latin = script_ratios(text)
    if bn == 0.0 and latin == 0.0:
        return "ok"  # no letters (e.g. numeric answers): nothing to judge
    share = bn if language == "bn" else latin
    if share >= (0.3 if language == "bn" else 0.5):
        return "ok"
    return "reject" if share < 0.1 else "flag"


def leaks(*parts: object) -> bool:
    return has_leak(json.dumps(parts, ensure_ascii=False, default=str))


_LABEL_PREFIX = re.compile(r"^(?:option|answer|ans|choice|উত্তর|অপশন|বিকল্প)\s*[:\-]?\s*")
_BN_POS = {c: i for i, c in enumerate("কখগঘঙচ")}
_BN_DIGITS = {c: i for i, c in enumerate("১২৩৪৫৬")}


def _label_key(s: str) -> str:
    t = _LABEL_PREFIX.sub("", " ".join(clean(s).casefold().split()))
    return t.strip(" ()[].:-")


def positional(label: str) -> int | None:
    k = _label_key(label)
    if len(k) == 1:
        if "a" <= k <= "f":
            return ord(k) - 97
        if k in _BN_POS:
            return _BN_POS[k]
        if k in _BN_DIGITS:
            return _BN_DIGITS[k]
        if k.isdigit() and 1 <= int(k) <= 6:
            return int(k) - 1
    return None


def resolve_correct(labels: list[str], correct: str, option_texts: list[str]) -> int | None:
    """Index of the correct option or None. Never guesses: an unresolvable reference is a rejection."""
    n = len(option_texts)
    keys = [_label_key(label) for label in labels]
    ck = _label_key(correct)
    if ck and all(keys) and len(set(keys)) == n and ck in keys:
        return keys.index(ck)
    pos = positional(correct)
    if pos is not None and pos < n:
        return pos
    nc = norm_loose(correct)
    if nc:
        hits = [i for i, t in enumerate(option_texts) if norm_loose(t) == nc]
        if len(hits) == 1:
            return hits[0]
    return None


_EN_NAMED = re.compile(
    r"(?:correct\s+(?:answer|option|choice)|right\s+answer|the\s+answer)\s*(?:is|:|=)\s*\(?(?:option\s+)?([A-F1-6])(?![A-Za-z])"
    r"|\boption\s+\(?([A-F])\)?\s+is\s+(?:the\s+)?correct"
)
_BN_NAMED = re.compile(r"সঠিক\s*(?:উত্তর|অপশন|বিকল্প)\s*(?:হলো|হল|হচ্ছে|:)?\s*\(?([ক-চ১-৬])\)?")


def named_option(explanation: str, n_options: int) -> int | None:
    """Index of the option an explanation declares correct (e.g. 'The correct answer is B'), if it says so explicitly."""
    for m in _EN_NAMED.finditer(explanation):
        tok = m.group(1) or m.group(2)
        idx = ord(tok) - 65 if tok.isalpha() else int(tok) - 1
        if 0 <= idx < n_options:
            return idx
    for m in _BN_NAMED.finditer(explanation):
        tok = m.group(1)
        idx = _BN_POS.get(tok, _BN_DIGITS.get(tok))
        if idx is not None and idx < n_options:
            return idx
    return None


def key_missing_from_evidence(options: list[str], key: int, evidence_text: str) -> bool:
    """True only when the evidence clearly supports a distractor and not the key (heuristic; flags, never rejects)."""
    ev = token_set(evidence_text)
    if not ev:
        return False

    def overlap(t: str) -> float:
        ts = token_set(t)
        return len(ts & ev) / len(ts) if len(ts) >= 2 else -1.0

    k = overlap(options[key])
    if k < 0:
        return False
    best = max((overlap(t) for i, t in enumerate(options) if i != key), default=-1.0)
    return best >= 0.5 and k <= best - 0.4 and k < 0.3


# ------------------------------------------------------------------------------------------------ MCQ
@dataclass(frozen=True)
class McqRules:
    spec: McqSpec
    grounding: str

    @property
    def language(self) -> str:
        return self.spec.language


def check_mcq(item: LlmMcq, rules: McqRules, selection: list[SourceChunk], position: int) -> tuple[dict[str, Any] | None, str | None]:
    """-> (question | None, rejection reason | None)."""
    spec = rules.spec
    stem = clean(item.stem)
    if not stem:
        return None, "empty_stem"
    if len(stem) > STEM_MAX:
        return None, "stem_too_long"
    texts = [clean(o.text) for o in item.options]
    if len(texts) != spec.option_count:
        return None, "wrong_option_count"
    if any(not t for t in texts):
        return None, "empty_option"
    if any(len(t) > OPTION_MAX for t in texts):
        return None, "option_too_long"
    if len({norm_loose(t) for t in texts}) != len(texts):
        return None, "duplicate_options"
    key = resolve_correct([o.label for o in item.options], item.correct_label, texts)
    if key is None:
        return None, "invalid_correct_option"

    explanation = clean(item.explanation) if spec.include_explanations else ""
    note = clean(item.short_note) if spec.include_short_notes else ""
    explanation = truncate_words(explanation, EXPLANATION_MAX)
    note = truncate_words(note, NOTE_MAX)
    if leaks(stem, texts, explanation, note, item.evidence, item.topic, item.tags):
        log_event(log, "security_leak_blocked", logging.WARNING, kind="MCQ")
        return None, "leak"

    reasons: list[str] = []
    verdict = language_verdict(" ".join([stem, *texts, explanation, note]), spec.language)
    if verdict == "reject":
        return None, "wrong_language"
    if verdict == "flag":
        reasons.append(LANGUAGE_MISMATCH)

    refs = verify_evidence(item.evidence, selection) if rules.grounding != "GENERAL" else []
    if rules.grounding == "SOURCE_ONLY" and not refs:
        return None, "no_evidence"

    if explanation:
        named = named_option(explanation, len(texts))
        if named is not None and named != key:
            reasons.append(EXPLANATION_NAMES_OTHER_OPTION)
    if refs and key_missing_from_evidence(texts, key, " ".join(r["quote"] for r in refs)):
        reasons.append(KEY_NOT_IN_EVIDENCE)

    ids = [new_id("o", 4)[2:] for _ in texts]
    q = {
        "id": new_id(), "kind": "MCQ", "language": spec.language, "stem": stem, "stimulus": None,
        "options": [{"id": i, "text": t} for i, t in zip(ids, texts)],
        "correct_option_id": ids[key], "parts": [], "answer": None,
        "explanation": explanation or None, "short_note": note or None,
        "difficulty": normalise_difficulty(item.difficulty, spec.difficulty, position),
        "subject": spec.subject, "topic": truncate_words(clean(item.topic), TOPIC_MAX) or None, "tags": clean_tags(item.tags),
        "marks": round(spec.marks, 2), "negative_marks": round(min(spec.negative_marks, spec.marks), 2),
        "sources": refs, "source_support": "SOURCE_QUOTED" if refs else "MODEL_ONLY", "review_reasons": reasons,
    }
    return q, None


def mcq_dedupe_key(q: dict[str, Any]) -> tuple[str, str]:
    correct = next(o["text"] for o in q["options"] if o["id"] == q["correct_option_id"])
    return q["stem"], correct


# ------------------------------------------------------------------------------------------------ CQ
@dataclass(frozen=True)
class CqRules:
    spec: CqSpec
    grounding: str

    @property
    def part_marks(self) -> list[float]:
        return self.spec.resolved_part_marks()


def _answer(raw, rules: CqRules, selection: list[SourceChunk]) -> tuple[dict[str, Any] | None, str | None]:
    """-> (answer object, None) or (None, reason). Never invents: unsupported SOURCE_ONLY answers become empty INSUFFICIENT_EVIDENCE."""
    text = clean(raw.text) if raw is not None else ""
    if len(text) > ANSWER_MAX:
        return None, "answer_too_long"
    refs = verify_evidence(raw.evidence, selection) if (raw is not None and rules.grounding != "GENERAL") else []
    supported = bool(raw is not None and raw.supported and text and refs)
    if supported:
        return {"text": text, "basis": "SOURCE_SUPPORTED", "sources": refs}, None
    if rules.grounding == "SOURCE_ONLY" or not text:
        return {"text": "", "basis": "INSUFFICIENT_EVIDENCE", "sources": []}, None
    return {"text": text, "basis": "GENERAL_REASONING", "sources": []}, None


def check_cq(item: LlmCq, rules: CqRules, selection: list[SourceChunk], position: int) -> tuple[dict[str, Any] | None, str | None]:
    spec = rules.spec
    with_answers = spec.mode == "WITH_ANSWERS"
    stem = clean(item.stem)
    if not stem:
        return None, "empty_stem"
    if len(stem) > STEM_MAX:
        return None, "stem_too_long"
    stim_setting = spec.effective_stimulus
    stimulus = clean(item.stimulus) or None
    if stim_setting == "required" and not stimulus:
        return None, "missing_stimulus"
    if stim_setting == "none":
        stimulus = None
    if stimulus and len(stimulus) > STIMULUS_MAX:
        return None, "stimulus_too_long"

    marks = rules.part_marks
    parts_in = item.parts
    if spec.structure == "descriptive":
        if parts_in:
            return None, "unexpected_parts"
    elif len(parts_in) != len(marks):
        return None, "wrong_part_count"

    reasons: list[str] = []
    labels = BN_PART_LABELS if spec.language == "bn" else EN_PART_LABELS
    parts: list[dict[str, Any]] = []
    adjusted = False
    any_supported = False
    any_insufficient = False
    for i, p in enumerate(parts_in):
        prompt = clean(p.prompt)
        if not prompt:
            return None, "empty_part_prompt"
        if len(prompt) > PROMPT_MAX:
            return None, "part_prompt_too_long"
        if p.marks > 0 and abs(p.marks - marks[i]) > 0.01:
            adjusted = True
        level = LEVELS[i] if spec.structure == "stimulus_4part" else (p.level.strip().upper() if p.level and p.level.strip().upper() in LEVELS else None)
        ans = None
        if with_answers:
            ans, bad = _answer(p.answer, rules, selection)
            if bad:
                return None, bad
            any_supported |= ans["basis"] == "SOURCE_SUPPORTED"
            any_insufficient |= ans["basis"] == "INSUFFICIENT_EVIDENCE"
        parts.append({"id": new_id("p", 3), "label": labels[i], "level": level, "prompt": prompt, "marks": marks[i], "answer": ans})
    if adjusted:
        reasons.append(MARKS_ADJUSTED)

    answer = None
    if spec.structure == "descriptive" and with_answers:
        answer, bad = _answer(item.answer, rules, selection)
        if bad:
            return None, bad
        any_supported = answer["basis"] == "SOURCE_SUPPORTED"
        any_insufficient = answer["basis"] == "INSUFFICIENT_EVIDENCE"

    if leaks(stem, stimulus, [p["prompt"] for p in parts], [p["answer"] for p in parts], answer, item.evidence, item.topic, item.tags):
        log_event(log, "security_leak_blocked", logging.WARNING, kind="CQ")
        return None, "leak"

    verdict = language_verdict(" ".join([stem, stimulus or "", *[p["prompt"] for p in parts]]), spec.language)
    if verdict == "reject":
        return None, "wrong_language"
    if verdict == "flag":
        reasons.append(LANGUAGE_MISMATCH)

    refs = verify_evidence(item.evidence, selection) if rules.grounding != "GENERAL" else []
    if rules.grounding == "SOURCE_ONLY":
        if with_answers and not any_supported:
            return None, "no_supported_answer"
        if not with_answers and not refs:
            return None, "no_evidence"
    if with_answers and any_insufficient:
        reasons.append(PART_INSUFFICIENT_EVIDENCE)

    quoted = bool(refs) or any_supported
    q = {
        "id": new_id(), "kind": "CQ", "language": spec.language, "stem": stem, "stimulus": stimulus,
        "options": [], "correct_option_id": None, "parts": parts, "answer": answer,
        "explanation": None, "short_note": None,
        "difficulty": normalise_difficulty(item.difficulty, spec.difficulty, position),
        "subject": spec.subject, "topic": truncate_words(clean(item.topic), TOPIC_MAX) or None, "tags": clean_tags(item.tags),
        "marks": round(sum(marks), 2) if marks else round(spec.total_marks, 2), "negative_marks": 0,
        "sources": refs, "source_support": "SOURCE_QUOTED" if quoted else "MODEL_ONLY", "review_reasons": reasons,
    }
    return q, None


def cq_dedupe_text(q: dict[str, Any]) -> str:
    return " ".join([q["stem"], q["stimulus"] or "", *[p["prompt"] for p in q["parts"]]])
