"""Vector storage abstraction.

PostgreSQL stays the system of record for chunk text, ownership, status and versions. A VectorStore only holds vectors and answers
"which chunk ids are nearest to this query vector" (a CANDIDATE list). Nothing a store returns is trusted: callers validate every
candidate against PostgreSQL (owner, authorised documents, current processing version, READY, embedding identity) before use.
"""

from __future__ import annotations

import hashlib
import re
from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Identity:
    """provider + model + dimension: two vectors are comparable only when all three are equal."""

    provider: str
    model: str
    dimension: int


@dataclass(frozen=True)
class VectorRecord:
    """`id` is the DocumentChunk id. It is stable: the same document, version, identity and chunk index always give the same id."""

    id: str
    document_id: str
    owner_id: str
    processing_version: int
    identity: Identity
    values: Sequence[float]


@dataclass(frozen=True)
class Candidate:
    chunk_id: str
    score: float  # cosine similarity (higher = closer)


_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")


def valid_id(value: object) -> bool:
    """Owner / document ids are interpolated into vector ids and namespaces, so they must be plain tokens (cuid-like)."""
    return isinstance(value, str) and _ID_RE.fullmatch(value) is not None


def chunk_id(document_id: str, processing_version: int, identity: Identity, chunk_index: int) -> str:
    """Deterministic chunk id (32 hex chars, the same shape as the uuid4 hex ids written before this existed).

    Re-running the same ingest or re-index step reproduces the same ids, so vector upserts and PostgreSQL inserts are idempotent.
    The identity is part of the input because an active and a staged chunk set of one document version must not collide.
    """
    raw = "\x1f".join([document_id, str(processing_version), identity.provider, identity.model, str(identity.dimension), str(chunk_index)])
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def vector_key(document_id: str, chunk: str) -> str:
    """The id a vector has inside a store: `{documentId}:{chunkId}` (a document's vectors share a listable prefix)."""
    return f"{document_id}:{chunk}"


def split_key(key: str) -> tuple[str, str] | None:
    doc, sep, chunk = key.partition(":")
    return (doc, chunk) if sep and doc and chunk else None


class VectorStore(ABC):
    """Operations every vector backend supports. All methods are idempotent and scoped by owner."""

    name: str = "abstract"

    @abstractmethod
    def supports(self, dimension: int) -> bool:
        """Can this store hold vectors of exactly `dimension` numbers? (Vectors are never padded or truncated to fit.)"""

    def supported_dimensions(self) -> list[int]:
        """The vector sizes this store can hold, for messages and status (empty = any)."""
        return []

    @abstractmethod
    async def upsert(self, records: Sequence[VectorRecord]) -> None:
        """Insert or overwrite vectors. Returns once they are durable (and, for remote stores, visible to queries)."""

    @abstractmethod
    async def query(self, *, owner_id: str, document_ids: Sequence[str], vector: Sequence[float], identity: Identity, top_k: int,
                    versions: Sequence[int] | None = None) -> list[Candidate]:
        """Nearest vectors for ONE owner, restricted to `document_ids` and one identity, best first. Candidates only: see module doc."""

    @abstractmethod
    async def delete_document(self, *, owner_id: str, document_id: str) -> int:
        """Remove every vector of one document, whatever its version or identity."""

    @abstractmethod
    async def delete_user(self, *, owner_id: str, document_ids: Sequence[str] = ()) -> int:
        """Remove every vector of one user."""

    @abstractmethod
    async def delete_identity(self, *, owner_id: str, identity: Identity, chunks: Sequence[tuple[str, str]], verify: bool = True) -> int:
        """Remove exactly these `(document_id, chunk_id)` pairs, but only those of `identity` that belong to `owner_id`.

        `verify=False` skips the remote ownership/identity check; only for ids the caller itself just wrote (rollback of its own upsert),
        which may not be fetchable yet."""

    async def count_document(self, *, owner_id: str, document_id: str, dimension: int) -> int | None:
        """Number of vectors stored for a document (None = this store cannot tell). Used by verification, never by serving."""
        return None

    async def aclose(self) -> None:  # pragma: no cover - default no-op
        return None
