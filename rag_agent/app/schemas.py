"""Request models shared by the HTTP layer and the graphs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator

from app.config import MAX_EMBEDDING_DIMENSION, MIN_EMBEDDING_DIMENSION
from app.providers.base import ChatParams


class Params(BaseModel):
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, ge=0, le=1)
    max_output_tokens: int | None = Field(default=None, ge=1, le=32768)
    frequency_penalty: float | None = Field(default=None, ge=-2, le=2)
    presence_penalty: float | None = Field(default=None, ge=-2, le=2)
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)

    def to_chat_params(self) -> ChatParams:
        return ChatParams(
            temperature=self.temperature,
            top_p=self.top_p,
            max_output_tokens=self.max_output_tokens,
            frequency_penalty=self.frequency_penalty,
            presence_penalty=self.presence_penalty,
            seed=self.seed,
        )


class ChatConfig(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    api_key: SecretStr
    model: str = Field(min_length=1, max_length=200)
    params: Params = Field(default_factory=lambda: Params())


class EmbeddingIdentityIn(BaseModel):
    """provider + model + dimension: two vectors are comparable only when all three are equal."""

    provider: str = Field(min_length=1, max_length=32)
    model: str = Field(min_length=1, max_length=200)
    dimension: int = Field(ge=MIN_EMBEDDING_DIMENSION, le=MAX_EMBEDDING_DIMENSION)


class EmbeddingConfigIn(EmbeddingIdentityIn):
    """Embedding credentials + the dimension the caller expects. The dimension is required: it is never assumed or defaulted."""

    api_key: SecretStr
    # The `dimensions` request parameter to send (verified at validation time); None = send nothing. When set it must equal `dimension`.
    request_dimensions: int | None = Field(default=None, ge=MIN_EMBEDDING_DIMENSION, le=MAX_EMBEDDING_DIMENSION)

    @model_validator(mode="after")
    def _request_matches(self) -> "EmbeddingConfigIn":
        if self.request_dimensions is not None and self.request_dimensions != self.dimension:
            raise ValueError("request_dimensions must equal dimension")
        return self


class Msg(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class RetrievalOpts(BaseModel):
    top_k: int | None = Field(default=None, ge=1, le=50)
    min_similarity: float | None = Field(default=None, ge=-1, le=1)
    max_context_chars: int | None = Field(default=None, ge=500, le=100_000)


class ChatBody(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)
    user_id: str = Field(min_length=1, max_length=200)
    mode: Literal["GENERAL", "DOCUMENT_ONLY"]
    chat: ChatConfig
    embedding: EmbeddingConfigIn | None = None
    messages: list[Msg] = Field(min_length=1, max_length=40)
    document_ids: list[str] = Field(default_factory=list, max_length=50)
    use_documents: bool = True
    retrieval: RetrievalOpts | None = None

    @field_validator("document_ids")
    @classmethod
    def _ids(cls, v: list[str]) -> list[str]:
        for d in v:
            if not d or len(d) > 200:
                raise ValueError("invalid document id")
        return v

    @field_validator("messages")
    @classmethod
    def _last_is_user(cls, v: list[Msg]) -> list[Msg]:
        if v[-1].role != "user":
            raise ValueError("the last message must have role 'user'")
        return v
