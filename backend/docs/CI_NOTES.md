# CI notes — how each job maps to a local command

Workflow: `.github/workflows/ci.yml` (push to `main`, pull requests, and a weekly schedule so new advisories are caught). It has read-only repository permissions, uses only throw-away values (listed in the workflow `env:`; never real credentials), builds Docker images **without pushing**, and never deploys or migrates a production database.

| Job | What it does | Run locally (from the repo root) |
|---|---|---|
| `backend` | lint, typecheck, vitest (real Postgres + pgvector), build | `cd backend && pnpm lint && pnpm typecheck && pnpm test && pnpm build` |
| `migrations` | applies **all** migrations to an empty DB, `migrate status`, `migrate diff --exit-code` against `schema.prisma` (fails on drift), warns on destructive SQL | create an empty DB, then `cd backend && DATABASE_URL=… DIRECT_URL= pnpm prisma migrate deploy && pnpm prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` |
| `rag-agent` | pytest against Postgres + pgvector | `cd rag_agent && uv sync --frozen && uv run pytest -q` |
| `frontend` | lint, typecheck, vitest, production build | `cd frontend && pnpm lint && pnpm typecheck && pnpm test && pnpm build` |
| `security` | secret scan of tracked files; `pnpm audit --prod` (backend, frontend); pip-audit of the locked Python dependencies | `bash backend/scripts/scan-secrets.sh`; `pnpm audit --prod`; `cd rag_agent && uv export --frozen --no-hashes --no-emit-project \| uvx pip-audit -r /dev/stdin --no-deps --disable-pip` |
| `docker` | builds `backend`, `backend` (target `migrate`), `rag_agent`, `frontend` images (not pushed) | `docker build -t studyforge-backend:ci backend` (etc.) |
| `e2e` | Playwright (Chromium) against the real rag_agent + backend + production frontend with the **mock** provider, Mailpit for e-mail | `cd frontend && pnpm test:e2e` (needs Postgres on :5440 and Mailpit; see `backend/infra/docker-compose.yml`) |

## Scripts (`backend/scripts/`)
* `scan-secrets.sh [repo-root]` — regex/entropy scan of `git ls-files` for private keys, provider-key shapes (`sk-`, `gsk_`, `lsv2_`, AWS, GitHub, Slack, Google), tracked `.env` files and high-entropy `*_KEY/_SECRET/_TOKEN/_PASSWORD` assignments. Prints `file:line: rule` (never the value); exit 1 on findings. Skips paths in `secret-scan-allow.txt` (tests, lockfiles, `*.example`, workflows) and lines containing `secret-scan:allow`. `SECRET_SCAN_INCLUDE_UNTRACKED=1` also scans new, not-yet-committed files. It is a heuristic net, **not** a replacement for a dedicated scanner with history scanning (e.g. gitleaks/GitHub secret scanning); the allow-listed test directories are not inspected.
* `smoke.sh FRONTEND_URL [BACKEND_URL] [RAG_AGENT_URL]` — post-deployment smoke test: read-only GETs only (safe for production). Checks `/login`, security headers, no `x-powered-by`, unauthenticated API access is refused, `/api/health`, `/api/ready` (no internals leaked), rag_agent `/health`, `/ready`, token required.
* Env-docs tests keep the `.env.example` files honest: `backend/tests/unit/env-docs.test.ts`, `rag_agent/tests/test_env_docs.py`, `frontend/tests/unit/env-docs.test.ts` (every variable the code reads is documented, and nothing stale is documented).

## Containers
* `backend/Dockerfile` — multi-stage (`deps` → `build` → `runtime`; extra `migrate` target that has the Prisma CLI). Runs as the non-root `node` user, `HEALTHCHECK` on `/api/health`, configuration only through runtime environment variables. Run `migrate` yourself (`docker run --rm -e DATABASE_URL=… <image>`) as a deliberate deployment step; nothing runs migrations automatically.
* `rag_agent/Dockerfile` — Python 3.13 slim + uv, non-root user, `HEALTHCHECK` on `/health`, `APP_ENV=production` by default (mock provider disabled).
* `frontend/Dockerfile` — `next start`, non-root, build arg `BACKEND_URL` is the only build input (non-secret).
* `backend/infra/docker-compose.prod-example.yml` — wiring example for **local verification only**.

## What CI cannot tell you
GitHub Actions itself was not executed from the development environment: the workflow was linted with actionlint and each job's commands were run locally against throw-away databases. Real-provider behaviour, production infrastructure, TLS/proxy setup and load are untested by CI.
