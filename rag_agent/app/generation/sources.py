"""Source pool for generation: pasted text -> pseudo-chunks, documents -> topic retrieval or coverage sampling.

Pasted text and document text are untrusted data. Everything that touches the database goes through the same
owner/document/version/READY scoping as chat retrieval (app/retrieval/search.py).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace

from app.errors import AppError, ErrorCode
from app.generation.text import clean
from app.retrieval.search import RetrievedChunk

POOL_MAX_CHUNKS = 36
TOPIC_POOL_K = 24
PASTE_CHUNK_CHARS = 2400
PASTE_NAME = "Pasted text"
MIN_CONTEXT_CHARS = 1200


@dataclass(frozen=True)
class SourceChunk:
    """Duck-compatible with RetrievedChunk (prompts.render_sources reads document_name/page/section/content)."""

    chunk_id: str | None
    document_id: str | None
    document_name: str
    page: int | None
    section: str | None
    content: str
    similarity: float = 0.0


def from_retrieved(c: RetrievedChunk) -> SourceChunk:
    return SourceChunk(c.chunk_id, c.document_id, c.document_name, c.page, c.section, c.content, c.similarity)


_PARA = re.compile(r"\n\s*\n")
_SENT = re.compile(r"(?<=[.!?।])\s+")


def split_pasted(text: str, target: int = PASTE_CHUNK_CHARS) -> list[SourceChunk]:
    """Deterministic: paragraphs are packed up to `target` chars; over-long paragraphs are split at sentence/word boundaries."""
    text = clean(text)
    if not text:
        return []
    pieces: list[str] = []
    for para in _PARA.split(text):
        para = " ".join(para.split())
        if not para:
            continue
        while len(para) > target:
            cut = max((m.end() for m in _SENT.finditer(para[:target])), default=0)
            if cut < target * 0.4:
                cut = para.rfind(" ", 0, target)
            if cut <= 0:
                cut = target
            pieces.append(para[:cut].strip())
            para = para[cut:].strip()
        if para:
            pieces.append(para)
    chunks: list[str] = []
    cur = ""
    for p in pieces:
        if cur and len(cur) + 1 + len(p) > target:
            chunks.append(cur)
            cur = p
        else:
            cur = f"{cur}\n{p}" if cur else p
    if cur:
        chunks.append(cur)
    return [SourceChunk(f"paste:{i}", None, PASTE_NAME, None, None, c) for i, c in enumerate(chunks)]


def context_budget(settings_max: int, context_tokens: int | None, max_output_tokens: int | None) -> int:
    """Characters of source text per LLM call: min(configured, 0.6 * context window * 3 chars - reserved output chars)."""
    budget = settings_max
    if context_tokens:
        reserved = (max_output_tokens or 8000) * 3
        budget = min(budget, int(context_tokens * 0.6 * 3) - reserved)
    return max(MIN_CONTEXT_CHARS, budget)


def select_for_batch(pool: list[SourceChunk], start: int, budget: int) -> tuple[list[SourceChunk], int, bool]:
    """Take chunks from `start` (wrapping) until `budget` chars; always at least one. -> (selection, next_start, truncated)."""
    if not pool:
        return [], 0, False
    out: list[SourceChunk] = []
    used = 0
    truncated = False
    n = len(pool)
    i = start % n
    for taken in range(n):
        c = pool[(i + taken) % n]
        if not out and len(c.content) > budget:
            c = replace(c, content=c.content[:budget])
            truncated = True
        if out and used + len(c.content) > budget:
            break
        out.append(c)
        used += len(c.content)
    return out, (i + len(out)) % n, truncated


# ------------------------------------------------------------------------------------------------ database
_SCOPE = """
  c."ownerId" = %(owner)s
  AND d."ownerId" = %(owner)s
  AND c."documentId" = ANY(%(doc_ids)s)
  AND c."processingVersion" = d."processingVersion"
  AND d."status" = 'READY'
"""

_OUTLINE_SQL = f"""
SELECT c."id", c."documentId", c."chunkIndex",
       row_number() OVER (PARTITION BY c."documentId" ORDER BY c."chunkIndex", c."id") AS rn,
       count(*) OVER (PARTITION BY c."documentId") AS cnt
FROM "DocumentChunk" c JOIN "Document" d ON d."id" = c."documentId"
WHERE {_SCOPE}
ORDER BY c."documentId", rn
"""

_FETCH_SQL = f"""
SELECT c."id" AS chunk_id, c."documentId" AS document_id, d."name" AS document_name, c."page" AS page,
       c."section" AS section, c."content" AS content, c."chunkIndex" AS chunk_index
FROM "DocumentChunk" c JOIN "Document" d ON d."id" = c."documentId"
WHERE {_SCOPE} AND c."id" = ANY(%(chunk_ids)s)
ORDER BY d."name", c."documentId", c."chunkIndex"
"""


def even_picks(cnt: int, k: int) -> list[int]:
    """k distinct 1-based positions spread evenly over 1..cnt (all of them when k >= cnt)."""
    if k >= cnt:
        return list(range(1, cnt + 1))
    return sorted({min(cnt, int((j + 0.5) * cnt / k) + 1) for j in range(k)})


async def sample_chunks(conn, *, owner_id: str, document_ids: list[str], max_chunks: int = POOL_MAX_CHUNKS) -> list[RetrievedChunk]:
    """Deterministic coverage sample (no embedding needed): chunks spread evenly over each authorised document.

    Same isolation as search_chunks: owner on chunk AND document, authorised ids only, current processingVersion, READY.
    """
    from psycopg.rows import dict_row

    if not owner_id or not isinstance(owner_id, str):
        raise AppError(ErrorCode.VALIDATION, "owner_id is required.")
    ids = sorted({d for d in document_ids if isinstance(d, str) and d})
    if not ids:
        return []
    max_chunks = max(1, min(int(max_chunks), 100))
    params = {"owner": owner_id, "doc_ids": ids}
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(_OUTLINE_SQL, params)
        outline = await cur.fetchall()
    per_doc: dict[str, list[tuple[int, str]]] = {}
    for r in outline:
        per_doc.setdefault(r["documentId"], []).append((int(r["rn"]), r["id"]))
    if not per_doc:
        return []
    docs = sorted(per_doc)
    # fair quota: one chunk per document first, then round-robin extra capacity
    quota = {d: 0 for d in docs}
    remaining = max_chunks
    while remaining > 0 and any(quota[d] < len(per_doc[d]) for d in docs):
        for d in docs:
            if remaining > 0 and quota[d] < len(per_doc[d]):
                quota[d] += 1
                remaining -= 1
    chosen: list[str] = []
    for d in docs:
        by_rn = dict(per_doc[d])
        chosen.extend(by_rn[p] for p in even_picks(len(per_doc[d]), quota[d]) if p in by_rn)
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(_FETCH_SQL, {**params, "chunk_ids": chosen})
        rows = await cur.fetchall()
    return [
        RetrievedChunk(r["chunk_id"], r["document_id"], r["document_name"], r["page"], r["section"], r["content"], 0.0, i)
        for i, r in enumerate(rows, start=1)
    ]
