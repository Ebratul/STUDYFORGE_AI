"""Provider registry. `mock` exists only when enabled and never in production."""

from __future__ import annotations

from typing import Any

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.providers import catalogue
from app.providers.base import Provider
from app.providers.gemini import GeminiProvider
from app.providers.groq import GroqProvider
from app.providers.mock import MockProvider
from app.providers.openai import OpenAIProvider
from app.providers.openrouter import OpenRouterProvider


class ProviderRegistry:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._providers: dict[str, Provider] = {
            "openai": OpenAIProvider(settings),
            "openrouter": OpenRouterProvider(settings),
            "groq": GroqProvider(settings),
            "gemini": GeminiProvider(settings),
        }
        if settings.mock_enabled:
            self._providers["mock"] = MockProvider(settings)

    def register_for_tests(self, provider: Provider) -> None:
        """Test hook (not reachable over HTTP): replace/add an adapter, e.g. a scripted fake."""
        self._providers[provider.id] = provider

    def get(self, provider_id: str) -> Provider:
        p = self._providers.get(provider_id)
        if p is None:
            raise AppError(ErrorCode.VALIDATION, "Unknown provider.")
        return p

    def known_ids(self) -> list[str]:
        return list(self._providers)

    def catalogue(self) -> list[dict[str, Any]]:
        metas = [catalogue.PROVIDERS[i] for i in ("openai", "openrouter", "groq", "gemini")]
        if self.settings.mock_enabled:
            metas.append(catalogue.MOCK_META)
        return [
            {
                "id": m.id,
                "name": m.name,
                "docs_url": m.docs_url,
                "key_hint": m.key_hint,
                "capabilities": {
                    "chat": m.chat,
                    "embeddings": m.embeddings,
                    "streaming": True,
                    "structured_output": m.structured_output,
                },
                "embedding_dimensions_note": m.embedding_dimensions_note,
                "verified_at": m.verified_at,
            }
            for m in metas
        ]
