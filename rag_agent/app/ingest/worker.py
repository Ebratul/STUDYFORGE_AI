"""Isolated parser worker: `python -I worker.py <kind> <max_pages> <max_chars> <memory_mb>`; bytes on stdin, one JSON line on stdout.

Runs in its own process so a hostile file can hang or exhaust only this process: the parent enforces a wall-clock timeout
and kills the process group; this process applies RLIMIT_AS / RLIMIT_CPU / RLIMIT_FSIZE / RLIMIT_NOFILE to itself before
touching any untrusted bytes. stderr is discarded by the parent (no document text is ever logged).
"""

from __future__ import annotations

import json
import os
import sys


def _limit(memory_mb: int, cpu_seconds: int) -> None:
    try:
        import resource

        mem = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 2))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))  # no file writes
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    except Exception:  # noqa: BLE001  (non-POSIX): the parent's wall-clock kill still applies
        pass


def main() -> int:
    kind, max_pages, max_chars, memory_mb, cpu_s = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sys.path.insert(0, root)
    data = sys.stdin.buffer.read()
    # import parsers BEFORE the address-space limit would starve the interpreter, then limit
    from app.ingest.extract import ExtractError, extract  # noqa: PLC0415

    _limit(memory_mb, cpu_s)
    try:
        res = extract(kind, data, max_pages=max_pages, max_chars=max_chars)
        out = {
            "ok": True,
            "kind": res.kind,
            "page_count": res.page_count,
            "scanned": res.scanned,
            "blocks": [[b.text, b.page, b.section] for b in res.blocks],
        }
    except ExtractError as e:
        out = {"ok": False, "code": e.code}
    except MemoryError:
        out = {"ok": False, "code": "PARSE_MEMORY"}
    except RecursionError:
        out = {"ok": False, "code": "CORRUPT_FILE"}
    except Exception:  # noqa: BLE001
        out = {"ok": False, "code": "PARSE_FAILED"}
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
