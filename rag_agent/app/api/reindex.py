from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request

from app.errors import AppError, ErrorCode
from app.ingest.reindex import ReindexBody, run_reindex
from app.logging import log_event
from app.security import require_service_token

log = logging.getLogger("rag.reindex")
router = APIRouter(prefix="/v1", dependencies=[Depends(require_service_token)])


@router.post("/reindex")
async def reindex(body: ReindexBody, request: Request) -> dict:
    """Re-embeds ONE document's stored chunk texts under body.target and stores them as a second chunk set (the source set is untouched).
    Shares the ingest concurrency limit: embedding is the same kind of work."""
    app = request.app
    settings = app.state.settings
    pool = app.state.pool
    if pool is None:
        raise AppError(ErrorCode.INTERNAL, "Database is not available.")
    app.state.registry.get(body.target.provider)
    if app.state.ingests_active >= settings.max_concurrent_ingests:
        raise AppError(ErrorCode.BUSY, "The service is busy processing other documents. Please retry shortly.", retry_after_seconds=5)
    app.state.ingests_active += 1
    try:
        log_event(log, "reindex_start", document_id=body.document_id, provider=body.target.provider, dimension=body.target.dimension)
        return await run_reindex(pool=pool, registry=app.state.registry, body=body, vectors=app.state.vectors)
    finally:
        app.state.ingests_active -= 1
