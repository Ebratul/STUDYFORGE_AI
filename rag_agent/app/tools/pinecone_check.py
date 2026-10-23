"""Read-only sanity check of the configured Pinecone indexes. Makes live calls ONLY when an operator runs it.

    python -m app.tools.pinecone_check

For every index in PINECONE_INDEXES it asks Pinecone for the index statistics and verifies that the index dimension is EXACTLY the
configured one (vectors are never padded or truncated, so a mismatch would fail every upsert) and, when Pinecone reports it, that the
metric is cosine (retrieval treats the returned score as cosine similarity). Nothing is created, changed or deleted. Exit code 1 on any problem.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from app.config import load_settings
from app.errors import AppError
from app.vectorstore.pinecone_store import PineconeStore


async def check(store: PineconeStore) -> tuple[dict[str, Any], bool]:
    report: dict[str, Any] = {}
    ok = True
    for dim in store.supported_dimensions():
        entry: dict[str, Any] = {"configured_dimension": dim, "problems": []}
        try:
            facts = await store.describe(dim)
        except AppError as e:
            entry["problems"].append(f"could not read the index: {e.code.value}")
        else:
            entry.update(facts)
            if facts["dimension"] != dim:
                entry["problems"].append(f"the index dimension is {facts['dimension']}, not {dim}: every upsert would be rejected")
            if facts["metric"] is None:
                entry["note"] = "Pinecone did not report the metric; confirm in the console that it is cosine"
            elif facts["metric"] != "cosine":
                entry["problems"].append(f"the index metric is {facts['metric']}, but retrieval expects cosine similarity")
            if facts["vector_type"] not in (None, "dense"):
                entry["problems"].append("the index is not a dense index")
        ok = ok and not entry["problems"]
        report[str(dim)] = entry
    return report, ok


async def _amain() -> int:
    store = PineconeStore(load_settings())  # validates every PINECONE_* setting; no network call yet
    try:
        report, ok = await check(store)
    finally:
        await store.aclose()
    json.dump({"ok": ok, "indexes": report}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0 if ok else 1


def main() -> int:
    return asyncio.run(_amain())


if __name__ == "__main__":
    raise SystemExit(main())
