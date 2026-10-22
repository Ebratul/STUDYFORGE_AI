"""Deterministic chunker: paragraph -> sentence -> word boundaries (Bangla danda aware), page-respecting, with overlap."""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Block:
    text: str
    page: int | None = None
    section: str | None = None


@dataclass(frozen=True)
class Chunk:
    index: int
    content: str
    page: int | None
    section: str | None
    token_count: int


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?।॥])\s+")  # . ! ? and Bangla/Devanagari danda । ॥
_WS = re.compile(r"\s+")


def approx_tokens(text: str) -> int:
    return max(1, -(-len(text) // 4))


def _split_long_words(text: str, limit: int) -> list[str]:
    """Pieces of <= limit chars split on whitespace. Only a single token longer than `limit` is hard-split."""
    out: list[str] = []
    cur = ""
    for w in text.split(" "):
        if not w:
            continue
        while len(w) > limit:  # unavoidable: one 'word' longer than a whole chunk
            if cur:
                out.append(cur)
                cur = ""
            out.append(w[:limit])
            w = w[limit:]
        if not cur:
            cur = w
        elif len(cur) + 1 + len(w) <= limit:
            cur += " " + w
        else:
            out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out


def _units(group_text: str, limit: int) -> list[tuple[str, str]]:
    """-> [(text, separator_before)]; every unit is <= limit chars."""
    units: list[tuple[str, str]] = []
    paragraphs = [p for p in re.split(r"\n\s*\n", group_text) if p.strip()]
    for pi, para in enumerate(paragraphs):
        para = _WS.sub(" ", para).strip()
        sep = "\n\n" if pi > 0 else ""
        if len(para) <= limit:
            units.append((para, sep))
            continue
        first = True
        for sent in _SENTENCE_SPLIT.split(para):
            sent = sent.strip()
            if not sent:
                continue
            pieces = [sent] if len(sent) <= limit else _split_long_words(sent, limit)
            for piece in pieces:
                units.append((piece, sep if first else " "))
                first = False
    return units


def _overlap_text(prev: str, size: int) -> str:
    """Tail of `prev` of at most `size` chars, starting at a sentence start if possible, else a word start."""
    if size <= 0 or not prev:
        return ""
    if len(prev) <= size:
        return prev
    tail = prev[-size:]
    # we cut at len(prev)-size; only a whole word may start the tail
    cut_before = prev[-size - 1]
    if not cut_before.isspace():
        sp = tail.find(" ")
        if sp == -1:
            return ""
        tail = tail[sp + 1 :]
    m = _SENTENCE_SPLIT.search(tail)
    if m and m.end() < len(tail):
        tail = tail[m.end() :]
    return tail.strip()


def _pack(group_text: str, target: int, overlap: int) -> list[str]:
    units = _units(group_text, target)
    chunks: list[str] = []
    cur = ""
    for text, sep in units:
        if not cur:
            cur = text
            continue
        candidate = cur + sep + text
        if len(candidate) <= target:
            cur = candidate
            continue
        chunks.append(cur)
        room = target - len(text) - 1
        ov = _overlap_text(cur, min(overlap, max(room, 0)))
        cur = (ov + " " + text) if ov else text
        if len(cur) > target:  # defensive; cannot happen because of `room`
            cur = text
    if cur.strip():
        chunks.append(cur)
    return [c.strip() for c in chunks if c.strip()]


def chunk_blocks(blocks: list[Block], *, target: int = 3200, overlap: int = 400, by_page: bool = False) -> list[Chunk]:
    """Group blocks (per page when `by_page`, else one group), then pack. Section = section of the group's first block
    that contributed text to the chunk (approximated by the section active where the chunk starts)."""
    if overlap >= target:
        raise ValueError("overlap must be smaller than target")
    groups: list[list[Block]] = []
    for b in blocks:
        if not b.text.strip():
            continue
        if not groups or (by_page and groups[-1][0].page != b.page):
            groups.append([b])
        else:
            groups[-1].append(b)

    out: list[Chunk] = []
    for g in groups:
        g = [Block(text=_norm_block(b.text), page=b.page, section=b.section) for b in g]
        text = "\n\n".join(b.text for b in g)
        pieces = _pack(text, target, overlap)
        # map each piece to the section active at its start by locating it in the block sequence
        starts = _block_starts(g)
        cursor = 0
        for piece in pieces:
            probe = piece[:60]
            pos = text.find(probe, cursor)
            if pos == -1:
                pos = text.find(probe)
            section = _section_at(g, starts, max(pos, 0))
            if pos >= 0:
                cursor = max(cursor, pos + 1)
            out.append(Chunk(index=len(out), content=piece, page=g[0].page, section=section, token_count=approx_tokens(piece)))
    return out


def _norm_block(text: str) -> str:
    paras = [_WS.sub(" ", p).strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    return "\n\n".join(paras)


def _block_starts(g: list[Block]) -> list[int]:
    starts, pos = [], 0
    for b in g:
        starts.append(pos)
        pos += len(b.text) + 2
    return starts


def _section_at(g: list[Block], starts: list[int], pos: int) -> str | None:
    idx = 0
    for i, s in enumerate(starts):
        if s <= pos:
            idx = i
        else:
            break
    return g[idx].section
