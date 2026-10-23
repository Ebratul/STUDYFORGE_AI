from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.errors import AppError, ErrorCode
from app.graphs.runner import make_context, run_chat
from app.logging import log_event, request_id_var
from app.schemas import ChatBody
from app.security import require_service_token
from app.streaming import with_disconnect

log = logging.getLogger("rag.chat")
router = APIRouter(prefix="/v1/chat", dependencies=[Depends(require_service_token)])


def sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


@router.post("/stream")
async def chat_stream(body: ChatBody, request: Request):
    app = request.app
    settings = app.state.settings
    total = sum(len(m.content) for m in body.messages)
    if total > settings.max_chat_chars:
        raise AppError(ErrorCode.VALIDATION, f"The conversation is too long (max {settings.max_chat_chars} characters).")
    request_id_var.set(body.request_id[:64])
    ctx = make_context(settings, app.state.registry, app.state.pool, body, app.state.vectors)  # unknown provider -> 422 before streaming

    async def gen() -> AsyncIterator[bytes]:
        request_id_var.set(body.request_id[:64])
        log_event(log, "chat_start", request_id=body.request_id, mode=body.mode, provider=body.chat.provider,
                  documents=len(body.document_ids))
        try:
            async for event, data in with_disconnect(request, run_chat(ctx)):
                yield sse(event, data)
        finally:
            log_event(log, "chat_end", request_id=body.request_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
