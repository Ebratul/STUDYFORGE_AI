"""Async psycopg3 pool with the pgvector adapter.

The service only touches "Document" (SELECT, UPDATE "processingVersion") and "DocumentChunk"
(SELECT/INSERT/DELETE). It never creates or alters tables: the schema belongs to Prisma.
"""

from __future__ import annotations

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool
from pgvector.psycopg import register_vector_async


async def _configure(conn: AsyncConnection) -> None:
    await register_vector_async(conn)
    await conn.commit()


def make_pool(database_url: str, *, min_size: int = 1, max_size: int = 10) -> AsyncConnectionPool:
    return AsyncConnectionPool(
        database_url,
        min_size=min_size,
        max_size=max_size,
        open=False,
        configure=_configure,
        kwargs={"autocommit": False},
        timeout=10,
        name="rag-agent",
    )


async def ping(pool: AsyncConnectionPool) -> bool:
    try:
        async with pool.connection(timeout=3) as conn:
            cur = await conn.execute("SELECT 1")
            await cur.fetchone()
        return True
    except Exception:  # noqa: BLE001
        return False
