from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from app.errors import AppError, ErrorCode
from app.ingest.pipeline import IngestMeta, precheck_document, run_ingest
from app.security import require_service_token
from app.streaming import with_disconnect

log = logging.getLogger("rag.ingest")
router = APIRouter(prefix="/v1", dependencies=[Depends(require_service_token)])


def _ext(filename: str) -> str:
    base = os.path.basename(filename.replace("\\", "/"))
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


@router.post("/ingest")
async def ingest(request: Request, file: UploadFile = File(...), meta: str = Form(...)):
    app = request.app
    settings = app.state.settings
    try:
        parsed = IngestMeta.model_validate(json.loads(meta))
    except (ValueError, ValidationError) as e:
        where = ""
        if isinstance(e, ValidationError):
            where = " Fields: " + ", ".join(".".join(str(x) for x in err["loc"]) for err in e.errors(include_input=False))
        raise AppError(ErrorCode.VALIDATION, f"Invalid 'meta' field.{where}") from None
    # the provider must exist (mock is unknown unless enabled)
    app.state.registry.get(parsed.embedding.provider)

    data = await file.read(settings.max_upload_bytes + 1)
    pool = app.state.pool
    if pool is None:
        raise AppError(ErrorCode.INTERNAL, "Database is not available.")
    await precheck_document(pool, parsed)

    if app.state.ingests_active >= settings.max_concurrent_ingests:
        raise AppError(ErrorCode.BUSY, "The service is busy processing other documents. Please retry shortly.", retry_after_seconds=5)
    app.state.ingests_active += 1

    async def gen() -> AsyncIterator[bytes]:
        try:
            source = run_ingest(
                settings=settings, pool=pool, registry=app.state.registry, meta=parsed, filename_ext=_ext(parsed.filename), data=data,
                vectors=app.state.vectors,
            )
            async for ev in with_disconnect(request, source):
                yield (json.dumps(ev, ensure_ascii=False) + "\n").encode()
        finally:
            app.state.ingests_active -= 1

    return StreamingResponse(gen(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
