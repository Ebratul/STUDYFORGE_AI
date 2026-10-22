from __future__ import annotations

from typing import ClassVar

import httpx

from app.errors import ErrorCode, ProviderError
from app.providers import catalogue
from app.providers.base import ModelInfo
from app.providers.openai_compat import OpenAICompatProvider


class OpenRouterProvider(OpenAICompatProvider):
    id: ClassVar[str] = "openrouter"
    base_url: ClassVar[str] = catalogue.PROVIDERS["openrouter"].base_url
    supports_embeddings: ClassVar[bool] = True
    stream_usage: ClassVar[bool | None] = False  # usage arrives in the final chunk without stream_options
    token_param: ClassVar[str] = "max_tokens"  # the parameter OpenRouter documents
    # HTTP-Referer / X-Title are optional (attribution only). We send a title, never a referer.
    extra_headers: ClassVar[dict[str, str]] = {"X-Title": "StudyForge AI"}

    def parse_models(self, payload: dict) -> list[ModelInfo]:
        return catalogue.parse_openrouter_models(payload)

    async def _check_credentials(self, client: httpx.AsyncClient, headers: dict[str, str]) -> None:
        # GET /models is public on OpenRouter, so it proves nothing about the key. GET /key is authenticated.
        await self._get_json(client, "/key", headers, where="models")

    async def _fetch_models(self, client: httpx.AsyncClient, headers: dict[str, str]) -> list[ModelInfo]:
        data = await self._get_json(client, "/models", headers, where="models")
        models = catalogue.parse_openrouter_models(data)
        try:
            emb = await self._get_json(client, "/embeddings/models", headers, where="models")
            models += catalogue.parse_openrouter_models(emb, embeddings_listing=True)
        except ProviderError as exc:
            if exc.code == ErrorCode.PROVIDER_AUTH_INVALID:
                raise
        except httpx.HTTPError:
            pass
        return models
