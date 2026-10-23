"""Find (and with --apply remove) Pinecone vectors that have no matching PostgreSQL chunk: leftovers of a crash between the Pinecone write
and the PostgreSQL commit, or of a delete job that was lost. DRY RUN BY DEFAULT.

Such vectors can never be returned to a user (every candidate is validated against PostgreSQL), so this is housekeeping, not a security
control. Run it while no ingest is running: documents that are QUEUED / PROCESSING are skipped because their vectors may be in flight.
Per-user namespace mode only (it lists one user's namespace); name the user with --owner.

    python -m app.tools.reconcile_pinecone --owner USER_ID           # report
    python -m app.tools.reconcile_pinecone --owner USER_ID --apply   # delete the orphans listed in the report
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from psycopg_pool import AsyncConnectionPool

from app.config import load_settings
from app.db import make_pool
from app.vectorstore import Identity, split_key
from app.vectorstore.pinecone_store import PineconeStore


async def reconcile(*, pool: AsyncConnectionPool, store: PineconeStore, owner_id: str, apply: bool) -> dict[str, Any]:
    if not store.per_user:
        raise ValueError("reconcile supports PINECONE_NAMESPACE_MODE=per-user only")
    async with pool.connection() as conn:
        rows = await (await conn.execute('SELECT "id","documentId","embeddingProvider","embeddingModel","embeddingDimension" FROM "DocumentChunk" WHERE "ownerId" = %s', (owner_id,))).fetchall()
        busy = {r[0] for r in await (await conn.execute('SELECT "id" FROM "Document" WHERE "ownerId" = %s AND "status" IN (\'QUEUED\',\'PROCESSING\')', (owner_id,))).fetchall()}
    known = {(r[1], r[0]) for r in rows}
    report: dict[str, Any] = {"mode": "apply" if apply else "dry-run", "orphans": 0, "skipped_in_flight": 0, "deleted": 0, "by_dimension": {}}
    for dim in store.supported_dimensions():
        keys = await store.list_keys(owner_id=owner_id, dimension=dim)
        orphans: list[tuple[str, str]] = []
        for k in keys:
            parts = split_key(k)
            if parts is None:
                continue
            if parts[0] in busy:
                report["skipped_in_flight"] += 1
            elif parts not in known:
                orphans.append(parts)
        report["orphans"] += len(orphans)
        report["by_dimension"][str(dim)] = len(orphans)
        if apply and orphans:
            # the identity is only used to pick the index and (shared mode) to re-check ownership; per-user namespaces need no more
            for i in range(0, len(orphans), 500):
                report["deleted"] += await store.delete_identity(owner_id=owner_id, identity=Identity("", "", dim), chunks=orphans[i : i + 500], verify=False)
    return report


async def _amain(args: argparse.Namespace) -> int:
    settings = load_settings()
    store = PineconeStore(settings)
    if not store.per_user:
        print("reconcile supports PINECONE_NAMESPACE_MODE=per-user only", file=sys.stderr)
        await store.aclose()
        return 2
    pool = make_pool(settings.database_url.get_secret_value(), min_size=1, max_size=2)
    await pool.open(wait=True)
    try:
        rep = await reconcile(pool=pool, store=store, owner_id=args.owner, apply=args.apply)
    finally:
        await pool.close()
        await store.aclose()
    json.dump(rep, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--owner", required=True)
    ap.add_argument("--apply", action="store_true")
    return asyncio.run(_amain(ap.parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
