"""VECTOR_STORE configuration: safe default, strict validation, and no secrets or hosts in error text."""

from __future__ import annotations

import json
import logging

import pytest
from pydantic import ValidationError

from app.config import Settings, parse_pinecone_indexes
from app.errors import AppError, ErrorCode
from app.vectorstore import VectorRuntime
from app.vectorstore.pinecone_store import PineconeStore
from tests.conftest import SERVICE_TOKEN, TEST_DB_URL
from tests.fake_pinecone import API_KEY
from tests.vector_utils import HOST_1536, INDEXES, memory_runtime, vec_settings

SECRET = "pcsk_SUPERSECRETVALUE_0123456789"


def build(**kw) -> Settings:
    base = dict(database_url=TEST_DB_URL, rag_agent_token=SERVICE_TOKEN)
    base.update(kw)
    return Settings(_env_file=None, **base)


def test_default_is_pgvector_and_needs_no_pinecone_settings():
    s = build()
    assert s.vector_store == "pgvector" and s.postgres_vectors and not s.pinecone_writes
    rt = VectorRuntime.from_settings(s)
    assert rt.mode == "pgvector" and rt.pinecone is None and rt.status() == {"mode": "pgvector", "dimensions": None}


@pytest.mark.parametrize("mode", ["dual", "pinecone"])
def test_modes_require_key_prefix_and_indexes(mode):
    with pytest.raises(ValidationError, match="PINECONE_API_KEY"):
        build(vector_store=mode)
    with pytest.raises(ValidationError, match="PINECONE_NAMESPACE_PREFIX"):
        build(vector_store=mode, pinecone_api_key=SECRET)
    with pytest.raises(ValidationError, match="PINECONE_INDEXES is required"):
        build(vector_store=mode, pinecone_api_key=SECRET, pinecone_namespace_prefix="dev")
    assert vec_settings(mode).vector_store == mode


def test_unknown_mode_is_rejected():
    with pytest.raises(ValidationError):
        build(vector_store="qdrant")


@pytest.mark.parametrize("raw,why", [
    ("not json", "valid JSON"),
    ("[]", "JSON object"),
    ("{}", "JSON object"),
    ('{"abc":{"name":"n","host":"h.svc.x.pinecone.io"}}', "digits"),
    ('{"4":{"name":"n","host":"h.svc.x.pinecone.io"}}', "between"),
    ('{"99999":{"name":"n","host":"h.svc.x.pinecone.io"}}', "between"),
    ('{"1536":"nope"}', "string name"),
    ('{"1536":{"name":"UPPER_bad","host":"h.svc.x.pinecone.io"}}', "valid Pinecone index name"),
    ('{"1536":{"name":"ok","host":"evil.example.com"}}', r"\.pinecone\.io"),
    ('{"1536":{"name":"ok","host":"https://attacker.test/x.pinecone.io"}}', r"\.pinecone\.io"),
    ('{"1536":{"name":"ok","host":"h.pinecone.io.evil.com"}}', r"\.pinecone\.io"),
    ('{"1536":{"name":"ok","host":"user:pw@h.svc.x.pinecone.io"}}', r"\.pinecone\.io"),
])
def test_indexes_are_validated(raw, why):
    with pytest.raises(ValueError, match=why):
        parse_pinecone_indexes(raw)


def test_host_scheme_and_slash_are_normalised():
    got = parse_pinecone_indexes(json.dumps({"1536": {"name": "idx", "host": "https://H.svc.aped-1.pinecone.io/"}}))
    assert got[1536].host == "h.svc.aped-1.pinecone.io"


def test_config_errors_never_echo_values():
    with pytest.raises(ValidationError) as e:
        build(vector_store="pinecone", pinecone_api_key=SECRET, pinecone_namespace_prefix="dev",
              pinecone_indexes='{"1536":{"name":"ok","host":"leaky-host.example.com"}}')
    text = str(e.value)
    assert SECRET not in text and "leaky-host" not in text


def test_namespace_prefix_must_be_a_plain_token():
    for bad in ("", "Dev", "a b", "a/b", "-x", "x" * 40, "dev\n"):
        with pytest.raises(ValidationError, match="PINECONE_NAMESPACE_PREFIX"):
            vec_settings("pinecone", pinecone_namespace_prefix=bad)


def test_store_construction_does_no_io_and_exposes_only_sizes():
    store = PineconeStore(vec_settings("pinecone"))
    assert store.supported_dimensions() == [1536] and store.supports(1536) and not store.supports(3072)


def test_namespaces_are_built_in_one_place_from_a_validated_owner():
    per_user = PineconeStore(vec_settings("pinecone"))
    shared = PineconeStore(vec_settings("pinecone", pinecone_namespace_mode="shared"))
    assert per_user.namespace_for("alice") == "dev-u-alice" and shared.namespace_for("alice") == "dev-shared"
    for bad in ("", "a:b", "../x", "a b", "a" * 201, "ünï", "x\n"):
        with pytest.raises(AppError) as e:
            per_user.namespace_for(bad)
        assert e.value.code == ErrorCode.VALIDATION


def test_unsupported_dimension_is_rejected_with_an_actionable_message():
    rt, _ = memory_runtime("pinecone")
    rt.require_dimension(1536)  # ok
    with pytest.raises(AppError) as e:
        rt.require_dimension(3072)
    assert e.value.code == ErrorCode.VECTOR_DIMENSION_UNSUPPORTED and not e.value.retryable
    assert "1536" in e.value.message and "3072" in e.value.message
    pg = VectorRuntime(build())
    pg.require_dimension(3072)  # pgvector mode never restricts the size


def test_pinecone_key_pattern_is_redacted_from_logs():
    from app.redact import scrub

    assert "pcsk_" not in scrub(f"failed with key {SECRET} in header")
    assert API_KEY not in scrub(f"Api-Key: {API_KEY}")


def test_dual_and_pinecone_flags():
    for mode, writes, pg in (("pgvector", False, True), ("dual", True, True), ("pinecone", True, True)):
        s = vec_settings(mode) if mode != "pgvector" else build()
        assert (s.pinecone_writes, s.postgres_vectors) == (writes, pg)  # pinecone keeps the PostgreSQL copy by default: rollback is a flag
    opted_out = vec_settings("pinecone", pinecone_keep_postgres_vectors=False)
    assert (opted_out.pinecone_writes, opted_out.postgres_vectors) == (True, False)
    assert vec_settings("dual", pinecone_keep_postgres_vectors=False).postgres_vectors is True  # dual always writes both
