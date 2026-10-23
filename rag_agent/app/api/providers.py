from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field, SecretStr

from app.logging import request_id_var
from app.providers.validation import ValidateBody, validate_connection
from app.redact import bind_secrets
from app.security import require_service_token

router = APIRouter(prefix="/v1/providers", dependencies=[Depends(require_service_token)])


class ProviderKeyBody(BaseModel):
    provider: str = Field(min_length=1, max_length=32)
    api_key: SecretStr = Field(min_length=1, max_length=4096)


@router.get("")
async def list_providers(request: Request) -> dict:
    return {"providers": request.app.state.registry.catalogue()}


@router.post("/test")
async def test_provider(body: ProviderKeyBody, request: Request) -> dict:
    provider = request.app.state.registry.get(body.provider)
    with bind_secrets([body.api_key.get_secret_value()]):
        res = await provider.test(body.api_key)
    if res.ok:
        return {"ok": True, "latency_ms": res.latency_ms, "models_count": res.models_count}
    return {"ok": False, "code": res.code, "message": res.message, "retryable": bool(res.retryable)}


@router.post("/models")
async def list_models(body: ProviderKeyBody, request: Request) -> dict:
    provider = request.app.state.registry.get(body.provider)
    with bind_secrets([body.api_key.get_secret_value()]):
        models = await provider.list_models(body.api_key)
    return {
        "provider": body.provider,
        "fetched_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "models": [m.model_dump(exclude_none=True) for m in models],
    }


@router.post("/validate")
async def validate_provider(body: ValidateBody, request: Request) -> dict:
    """AI_CONNECTION_SPEC §1: auth -> chat -> embedding, minimal paid calls. Always 200 for a processed request."""
    provider = request.app.state.registry.get(body.provider)  # unknown provider (or mock when disabled) -> 422 VALIDATION
    with bind_secrets([body.api_key.get_secret_value()]):
        res = await validate_connection(provider, body, request.app.state.settings, request_id_var.get(None))
    return res.to_wire()


@router.get("/{provider_id}/public-models")
async def public_models(provider_id: str, request: Request, kind: str = Query("chat", pattern="^(chat|embedding)$")) -> dict:
    """Keyless suggestions from the provider's PUBLIC model listing (no API key is sent or needed). Manual entry always stays possible;
    `available: false` means this provider publishes no listing."""
    provider = request.app.state.registry.get(provider_id)
    fn = getattr(provider, "public_models", None)
    models = await fn(kind) if fn is not None else None
    return {
        "provider": provider_id,
        "kind": kind,
        "available": models is not None,
        "fetched_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "models": models or [],
    }
