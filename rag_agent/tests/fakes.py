"""Scripted fake provider used by the graph / SSE tests. Counts every LLM call."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from pydantic import BaseModel

from app.citations import CitationIn, GroundedAnswer
from app.errors import ProviderError
from app.providers.base import (
    ChatChunk,
    ChatRequest,
    ChatResult,
    EmbedRequest,
    EmbedResult,
    ModelInfo,
    StructuredResult,
    TestResult,
    Usage,
)
from app.providers.mock import hash_embed


class FakeProvider:
    """structured_script / stream_script entries: GroundedAnswer | Exception | callable(req)->GroundedAnswer."""

    def __init__(self, pid: str = "fake", *, structured_script=None, stream_script=None, embed_error: Exception | None = None) -> None:
        self.id = pid
        self.structured_script = list(structured_script or [])
        self.stream_script = list(stream_script or [])
        self.embed_error = embed_error
        self.llm_calls = 0
        self.structured_requests: list[ChatRequest] = []
        self.stream_requests: list[ChatRequest] = []
        self.embed_calls = 0
        self.stream_closed = False
        self.stream_cancelled = False

    async def test(self, api_key):
        return TestResult(ok=True, latency_ms=1, models_count=0)

    async def list_models(self, api_key) -> list[ModelInfo]:
        return []

    def normalize_error(self, exc):
        return exc

    async def generate(self, req: ChatRequest) -> ChatResult:
        self.llm_calls += 1
        return ChatResult(text="plain")

    async def generate_structured(self, req: ChatRequest, schema: type[BaseModel]) -> StructuredResult:
        self.llm_calls += 1
        self.structured_requests.append(req)
        item = self.structured_script.pop(0) if len(self.structured_script) > 1 else self.structured_script[0]
        if callable(item):
            item = item(req)
        if isinstance(item, Exception):
            raise item
        return StructuredResult(parsed=item, usage=Usage(prompt_tokens=10, completion_tokens=5, total_tokens=15), method="native")

    async def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]:
        self.llm_calls += 1
        self.stream_requests.append(req)
        script = self.stream_script[0] if self.stream_script else ["ok"]
        try:
            for item in script:
                if isinstance(item, Exception):
                    raise item
                if item == "__sleep__":
                    await asyncio.sleep(30)
                    continue
                await asyncio.sleep(0)
                yield ChatChunk(delta=item)
            yield ChatChunk(done=True, usage=Usage(prompt_tokens=7, completion_tokens=3, total_tokens=10), finish_reason="stop")
        except asyncio.CancelledError:
            self.stream_cancelled = True
            raise
        finally:
            self.stream_closed = True

    async def embed(self, req: EmbedRequest) -> EmbedResult:
        self.embed_calls += 1
        if self.embed_error:
            raise self.embed_error
        return EmbedResult(vectors=[hash_embed(t) for t in req.inputs])


def grounded(answer: str, quote: str, source: int = 1, supported: bool = True) -> GroundedAnswer:
    return GroundedAnswer(answer=answer, supported=supported, citations=[CitationIn(source=source, quote=quote)])
