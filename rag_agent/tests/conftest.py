from __future__ import annotations

import os
import uuid
from pathlib import Path

import psycopg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.db import make_pool
from app.main import create_app
from app.providers import retry as retry_mod
from app.providers.registry import ProviderRegistry

BACKEND_MIGRATIONS = Path(__file__).resolve().parents[2] / "backend" / "prisma" / "migrations"
DEFAULT_TEST_DB = "postgresql://studyforge:studyforge_dev_only@127.0.0.1:5440/studyforge_rag_test"
TEST_DB_URL = os.environ.get("RAG_TEST_DATABASE_URL", DEFAULT_TEST_DB)
SERVICE_TOKEN = "test-service-token-0123456789-abcdefghij"
CANARY_KEY = "sk-CANARYKEY-do-not-leak-0123456789abcdef"


def _assert_test_db(url: str) -> None:
    # safety: tests drop the public schema, so refuse anything that is not clearly a rag test database
    name = url.rsplit("/", 1)[-1].split("?")[0]
    assert name.endswith("_rag_test") or name == "studyforge_rag_test", f"refusing to reset database {name!r}"


@pytest.fixture(scope="session", autouse=True)
def _db_schema():
    """Drop + recreate `public` and apply backend/prisma/migrations/*/migration.sql in order."""
    _assert_test_db(TEST_DB_URL)
    sql_files = sorted(BACKEND_MIGRATIONS.glob("*/migration.sql"))
    assert sql_files, "no Prisma migrations found"
    with psycopg.connect(TEST_DB_URL, autocommit=True) as conn:
        conn.execute("DROP SCHEMA IF EXISTS public CASCADE")
        conn.execute("CREATE SCHEMA public")
        for f in sql_files:
            conn.execute(f.read_text())
    yield


@pytest.fixture(autouse=True)
def _fast_retries(monkeypatch):
    monkeypatch.setattr(retry_mod, "BASE_DELAY", 0.0)


def make_settings(**kw) -> Settings:
    base = dict(
        app_env="test",
        database_url=TEST_DB_URL,
        rag_agent_token=SERVICE_TOKEN,
        allow_mock_provider=True,
        parse_timeout_seconds=30,
    )
    base.update(kw)
    return Settings(_env_file=None, **base)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest_asyncio.fixture(scope="session")
async def pool(_db_schema):
    p = make_pool(TEST_DB_URL, min_size=1, max_size=6)
    await p.open(wait=True)
    yield p
    await p.close()


@pytest_asyncio.fixture
async def db(pool):
    """Clean tables before each DB test."""
    async with pool.connection() as conn:
        await conn.execute('TRUNCATE "DocumentChunk", "Document", "User" CASCADE')
    yield pool


@pytest.fixture
def registry(settings) -> ProviderRegistry:
    return ProviderRegistry(settings)


@pytest_asyncio.fixture
async def client(settings, pool, registry):
    app = create_app(settings, registry=registry, pool=pool)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://rag.test", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}) as c:
        c.app = app  # type: ignore[attr-defined]
        yield c


async def add_user(conn, uid: str) -> None:
    await conn.execute(
        'INSERT INTO "User" ("id","name","email","updatedAt") VALUES (%s,%s,%s,now()) ON CONFLICT DO NOTHING',
        (uid, uid, f"{uid}@example.test"),
    )


async def add_doc(pool, owner: str, doc_id: str | None = None, *, name: str = "notes.txt", status: str = "READY", version: int = 0) -> str:
    doc_id = doc_id or uuid.uuid4().hex
    async with pool.connection() as conn:
        await add_user(conn, owner)
        await conn.execute(
            'INSERT INTO "Document" ("id","ownerId","name","extension","mimeType","sizeBytes","sha256","storageKey","status","processingVersion","updatedAt") '
            "VALUES (%s,%s,%s,%s,%s,1,%s,%s,%s::\"DocumentStatus\",%s,now())",
            (doc_id, owner, name, name.rsplit(".", 1)[-1], "text/plain", uuid.uuid4().hex, "k/" + doc_id, status, version),
        )
    return doc_id
