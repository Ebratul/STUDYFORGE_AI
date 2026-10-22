from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.db import ping

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@router.get("/ready")
async def ready(request: Request):
    pool = request.app.state.pool
    ok = pool is not None and await ping(pool)
    if ok:
        return {"status": "ready"}
    return JSONResponse({"status": "unavailable"}, status_code=503)
