"""Environment configuration (pydantic-settings), validated at start."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
ENV_LOCAL = ROOT / ".env.local"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    app_env: Literal["development", "test", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = Field(8100, ge=1, le=65535)
    database_url: SecretStr = SecretStr("")
    rag_agent_token: SecretStr = SecretStr("")
    allow_mock_provider: bool = False
    embedding_dimensions: int = 1536

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

    @field_validator("embedding_dimensions")
    @classmethod
    def _dims(cls, v: int) -> int:
        if v != 1536:
            raise ValueError("EMBEDDING_DIMENSIONS must be 1536 (schema uses vector(1536))")
        return v

    @model_validator(mode="after")
    def _cross(self) -> "Settings":
        if self.chunk_overlap_chars >= self.chunk_target_chars:
            raise ValueError("CHUNK_OVERLAP_CHARS must be smaller than CHUNK_TARGET_CHARS")
        return self

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
