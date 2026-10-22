"""Analysis endpoints (PART5_SPEC §6): JSON, bearer-protected. Nothing is persisted here; the backend owns persistence."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.analysis.schemas import PlanBody, ResultBody
from app.errors import AppError, ErrorCode
from app.graphs.analysis import make_analysis_context, run_analysis
from app.logging import request_id_var
from app.security import require_service_token
from app.streaming import wait_for_disconnect

log = logging.getLogger("rag.analysis")
router = APIRouter(prefix="/v1/analyze", dependencies=[Depends(require_service_token)])


async def _run(request: Request, body: ResultBody | PlanBody, kind: str):
    app = request.app
    request_id_var.set(body.request_id[:64])
    ctx = make_analysis_context(app.state.settings, app.state.registry, body, kind)
    work = asyncio.ensure_future(run_analysis(ctx))
    gone = asyncio.ensure_future(wait_for_disconnect(request))
    try:
        done, _ = await asyncio.wait({work, gone}, return_when=asyncio.FIRST_COMPLETED)
        if work not in done:  # client went away: cancel the provider call promptly
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)
            return JSONResponse(AppError(ErrorCode.INTERNAL, "Client closed the request.").body(), status_code=499)
        return work.result()  # raises AppError -> the app-level handler renders the standard error shape
    finally:
        gone.cancel()
        if not work.done():
            work.cancel()
        await asyncio.gather(work, gone, return_exceptions=True)


@router.post("/result")
async def analyze_result(body: ResultBody, request: Request):
    return await _run(request, body, "RESULT")


@router.post("/plan")
async def analyze_plan(body: PlanBody, request: Request):
    return await _run(request, body, "PLAN")
