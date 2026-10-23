"""Copy the vectors already stored in PostgreSQL into Pinecone. DRY RUN BY DEFAULT.

    python -m app.tools.backfill_pinecone                      # dry run: reports what would be copied; no Pinecone calls, no writes
    python -m app.tools.backfill_pinecone --apply              # copies, verifies, then marks the chunks (pineconeIndexedAt)
    python -m app.tools.backfill_pinecone --apply --resume --state backfill.json

Properties:
  * The existing vectors are reused as they are: the embedding provider is never called, and no vector is padded, truncated or changed.
  * Vector ids are `{documentId}:{existing chunk id}`, so the copy is idempotent: running it again overwrites with identical values.
  * Only READY documents' CURRENT-version chunks are copied. Unknown / mock providers, sizes the index does not hold, and rows whose stored
    dimension disagrees with the vector are SKIPPED and reported, never guessed at.
  * A chunk is marked (pineconeIndexedAt) only after its document's upload was seen in Pinecone. Nothing in PostgreSQL is deleted, and the
    only column written is pineconeIndexedAt. Resume = run it again: marked chunks are not selected.
  * Needs the vector-store migration (reports an error otherwise). Needs PINECONE_* settings for --apply; reading them does not require
    VECTOR_STORE to be changed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.config import Settings, load_settings, parse_pinecone_indexes
from app.db import make_pool
from app.errors import AppError, ErrorCode
from app.vectorstore import Identity, VectorRecord, VectorStore

UNSUPPORTED_PROVIDERS = {"unknown": "unknown-provider", "mock": "mock-provider"}
MAX_CONSECUTIVE_FAILURES = 3

IDENTITY_IN = """ AND (c."embeddingProvider", c."embeddingModel", c."embeddingDimension") IN
  (SELECT * FROM unnest(%(id_p)s::text[], %(id_m)s::text[], %(id_d)s::int[]))"""

ELIGIBLE = """
FROM "DocumentChunk" c JOIN "Document" d ON d."id" = c."documentId"
WHERE d."status" = 'READY' AND c."processingVersion" = d."processingVersion" AND c."ownerId" = d."ownerId"
  AND c."embedding" IS NOT NULL AND c."pineconeIndexedAt" IS NULL
"""

SCHEMA_OK = """
SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'DocumentChunk'
               AND column_name = 'pineconeIndexedAt'),
       (SELECT is_generated FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'DocumentChunk'
        AND column_name = 'embeddingDimension')
"""


@dataclass
class Report:
    apply: bool
    pending: Counter = field(default_factory=Counter)  # (provider, model, dimension) -> chunks waiting
    skipped: Counter = field(default_factory=Counter)  # reason -> chunks
    documents_total: int = 0
    documents_done: int = 0
    chunks_copied: int = 0
    failures: list[dict[str, Any]] = field(default_factory=list)
    incomplete_documents: list[str] = field(default_factory=list)
    last_document_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": "apply" if self.apply else "dry-run",
            "pending_by_identity": [{"provider": p, "model": m, "dimension": d, "chunks": n} for (p, m, d), n in sorted(self.pending.items())],
            "skipped": dict(self.skipped),
            "documents_total": self.documents_total,
            "documents_done": self.documents_done,
            "chunks_copied": self.chunks_copied,
            "failures": self.failures,
            "incomplete_documents": self.incomplete_documents,
            "last_document_id": self.last_document_id,
        }


async def _check_schema(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        row = await (await conn.execute(SCHEMA_OK)).fetchone()
    if not (row and row[0] and row[1] == "NEVER"):
        raise AppError(ErrorCode.VECTOR_STORE_SCHEMA_NOT_READY, "The vector-store migration (20261027090000_pinecone_vector_store) has not been applied to this database.")


def _as_floats(v: Any) -> list[float]:
    """pgvector hands back a Vector (or a numpy array when numpy is installed). Same numbers either way; nothing is rounded or resized."""
    return [float(x) for x in (v.to_list() if hasattr(v, "to_list") else v)]


def _identity_params(identities: list[tuple[str, str, int]]) -> dict[str, list]:
    return {"id_p": [i[0] for i in identities], "id_m": [i[1] for i in identities], "id_d": [i[2] for i in identities]}


def _classify(provider: str, dimension: int | None, supported: set[int] | None) -> str | None:
    """None = copy it; otherwise the reason it is skipped."""
    if provider in UNSUPPORTED_PROVIDERS:
        return UNSUPPORTED_PROVIDERS[provider]
    if dimension is None:
        return "unknown-dimension"
    if supported is None:
        return "no-pinecone-config"
    if dimension not in supported:
        return "unsupported-dimension"
    return None


async def run_backfill(*, pool: AsyncConnectionPool, store: VectorStore | None, supported: set[int] | None, apply: bool = False,
                       owner_id: str | None = None, limit_documents: int | None = None, resume_after: str | None = None,
                       progress: Callable[[Report], None] | None = None) -> Report:
    """`store` may be None for a dry run (no Pinecone client is ever built then)."""
    if apply and store is None:
        raise ValueError("--apply needs a configured Pinecone store")
    await _check_schema(pool)
    report = Report(apply=apply)
    owner_sql = ' AND c."ownerId" = %(owner)s' if owner_id else ""
    params: dict[str, Any] = {"owner": owner_id}

    # 1. What is waiting, grouped by identity; decide per identity whether it can be copied.
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                'SELECT c."embeddingProvider" AS provider, c."embeddingModel" AS model, c."embeddingDimension" AS dim, '
                f'(vector_dims(c."embedding") IS DISTINCT FROM c."embeddingDimension") AS inconsistent, count(*) AS n {ELIGIBLE}{owner_sql} '
                "GROUP BY 1,2,3,4", params)
            groups = await cur.fetchall()
    copyable: list[tuple[str, str, int]] = []
    for g in groups:
        if g["inconsistent"]:
            report.skipped["dimension-mismatch"] += g["n"]
            continue
        why = _classify(g["provider"], g["dim"], supported)
        if why:
            report.skipped[why] += g["n"]
        else:
            report.pending[(g["provider"], g["model"], g["dim"])] += g["n"]
            copyable.append((g["provider"], g["model"], g["dim"]))
    if not apply:
        async with pool.connection() as conn:
            if copyable:
                row = await (await conn.execute(f'SELECT count(DISTINCT c."documentId") {ELIGIBLE}{owner_sql}{IDENTITY_IN}', {**params, **_identity_params(copyable)})).fetchone()
            else:
                row = (0,)
        report.documents_total = int(row[0])
        return report

    # 2. Copy document by document (keyset on document id), verifying each before marking it.
    async with pool.connection() as conn:
        cur = await conn.execute(
            f'SELECT DISTINCT c."documentId", c."ownerId" {ELIGIBLE}{owner_sql}{IDENTITY_IN} '
            'AND (%(after)s::text IS NULL OR c."documentId" > %(after)s) ORDER BY 1', {**params, **_identity_params(copyable), "after": resume_after})
        docs = await cur.fetchall()
    if limit_documents:
        docs = docs[:limit_documents]
    report.documents_total = len(docs)
    consecutive = 0
    for doc_id, owner in docs:
        try:
            copied, complete = await _copy_document(pool, store, supported or set(), owner, doc_id)  # type: ignore[arg-type]
            report.chunks_copied += copied
            report.documents_done += 1
            if not complete:
                report.incomplete_documents.append(doc_id)
            consecutive = 0
        except AppError as e:
            report.failures.append({"document_id": doc_id, "code": e.code.value})
            consecutive += 1
            if consecutive >= MAX_CONSECUTIVE_FAILURES:  # the index is down or the key is wrong: stop instead of failing every document
                report.failures.append({"document_id": None, "code": "ABORTED_AFTER_REPEATED_FAILURES"})
                break
        report.last_document_id = doc_id
        if progress:
            progress(report)
    return report


async def _copy_document(pool: AsyncConnectionPool, store: VectorStore, supported: set[int], owner: str, doc_id: str) -> tuple[int, bool]:
    copied = 0
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                'SELECT c."id", c."processingVersion", c."embeddingProvider" AS provider, c."embeddingModel" AS model, c."embeddingDimension" AS dim, '
                f'c."embedding" AS vec {ELIGIBLE} AND c."documentId" = %s AND c."ownerId" = %s ORDER BY c."embeddingProvider", c."embeddingModel", '
                'c."embeddingDimension", c."chunkIndex"', (doc_id, owner))
            rows = await cur.fetchall()
    by_identity: dict[tuple[str, str, int], list[dict]] = {}
    for r in rows:
        if _classify(r["provider"], r["dim"], supported) is not None or r["vec"] is None:
            continue
        r["vec"] = _as_floats(r["vec"])
        if len(r["vec"]) == r["dim"]:  # a row whose vector and recorded size disagree is never copied
            by_identity.setdefault((r["provider"], r["model"], r["dim"]), []).append(r)
    complete = True
    for (provider, model, dim), group in by_identity.items():
        identity = Identity(provider, model, dim)
        records = [VectorRecord(r["id"], doc_id, owner, r["processingVersion"], identity, r["vec"]) for r in group]
        await store.upsert(records)  # waits until visible; raises AppError(retryable or not) otherwise: nothing is marked then
        seen = await store.count_document(owner_id=owner, document_id=doc_id, dimension=dim)
        if seen is not None and seen < len(records):
            complete = False  # visible count lower than what was just uploaded: do NOT mark, report it
            continue
        async with pool.connection() as conn:
            async with conn.transaction():
                await conn.execute('UPDATE "DocumentChunk" SET "pineconeIndexedAt" = now() WHERE "id" = ANY(%s) AND "ownerId" = %s AND "pineconeIndexedAt" IS NULL',
                                   ([r["id"] for r in group], owner))
        copied += len(records)
    return copied, complete


# ----------------------------------------------------------------------------------------------------------------- CLI
def _print_report(rep: Report, out=None) -> None:
    out = out or sys.stdout
    json.dump(rep.as_dict(), out, indent=2)
    out.write("\n")


async def _amain(args: argparse.Namespace) -> int:
    settings: Settings = load_settings()
    supported: set[int] | None = None
    store: VectorStore | None = None
    if args.apply:
        from app.vectorstore.pinecone_store import PineconeStore

        store = PineconeStore(settings)  # validates every PINECONE_* setting; no network call yet
        supported = set(store.supported_dimensions())
    elif settings.pinecone_indexes.strip():
        supported = set(parse_pinecone_indexes(settings.pinecone_indexes))
    resume_after = None
    state = Path(args.state) if args.state else None
    if args.resume and state and state.exists():
        resume_after = json.loads(state.read_text()).get("last_document_id")
    pool = make_pool(settings.database_url.get_secret_value(), min_size=1, max_size=2)
    await pool.open(wait=True)
    started = time.monotonic()

    def progress(rep: Report) -> None:
        print(f"[{rep.documents_done}/{rep.documents_total}] chunks={rep.chunks_copied} failures={len(rep.failures)} {time.monotonic() - started:.0f}s", file=sys.stderr)
        if state:
            state.write_text(json.dumps({"last_document_id": rep.last_document_id, "chunks_copied": rep.chunks_copied}))

    try:
        rep = await run_backfill(pool=pool, store=store, supported=supported, apply=args.apply, owner_id=args.owner,
                                 limit_documents=args.limit_documents, resume_after=resume_after, progress=progress)
    finally:
        await pool.close()
        if store is not None:
            await store.aclose()
    _print_report(rep)
    if not args.apply:
        print("DRY RUN: nothing was sent to Pinecone and nothing was changed. Re-run with --apply to copy.", file=sys.stderr)
    return 1 if (rep.failures or rep.incomplete_documents) else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="actually copy to Pinecone (default is a dry run)")
    ap.add_argument("--owner", help="only this user's documents")
    ap.add_argument("--limit-documents", type=int, help="stop after N documents (try a small batch first)")
    ap.add_argument("--state", help="progress file (informational; the PostgreSQL marker is what makes a re-run resume)")
    ap.add_argument("--resume", action="store_true", help="continue after the last document recorded in --state")
    return asyncio.run(_amain(ap.parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
