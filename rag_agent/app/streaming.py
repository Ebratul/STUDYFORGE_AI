"""Disconnect-aware streaming.

Starlette (ASGI >= 2.4) only notices that a client went away when it next tries to WRITE. A request that is blocked
waiting on a slow upstream provider (or a long embedding call) would therefore keep running after the client left.
`with_disconnect` runs the source in ONE background task (so context variables stay consistent), watches for
`http.disconnect`, and cancels the source promptly, which cancels the provider HTTP call and rolls back DB work.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, TypeVar

from starlette.requests import Request

T = TypeVar("T")
_END = object()


class _Failure:
    def __init__(self, exc: BaseException) -> None:
        self.exc = exc


async def wait_for_disconnect(request: Request) -> None:
    while True:
        message = await request.receive()
        if message["type"] == "http.disconnect":
            return


async def with_disconnect(request: Request, source: AsyncIterator[T]) -> AsyncIterator[T]:
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=64)

    async def producer() -> None:
        try:
            async for item in source:
                await queue.put(item)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001  re-raised in the consumer
            await queue.put(_Failure(exc))
        else:
            await queue.put(_END)

    prod = asyncio.ensure_future(producer())
    disc = asyncio.ensure_future(wait_for_disconnect(request))
    try:
        while True:
            getter = asyncio.ensure_future(queue.get())
            try:
                done, _ = await asyncio.wait({getter, disc}, return_when=asyncio.FIRST_COMPLETED)
            except asyncio.CancelledError:
                getter.cancel()
                raise
            if getter not in done:
                getter.cancel()
                return  # client disconnected: the finally block cancels the producer
            item = getter.result()
            if item is _END:
                return
            if isinstance(item, _Failure):
                raise item.exc
            yield item
    finally:
        disc.cancel()
        prod.cancel()
        await asyncio.gather(prod, disc, return_exceptions=True)
        aclose = getattr(source, "aclose", None)
        if aclose is not None:
            try:
                await aclose()
            except BaseException:  # noqa: BLE001
                pass
