"""Pure text helpers shared by the generation validators (no I/O)."""

from __future__ import annotations

import re
import unicodedata

_WS = re.compile(r"\s+")
_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean(text: str | None) -> str:
    """NFC, control characters removed (newline/tab kept), edges trimmed. None -> ''."""
    if not text:
        return ""
    return _CTRL.sub("", unicodedata.normalize("NFC", str(text))).strip()


def norm_loose(text: str) -> str:
    """NFKC, casefolded, punctuation/symbols stripped, whitespace collapsed. Used for duplicate detection."""
    t = unicodedata.normalize("NFKC", text).replace("​", "").casefold()
    t = "".join(" " if unicodedata.category(ch)[0] in ("P", "S") else ch for ch in t)
    return _WS.sub(" ", t).strip()


def tokens(text: str) -> list[str]:
    """Words = runs of letters/digits/combining marks (Bangla vowel signs stay inside words)."""
    out: list[str] = []
    cur: list[str] = []
    for ch in norm_loose(text):
        if unicodedata.category(ch)[0] in ("L", "N", "M"):
            cur.append(ch)
        elif cur:
            out.append("".join(cur))
            cur = []
    if cur:
        out.append("".join(cur))
    return out


def token_set(text: str) -> frozenset[str]:
    return frozenset(tokens(text))


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def is_bangla(ch: str) -> bool:
    return "ঀ" <= ch <= "৿"


def script_ratios(text: str) -> tuple[float, float]:
    """-> (bangla_share, latin_share) of the letters in `text` (0.0, 0.0 when there are no letters)."""
    bn = latin = total = 0
    for ch in unicodedata.normalize("NFC", text):
        cat = unicodedata.category(ch)
        if is_bangla(ch) and cat[0] in ("L", "M"):
            bn += 1
            total += 1
        elif cat[0] == "L":
            total += 1
            if ch.isascii() or "LATIN" in unicodedata.name(ch, ""):
                latin += 1
    return (bn / total, latin / total) if total else (0.0, 0.0)


def truncate_words(text: str, limit: int) -> str:
    """Cut at a word boundary (never mid-word) with an ellipsis."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    sp = cut.rfind(" ")
    if sp > limit * 0.6:
        cut = cut[:sp]
    return cut.rstrip(" ,;:.") + "…"
