from __future__ import annotations

from typing import ClassVar

from app.providers import catalogue
from app.providers.base import ModelInfo, Tri
from app.providers.openai_compat import OpenAICompatProvider


class GeminiProvider(OpenAICompatProvider):
    """Google AI Studio through its OpenAI-compatibility layer (fixed endpoint; nothing the user types can choose the destination)."""

    id: ClassVar[str] = "gemini"
    base_url: ClassVar[str] = catalogue.PROVIDERS["gemini"].base_url
    supports_embeddings: ClassVar[bool] = True
    stream_usage: ClassVar[bool | None] = True  # the docs' own streaming example uses stream_options.include_usage; usage degrades to null if absent
    token_param: ClassVar[str] = "max_tokens"  # UNVERIFIED which name the compatibility layer documents; the legacy one is the widely accepted one

    def rule_structured(self, model: str) -> Tri:
        # Strict json_schema rules are not documented for this endpoint: use the prompt-JSON path (with the bounded repair attempt).
        return "unknown"

    def parse_models(self, payload: dict) -> list[ModelInfo]:
        return catalogue.parse_gemini_models(payload)
