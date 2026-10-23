from __future__ import annotations

import re
import time
from typing import Any, ClassVar

import httpx

from app.errors import ErrorCode, ProviderError
from app.providers import catalogue
from app.providers.base import ChatParams, ModelInfo
from app.providers.openai_compat import OpenAICompatProvider

PUBLIC_TTL_SECONDS = 600.0
_SAFE_PARAM = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
# process-wide cache of the PUBLIC (keyless) model lists: kind -> (fetched_at, models)
_PUBLIC_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def clear_public_cache() -> None:
    _PUBLIC_CACHE.clear()


def _is_free(pricing: Any) -> bool:
    if not isinstance(pricing, dict):
        return False
    try:
        return float(pricing.get("prompt", "1")) == 0.0 and float(pricing.get("completion", "0") or 0) == 0.0
    except (TypeError, ValueError):
        return False


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

    def routing_extra_body(self, params: ChatParams) -> dict[str, Any] | None:
        # `require_parameters`: route only to providers that honour every parameter we send (otherwise OpenRouter silently drops them).
        return {"provider": {"require_parameters": True}} if params.require_parameters else None

    async def public_models(self, kind: str) -> list[dict[str, Any]] | None:
        """Keyless listing (no Authorization header is sent) cached for ten minutes. kind: "chat" | "embedding"."""
        if kind not in ("chat", "embedding"):
            raise ProviderError(ErrorCode.VALIDATION, "kind must be chat or embedding.")
        hit = _PUBLIC_CACHE.get(kind)
        if hit and time.monotonic() - hit[0] < PUBLIC_TTL_SECONDS:
            return hit[1]
        path = "/models" if kind == "chat" else "/embeddings/models"
        try:
            async with self._client() as client:
                data = await self._get_json(client, path, {"Accept": "application/json"}, where="models")
        except httpx.HTTPError as exc:
            raise self.normalize_error(exc, where="models") from None
        out: list[dict[str, Any]] = []
        for m in data.get("data") or []:
            if not isinstance(m, dict) or not isinstance(m.get("id"), str) or len(m["id"]) > 200:
                continue
            outputs = [str(x) for x in ((m.get("architecture") or {}).get("output_modalities") or [])]
            if kind == "chat" and (("text" not in outputs and outputs) or "embeddings" in outputs):
                continue
            params = m.get("supported_parameters")
            ctx = m.get("context_length")
            out.append(
                {
                    "id": m["id"],
                    "name": m["name"][:120] if isinstance(m.get("name"), str) else m["id"],
                    "context_length": ctx if isinstance(ctx, int) else None,
                    "free": _is_free(m.get("pricing")),
                    # None = the listing does not say (treated as unknown, never as "supported")
                    "supported_parameters": sorted({p for p in params if isinstance(p, str) and _SAFE_PARAM.match(p)}) if isinstance(params, list) else None,
                }
            )
        _PUBLIC_CACHE[kind] = (time.monotonic(), out)
        return out

    async def supported_parameters(self, model: str) -> list[str] | None:
        try:
            models = await self.public_models("chat")
        except Exception:  # noqa: BLE001 - metadata is a hint; the live check still decides
            return None
        for m in models or []:
            if m["id"] == model:
                return m["supported_parameters"]
        return None

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
