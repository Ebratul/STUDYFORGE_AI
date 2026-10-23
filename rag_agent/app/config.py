"""Environment configuration (pydantic-settings), validated at start."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = ROOT / ".env.local"

# Application caps for an embedding vector length (pgvector itself stores up to 16 000). The length is NOT a setting here: the backend names
# the dimension in every request (it owns the per-user configuration), and rag_agent verifies the provider's real output against it.
MIN_EMBEDDING_DIMENSION = 8
MAX_EMBEDDING_DIMENSION = 4096


VECTOR_STORE_MODES = ("pgvector", "dual", "pinecone")

_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$")
_NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,44}[a-z0-9])?$")
_PREFIX_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$")


@dataclass(frozen=True)
class PineconeIndexRef:
    """One pre-created Pinecone index. The host is explicit so normal requests never need control-plane discovery."""

    name: str
    host: str


def parse_pinecone_indexes(raw: str) -> dict[int, PineconeIndexRef]:
    """`{"1536": {"name": "...", "host": "..."}}` -> {1536: PineconeIndexRef}. Messages never contain the configured values.

    The host must be a *.pinecone.io name: the API key is sent to it, so a typo or a hostile value must not be able to redirect the key.
    """
    if not raw.strip():
        raise ValueError("PINECONE_INDEXES is required when VECTOR_STORE is dual or pinecone")
    try:
        data = json.loads(raw)
    except ValueError:
        raise ValueError("PINECONE_INDEXES must be valid JSON") from None
    if not isinstance(data, dict) or not data:
        raise ValueError('PINECONE_INDEXES must be a JSON object such as {"1536":{"name":"...","host":"..."}}')
    out: dict[int, PineconeIndexRef] = {}
    for key, ref in data.items():
        if not isinstance(key, str) or not key.isdigit():
            raise ValueError("PINECONE_INDEXES keys must be embedding dimensions (digits)")
        dim = int(key)
        if not MIN_EMBEDDING_DIMENSION <= dim <= MAX_EMBEDDING_DIMENSION:
            raise ValueError(f"PINECONE_INDEXES dimensions must be between {MIN_EMBEDDING_DIMENSION} and {MAX_EMBEDDING_DIMENSION}")
        if not isinstance(ref, dict) or not isinstance(ref.get("name"), str) or not isinstance(ref.get("host"), str):
            raise ValueError("each PINECONE_INDEXES entry needs a string name and a string host")
        name = ref["name"].strip()
        host = re.sub(r"^https://", "", ref["host"].strip().lower()).rstrip("/")
        if not _NAME_RE.fullmatch(name):
            raise ValueError("a PINECONE_INDEXES name is not a valid Pinecone index name")
        if not _HOST_RE.fullmatch(host) or not host.endswith(".pinecone.io"):
            raise ValueError("a PINECONE_INDEXES host must be an index host name ending in .pinecone.io")
        out[dim] = PineconeIndexRef(name=name, host=host)
    return out


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    app_env: Literal["development", "test", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = Field(8100, ge=1, le=65535)
    database_url: SecretStr = SecretStr("")
    rag_agent_token: SecretStr = SecretStr("")
    allow_mock_provider: bool = False

    max_upload_bytes: int = Field(25 * 1024 * 1024, ge=1024)
    max_pages: int = Field(500, ge=1)
    max_text_chars: int = Field(2_000_000, ge=1000)
    parse_timeout_seconds: float = Field(60, gt=0)
    parse_memory_mb: int = Field(1024, ge=128)
    chunk_target_chars: int = Field(3200, ge=200)
    chunk_overlap_chars: int = Field(400, ge=0)
    provider_timeout_seconds: float = Field(60, gt=0)
    stream_idle_timeout_seconds: float = Field(60, gt=0)
    max_chat_chars: int = Field(60_000, ge=100)
    retrieval_top_k: int = Field(6, ge=1, le=50)
    retrieval_min_similarity: float = Field(0.30, ge=-1, le=1)
    retrieval_max_context_chars: int = Field(12_000, ge=500)
    max_concurrent_ingests: int = Field(2, ge=1)
    ocr_enabled: bool = False
    log_level: str = "INFO"

    # --- vector storage (docs: backend/docs/VECTOR_STORE_SPEC.md). `pgvector` is the default and needs none of the Pinecone settings. ---
    vector_store: Literal["pgvector", "dual", "pinecone"] = "pgvector"
    pinecone_api_key: SecretStr = SecretStr("")
    pinecone_indexes: str = ""  # JSON: {"<dimension>": {"name": "...", "host": "..."}}
    pinecone_namespace_mode: Literal["per-user", "shared"] = "per-user"
    pinecone_namespace_prefix: str = ""  # keeps environments apart inside one index, e.g. "dev" / "prod"
    # pinecone mode only: keep writing each vector to PostgreSQL too (retrieval does not read it). That is what makes "set VECTOR_STORE=pgvector"
    # a complete rollback; set false only once rollback is no longer wanted, to stop storing every vector twice.
    pinecone_keep_postgres_vectors: bool = True
    pinecone_timeout_seconds: float = Field(10, gt=0)
    pinecone_max_retries: int = Field(4, ge=0, le=8)
    pinecone_visibility_timeout_seconds: float = Field(30, ge=0)  # bounded wait for upserted vectors to become queryable (0 = do not wait)
    vector_shadow_timeout_seconds: float = Field(5, gt=0)  # dual mode: budget for the Pinecone comparison query

    langsmith_tracing: bool = False
    langsmith_api_key: SecretStr = SecretStr("")
    langsmith_project: str = "studyforge-rag-agent"
    langsmith_include_content: bool = False

    @field_validator("rag_agent_token")
    @classmethod
    def _token_len(cls, v: SecretStr) -> SecretStr:
        if len(v.get_secret_value()) < 24:
            # never include the value in the message
            raise ValueError("RAG_AGENT_TOKEN must be set and at least 24 characters long")
        return v

    @model_validator(mode="after")
    def _cross(self) -> "Settings":
        if self.chunk_overlap_chars >= self.chunk_target_chars:
            raise ValueError("CHUNK_OVERLAP_CHARS must be smaller than CHUNK_TARGET_CHARS")
        if self.vector_store != "pgvector":
            self.validate_pinecone()
        return self

    def validate_pinecone(self) -> dict[int, PineconeIndexRef]:
        """Checks the Pinecone settings (also used by the backfill script, which runs while VECTOR_STORE is still pgvector)."""
        if not self.pinecone_api_key.get_secret_value().strip():
            raise ValueError("PINECONE_API_KEY is required when VECTOR_STORE is dual or pinecone")
        if not _PREFIX_RE.fullmatch(self.pinecone_namespace_prefix):
            raise ValueError("PINECONE_NAMESPACE_PREFIX is required (lowercase letters, digits and '-', e.g. dev or prod) when VECTOR_STORE is dual or pinecone")
        return parse_pinecone_indexes(self.pinecone_indexes)

    @property
    def pinecone_index_map(self) -> dict[int, PineconeIndexRef]:
        return parse_pinecone_indexes(self.pinecone_indexes)

    @property
    def pinecone_writes(self) -> bool:
        """Vectors are written to Pinecone (dual and pinecone modes)."""
        return self.vector_store in ("dual", "pinecone")

    @property
    def postgres_vectors(self) -> bool:
        """New chunks get their vector in the PostgreSQL embedding column: pgvector and dual modes always, pinecone mode unless opted out."""
        return self.vector_store in ("pgvector", "dual") or (self.vector_store == "pinecone" and self.pinecone_keep_postgres_vectors)

    @property
    def mock_enabled(self) -> bool:
        """The mock provider exists only if explicitly enabled AND never in production."""
        return self.allow_mock_provider and self.app_env != "production"


def load_settings(**overrides: object) -> Settings:
    """Load settings. `.env.local` is read only outside production."""
    env_file = None if os.environ.get("APP_ENV", "development") == "production" else ENV_LOCAL
    return Settings(_env_file=env_file, **overrides)  # type: ignore[call-arg]


@lru_cache
def get_settings() -> Settings:
    return load_settings()


def load_settings_or_exit() -> Settings:
    """Startup path: refuse to start on invalid config, printing field names only (never values)."""
    from pydantic import ValidationError

    try:
        return load_settings()
    except ValidationError as e:
        problems = "; ".join(f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors(include_input=False, include_url=False))
        raise SystemExit(f"Invalid configuration: {problems}") from None
