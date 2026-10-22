#!/usr/bin/env bash
# Starts the whole stack for local development: Postgres+Mailpit (Docker), rag_agent, backend, frontend.
# Stop with Ctrl+C. Requires: docker, pnpm, uv. Run from anywhere: bash backend/scripts/dev-all.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker compose -f "$ROOT/backend/infra/docker-compose.yml" up -d
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

(cd "$ROOT/rag_agent" && uv run uvicorn app.main:app --host 127.0.0.1 --port 8100) & pids+=($!)
(cd "$ROOT/backend" && pnpm dev) & pids+=($!)
(cd "$ROOT/frontend" && pnpm dev) & pids+=($!)
wait
