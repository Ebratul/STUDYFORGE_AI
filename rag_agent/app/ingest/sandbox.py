"""Run the parser in an isolated worker process with a wall-clock timeout and a bounded output size."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import sys
from pathlib import Path

from app.config import Settings
from app.ingest.chunk import Block
from app.ingest.extract import ExtractError, Extracted

WORKER = Path(__file__).with_name("worker.py")


async def run_extract(kind: str, data: bytes, settings: Settings) -> Extracted:
    timeout = settings.parse_timeout_seconds
    out_cap = settings.max_text_chars * 8 + 4 * 1024 * 1024
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-I",
        str(WORKER),
        kind,
        str(settings.max_pages),
        str(settings.max_text_chars),
        str(settings.parse_memory_mb),
        str(int(timeout) + 5),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env={"PATH": os.environ.get("PATH", "")},
        start_new_session=True,  # own process group so the whole tree can be killed
    )

    async def feed() -> None:
        assert proc.stdin is not None
        try:
            proc.stdin.write(data)
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with contextlib.suppress(Exception):
                proc.stdin.close()

    async def read() -> bytes:
        assert proc.stdout is not None
        buf = bytearray()
        while chunk := await proc.stdout.read(65536):
            buf += chunk
            if len(buf) > out_cap:
                raise ExtractError("PARSE_FAILED")
        return bytes(buf)

    try:
        async with asyncio.timeout(timeout):
            _, raw = await asyncio.gather(feed(), read())
            await proc.wait()
    except TimeoutError:
        raise ExtractError("PARSE_TIMEOUT") from None
    finally:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
            with contextlib.suppress(Exception):
                await proc.wait()

    try:
        msg = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise ExtractError("PARSE_FAILED") from None  # crashed / killed by a resource limit
    if not isinstance(msg, dict) or not msg.get("ok"):
        raise ExtractError(str(msg.get("code") or "PARSE_FAILED") if isinstance(msg, dict) else "PARSE_FAILED")
    blocks = [Block(text=b[0], page=b[1], section=b[2]) for b in msg["blocks"]]
    return Extracted(kind=msg["kind"], page_count=msg["page_count"], blocks=blocks, scanned=bool(msg["scanned"]))
