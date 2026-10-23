"""Deterministic in-memory VectorStore for tests (exact cosine search, with fault injection and call recording)."""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.errors import AppError, ErrorCode
from app.vectorstore.base import Candidate, Identity, VectorRecord, VectorStore, valid_id


class InMemoryVectorStore(VectorStore):
    name = "memory"

    def __init__(self, dimensions: Sequence[int] = (1536,)) -> None:
        self.dimensions = set(dimensions)
        # (owner_id, document_id, chunk_id) -> record
        self.records: dict[tuple[str, str, str], VectorRecord] = {}
        self.calls: list[tuple[str, dict]] = []
        self._faults: dict[str, list[BaseException]] = {}
        # test hook: extra candidates a (misbehaving or compromised) backend returns on every query, before validation
        self.hostile: list[Candidate] = []

    # --------------------------------------------------------------------------- test helpers
    def fail(self, op: str, exc: BaseException, times: int = 1) -> None:
        """Make the next `times` calls of `op` ('upsert' | 'query' | 'delete') raise `exc`."""
        self._faults.setdefault(op, []).extend([exc] * times)

    def _check(self, op: str, **info) -> None:
        self.calls.append((op, info))
        queue = self._faults.get(op)
        if queue:
            raise queue.pop(0)

    def ids(self, owner_id: str | None = None) -> set[str]:
        return {c for (o, _d, c) in self.records if owner_id is None or o == owner_id}

    # --------------------------------------------------------------------------- VectorStore
    def supports(self, dimension: int) -> bool:
        return dimension in self.dimensions

    def supported_dimensions(self) -> list[int]:
        return sorted(self.dimensions)

    async def upsert(self, records: Sequence[VectorRecord]) -> None:
        self._check("upsert", n=len(records))
        for r in records:
            if not (valid_id(r.owner_id) and valid_id(r.document_id)):
                raise AppError(ErrorCode.VALIDATION, "Invalid owner or document id.")
            if not self.supports(r.identity.dimension):
                raise AppError(ErrorCode.VECTOR_DIMENSION_UNSUPPORTED)
            if len(r.values) != r.identity.dimension:
                raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
            if any(not math.isfinite(x) for x in r.values):
                raise AppError(ErrorCode.PROVIDER_ERROR, "The AI provider returned an unexpected embedding response.", retryable=False)
            self.records[(r.owner_id, r.document_id, r.id)] = r

    async def query(self, *, owner_id, document_ids, vector, identity: Identity, top_k, versions=None) -> list[Candidate]:
        self._check("query", owner=owner_id, docs=list(document_ids))
        if not self.supports(identity.dimension):
            raise AppError(ErrorCode.VECTOR_DIMENSION_UNSUPPORTED)
        if len(vector) != identity.dimension:
            raise AppError(ErrorCode.EMBEDDING_DIMENSION_MISMATCH, retryable=False)
        docs = set(document_ids)
        scored: list[Candidate] = []
        for (o, d, c), r in self.records.items():
            if o != owner_id or d not in docs or r.identity != identity:
                continue
            if versions is not None and r.processing_version not in set(versions):
                continue
            scored.append(Candidate(c, _cosine(vector, r.values)))
        scored.sort(key=lambda x: (-x.score, x.chunk_id))
        return [*self.hostile, *scored[:top_k]]

    async def delete_document(self, *, owner_id, document_id) -> int:
        self._check("delete", scope="document")
        gone = [k for k in self.records if k[0] == owner_id and k[1] == document_id]
        for k in gone:
            del self.records[k]
        return len(gone)

    async def delete_user(self, *, owner_id, document_ids=()) -> int:
        self._check("delete", scope="user")
        gone = [k for k in self.records if k[0] == owner_id]
        for k in gone:
            del self.records[k]
        return len(gone)

    async def delete_identity(self, *, owner_id, identity: Identity, chunks, verify: bool = True) -> int:
        self._check("delete", scope="identity")
        want = set(chunks)
        gone = [k for k, r in self.records.items() if k[0] == owner_id and (k[1], k[2]) in want and r.identity == identity]
        for k in gone:
            del self.records[k]
        return len(gone)

    async def count_document(self, *, owner_id, document_id, dimension) -> int | None:
        return sum(1 for (o, d, _c), r in self.records.items() if o == owner_id and d == document_id and r.identity.dimension == dimension)


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0
