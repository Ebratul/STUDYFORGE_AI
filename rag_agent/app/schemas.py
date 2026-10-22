"""Request models shared by the HTTP layer and the graphs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, SecretStr, field_validator

from app.providers.base import ChatParams


class Params(BaseModel):
    temperature: float | None = Field(default=None, ge=0, le=2)
    top_p: float | None = Field(default=None, ge=0, le=1)
    max_output_tokens: int | None = Field(default=None, ge=1, le=32768)

    def to_chat_params(self) -> ChatParams:
        return ChatParams(temperature=self.temperature, top_p=self.top_p, max_output_tokens=self.max_output_tokens)


class ChatConfig(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    api_key: SecretStr
    model: str = Field(min_length=1, max_length=200)
    params: Params = Field(default_factory=lambda: Params())


class EmbeddingConfigIn(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    api_key: SecretStr
    model: str = Field(min_length=1, max_length=200)


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
