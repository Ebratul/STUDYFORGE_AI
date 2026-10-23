"""Per-process vector-store wiring: which mode is active, the Pinecone store (if any), and the checks that guard it."""

from __future__ import annotations

import logging
from typing import Any

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.vectorstore.base import VectorStore

log = logging.getLogger("rag.vectors")

SCHEMA_SQL = """
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'DocumentChunk'
          AND column_name = 'pineconeIndexedAt') AS has_marker,
  (SELECT is_generated FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'DocumentChunk'
   AND column_name = 'embeddingDimension') AS dim_generated
"""


class VectorRuntime:
    """`mode` is one of pgvector | dual | pinecone. `pinecone` is the remote store in dual/pinecone modes and None otherwise."""

    def __init__(self, settings: Settings, pinecone: VectorStore | None = None) -> None:
        self.mode = settings.vector_store
        self.settings = settings
        if self.mode != "pgvector" and pinecone is None:
            raise ValueError("a Pinecone store is required when VECTOR_STORE is dual or pinecone")
        self.pinecone = pinecone if self.mode != "pgvector" else None
        self._schema_ok = False

    @classmethod
    def from_settings(cls, settings: Settings) -> "VectorRuntime":
        if settings.vector_store == "pgvector":
            return cls(settings)
        from app.vectorstore.pinecone_store import PineconeStore  # local import: no HTTP client unless Pinecone is configured

        return cls(settings, PineconeStore(settings))

    @property
    def pinecone_writes(self) -> bool:
        return self.mode in ("dual", "pinecone")

    @property
    def postgres_vectors(self) -> bool:
        """Does a new chunk's vector also go into the PostgreSQL embedding column? (Always in pgvector/dual; pinecone unless opted out.)"""
        return self.settings.postgres_vectors

    def require_dimension(self, dimension: int) -> None:
        """Dual/pinecone modes: refuse sizes the configured index cannot hold, BEFORE any embedding money is spent."""
        if self.pinecone_writes and not self.pinecone.supports(dimension):  # type: ignore[union-attr]
            sizes = ", ".join(map(str, self.pinecone.supported_dimensions())) or "none"  # type: ignore[union-attr]
            raise AppError(ErrorCode.VECTOR_DIMENSION_UNSUPPORTED,
                           f"This installation's document search index supports {sizes}-dimensional vectors only; this embedding setup produces {dimension}. "
                           "Choose an embedding model or size that matches, or ask the administrator to add an index for it.")

    async def ensure_schema(self, pool: AsyncConnectionPool) -> None:
        """Dual/pinecone modes need the vector-store migration (nullable embeddingDimension + pineconeIndexedAt). Cached once true."""
        if self.mode == "pgvector" or self._schema_ok:
            return
        async with pool.connection() as conn:
            await self.check_schema(conn)

    async def check_schema(self, conn: AsyncConnection) -> None:
        """Same check on a connection the caller already holds (retrieval)."""
        if self.mode == "pgvector" or self._schema_ok:
            return
        cur = await conn.execute(SCHEMA_SQL)
        row = await cur.fetchone()
        if not (row and row[0] and row[1] == "NEVER"):
            raise AppError(ErrorCode.VECTOR_STORE_SCHEMA_NOT_READY, retryable=False)
        self._schema_ok = True

    def status(self) -> dict[str, Any]:
        """Safe to expose to the backend: modes and sizes, never hosts, names or keys."""
        return {"mode": self.mode, "dimensions": self.pinecone.supported_dimensions() if self.pinecone else None}

    async def aclose(self) -> None:
        if self.pinecone is not None:
            await self.pinecone.aclose()
