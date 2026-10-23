"""Provider-neutral request/response types and the adapter Protocol (CONTRACT §1.4)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel, SecretStr

Tri = Literal["yes", "no", "unknown"]
CapabilitySource = Literal["api", "catalogue", "unverified"]


class Usage(BaseModel):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatParams(BaseModel):
    temperature: float | None = None
    top_p: float | None = None
    max_output_tokens: int | None = None


@dataclass
class ChatRequest:
    model: str
    api_key: SecretStr = field(repr=False)
    messages: list[ChatMessage]
    params: ChatParams = field(default_factory=ChatParams)


class ChatResult(BaseModel):
    text: str
    usage: Usage = Usage()
    finish_reason: str | None = None


class ChatChunk(BaseModel):
    """One streamed item. Either a text delta, or the terminal item carrying usage/finish_reason."""

    delta: str = ""
    done: bool = False
    usage: Usage | None = None
    finish_reason: str | None = None


class StructuredResult(BaseModel):
    parsed: BaseModel
    usage: Usage = Usage()
    method: Literal["native", "prompt"] = "prompt"
    repaired: bool = False
    finish_reason: str | None = None

    model_config = {"arbitrary_types_allowed": True}


@dataclass
class EmbedRequest:
    model: str
    api_key: SecretStr = field(repr=False)
    inputs: list[str]


class EmbedResult(BaseModel):
    vectors: list[list[float]]
    usage: Usage = Usage()


class TestResult(BaseModel):
    __test__ = False  # not a pytest class

    ok: bool
    latency_ms: int | None = None
    models_count: int | None = None
    code: str | None = None
    message: str | None = None
    retryable: bool | None = None


class ModelCapabilities(BaseModel):
    chat: bool
    embeddings: bool
    streaming: bool
    structured_output: Tri
    tools: Tri


class ModelInfo(BaseModel):
    id: str
    name: str
    context_length: int | None = None
    capabilities: ModelCapabilities
    capability_source: CapabilitySource
    embedding_dimensions: Literal["compatible", "incompatible", "unknown"] | None = None


@runtime_checkable
class Provider(Protocol):
    id: str

    async def test(self, api_key: SecretStr) -> TestResult: ...
    async def list_models(self, api_key: SecretStr) -> list[ModelInfo]: ...
    async def generate(self, req: ChatRequest) -> ChatResult: ...
    def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]: ...
    async def generate_structured(self, req: ChatRequest, schema: type[BaseModel]) -> StructuredResult: ...
    async def embed(self, req: EmbedRequest) -> EmbedResult: ...
    async def probe_embedding(self, req: EmbedRequest) -> int: ...  # measured vector length of ONE sample (connection validation only)
    def normalize_error(self, exc: BaseException) -> "ProviderErrorT": ...


from app.errors import ProviderError as ProviderErrorT  # noqa: E402  (re-export for the Protocol)
