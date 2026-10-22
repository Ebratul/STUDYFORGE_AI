from __future__ import annotations

from typing import ClassVar

from app.providers import catalogue
from app.providers.base import ModelInfo, Tri
from app.providers.openai_compat import OpenAICompatProvider


class OpenAIProvider(OpenAICompatProvider):
    id: ClassVar[str] = "openai"
    base_url: ClassVar[str] = catalogue.PROVIDERS["openai"].base_url
    supports_embeddings: ClassVar[bool] = True
    stream_usage: ClassVar[bool | None] = True  # stream_options={"include_usage": true}

    def rule_structured(self, model: str) -> Tri:
        if catalogue.OPENAI_STRUCTURED_YES.match(model) and not catalogue.OPENAI_STRUCTURED_NO.search(model):
            return "yes"
        if catalogue.OPENAI_STRUCTURED_NO.search(model):
            return "no"
        return "unknown"

    def drop_sampling(self, model: str) -> bool:
        return catalogue.openai_no_sampling(model)

    def parse_models(self, payload: dict) -> list[ModelInfo]:
        return catalogue.parse_openai_models(payload)
