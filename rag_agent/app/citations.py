"""Deterministic answer verification, [n] marker handling and citation building. No LLM involved."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

from app.prompts import CANARY, neutralise
from app.redact import contains_secret

MAX_ANSWER_CHARS = 12_000
MIN_QUOTE_CHARS = 10
MARKER = re.compile(r"\[(\d{1,3})\]")


class CitationIn(BaseModel):
    source: int
    quote: str = ""


class GroundedAnswer(BaseModel):
    answer: str = ""
    supported: bool = False
    citations: list[CitationIn] = Field(default_factory=list)


def norm(text: str) -> str:
    """Whitespace/case/Unicode-NFKC normalisation used for quote matching."""
    t = unicodedata.normalize("NFKC", text).replace("​", "")
    return " ".join(t.casefold().split())


@dataclass
class Verdict:
    ok: bool
    reason: str = ""
    answer: str = ""
    citations: list[dict[str, Any]] = field(default_factory=list)
    leak: bool = False


def has_leak(text: str) -> bool:
    return contains_secret(text, extra=(CANARY,))


def strip_markers(text: str, keep: set[int]) -> str:
    out = MARKER.sub(lambda m: m.group(0) if int(m.group(1)) in keep else "", text)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return re.sub(r"[ \t]+([.,;:!?])", r"\1", out).strip()


def verify_answer(parsed: GroundedAnswer, chunks: list) -> Verdict:
    """chunks: objects with chunk_id, document_id, document_name, page, section, content (document_name comes from the DB)."""
    n = len(chunks)
    blob = parsed.answer + "\n" + "\n".join(c.quote for c in parsed.citations)
    if has_leak(blob):
        return Verdict(False, "leak", leak=True)
    if not parsed.supported:
        return Verdict(False, "unsupported")
    if not parsed.answer.strip():
        return Verdict(False, "empty_answer")
    if len(parsed.answer) > MAX_ANSWER_CHARS:
        return Verdict(False, "answer_too_long")

    normalised = [(norm(c.content), norm(neutralise(c.content))) for c in chunks]
    verified: dict[int, dict[str, Any]] = {}
    for cit in parsed.citations:
        if not (1 <= cit.source <= n) or cit.source in verified:
            continue
        q = norm(cit.quote)
        if not q:
            continue
        raw_n, neut_n = normalised[cit.source - 1]
        if len(q) < min(MIN_QUOTE_CHARS, len(raw_n)):
            continue
        if q in raw_n or q in neut_n:
            c = chunks[cit.source - 1]
            verified[cit.source] = {
                "ordinal": cit.source,
                "document_id": c.document_id,
                "document_name": c.document_name,
                "chunk_id": c.chunk_id,
                "page": c.page,
                "section": c.section,
                "quote": " ".join(cit.quote.split())[:300],
                "quote_verified": True,
            }
    if not verified:
        return Verdict(False, "no_verified_citation")
    answer = strip_markers(parsed.answer, set(verified))
    if not answer:
        return Verdict(False, "empty_answer")
    return Verdict(True, answer=answer, citations=[verified[k] for k in sorted(verified)])


def general_citations(text: str, chunks: list) -> list[dict[str, Any]]:
    """Policy B: keep valid [n] markers; quotes cannot be verified, so quote = first 300 chars and quote_verified=false."""
    seen: list[int] = []
    for m in MARKER.finditer(text):
        k = int(m.group(1))
        if 1 <= k <= len(chunks) and k not in seen:
            seen.append(k)
    out = []
    for k in sorted(seen):
        c = chunks[k - 1]
        out.append(
            {
                "ordinal": k,
                "document_id": c.document_id,
                "document_name": c.document_name,
                "chunk_id": c.chunk_id,
                "page": c.page,
                "section": c.section,
                "quote": " ".join(c.content.split())[:300],
                "quote_verified": False,
            }
        )
    return out
