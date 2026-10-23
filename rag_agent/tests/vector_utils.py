"""Helpers for the vector-store tests: settings and runtimes for each mode, with no network and no real Pinecone."""

from __future__ import annotations

import json

from app.config import Settings
from app.vectorstore import VectorRuntime
from app.vectorstore.memory import InMemoryVectorStore
from tests.conftest import SERVICE_TOKEN, TEST_DB_URL
from tests.fake_pinecone import API_KEY, FakePinecone

HOST_1536 = "studyforge-1536-abc123.svc.aped-0000-0000.pinecone.io"
INDEXES = json.dumps({"1536": {"name": "studyforge-1536", "host": HOST_1536}})


def vec_settings(mode: str = "pinecone", **kw) -> Settings:
    base = dict(
        app_env="test", database_url=TEST_DB_URL, rag_agent_token=SERVICE_TOKEN, allow_mock_provider=True, parse_timeout_seconds=30,
        vector_store=mode, pinecone_api_key=API_KEY, pinecone_indexes=INDEXES, pinecone_namespace_prefix="dev",
        pinecone_max_retries=3, pinecone_visibility_timeout_seconds=1.0,
    )
    base.update(kw)
    return Settings(_env_file=None, **base)


def memory_runtime(mode: str = "pinecone", dimensions=(1536,), **kw) -> tuple[VectorRuntime, InMemoryVectorStore]:
    store = InMemoryVectorStore(dimensions)
    return VectorRuntime(vec_settings(mode, **kw), store), store


def fake_pinecone() -> FakePinecone:
    return FakePinecone({HOST_1536: 1536})
