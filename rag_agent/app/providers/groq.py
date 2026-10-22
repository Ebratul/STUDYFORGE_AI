from __future__ import annotations

from typing import ClassVar

from app.providers import catalogue
from app.providers.base import ModelInfo, Tri
from app.providers.openai_compat import OpenAICompatProvider


class GroqProvider(OpenAICompatProvider):
    id: ClassVar[str] = "groq"
    base_url: ClassVar[str] = catalogue.PROVIDERS["groq"].base_url
    supports_embeddings: ClassVar[bool] = False  # no embeddings API (verified 2026-10-22)
    stream_usage: ClassVar[bool | None] = True  # UNVERIFIED against Groq's own docs; usage degrades to null if absent

    def rule_structured(self, model: str) -> Tri:
        return "yes" if catalogue.GROQ_STRUCTURED_YES.match(model) else "unknown"

    def parse_models(self, payload: dict) -> list[ModelInfo]:
        return catalogue.parse_groq_models(payload)
