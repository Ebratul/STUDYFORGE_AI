"""Question generation endpoints (PART3_SPEC §7): SSE, bearer-protected. Nothing is persisted here."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.generation.schemas import CqGenBody, McqGenBody
from app.graphs.runner import make_gen_context, run_generation
from app.logging import log_event, request_id_var
from app.security import require_service_token
from app.streaming import with_disconnect

log = logging.getLogger("rag.generation")
router = APIRouter(prefix="/v1/generate", dependencies=[Depends(require_service_token)])


def sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


def _stream(request: Request, body: McqGenBody | CqGenBody, kind: str) -> StreamingResponse:
    app = request.app
    request_id_var.set(body.request_id[:64])
    ctx = make_gen_context(app.state.settings, app.state.registry, app.state.pool, body, kind, app.state.vectors)

    async def gen() -> AsyncIterator[bytes]:
        request_id_var.set(body.request_id[:64])
        log_event(log, "generation_start", request_id=body.request_id, kind=kind, provider=body.chat.provider,
                  documents=len(body.sources.document_ids), grounding=body.grounding, count=body.spec.count)
        try:
            async for event, data in with_disconnect(request, run_generation(ctx)):
                yield sse(event, data)
        finally:
            log_event(log, "generation_end", request_id=body.request_id, kind=kind)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/mcq")
async def generate_mcq(body: McqGenBody, request: Request):
    return _stream(request, body, "MCQ")


@router.post("/cq")
async def generate_cq(body: CqGenBody, request: Request):
    return _stream(request, body, "CQ")
