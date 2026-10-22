# StudyForge AI

An AI study workspace: bring-your-own-key chat, document-grounded answers with sources, and (in later parts) MCQ/CQ practice, timed exams and study groups. English and Bangla.

> **Status — Part 2 of 5.** Accounts/security (Part 1) plus AI providers (BYOK), conversations, document upload/processing and retrieval-augmented answers are implemented and tested. MCQ/CQ generation, question bank, exams and groups are **not built** and are labelled *Soon* in the UI. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for exactly what works, what was verified, and what was not.

## Repository layout

```
frontend/    Next.js UI (no secrets, no DB). Proxies /api/* to the backend.
backend/     Hono API + Prisma + job worker. System of record. Also: docs/, infra/ (Docker Compose), prisma/.
rag_agent/   Python FastAPI AI service: providers, ingestion, retrieval, LangGraph chat workflows.
```
Only these three folders live at the repository root (plus `.git`, `.github`, `.gitignore`). Architecture: [docs/PROJECT_ARCHITECTURE.md](docs/PROJECT_ARCHITECTURE.md). Decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Roadmap: [docs/plan.md](docs/plan.md) (written before the three-folder split; the decision log records what changed).

## Quick start (local)

Requirements: Node 22+ (24 recommended), pnpm 11, Python 3.13 + [uv](https://docs.astral.sh/uv/), Docker.

```bash
# 1. Postgres (pgvector) on :5440 and Mailpit on :1025/:8025
docker compose -f backend/infra/docker-compose.yml up -d

# 2. Backend
cd backend && pnpm install
cp .env.example .env.local        # then fill in the secrets — see below
pnpm db:migrate:deploy            # applies the committed migrations to YOUR local database
cd ..

# 3. rag_agent
cd rag_agent && uv sync --extra dev && cp .env.example .env.local   # fill in (see rag_agent/README.md)
cd ..

# 4. Frontend
cd frontend && pnpm install && cp .env.example .env.local && cd ..

# 5. Run all three (or use three terminals)
bash backend/scripts/dev-all.sh       # frontend http://localhost:3000, backend :4000, rag_agent :8100
```

Generate the required secrets (never commit them):

```bash
openssl rand -base64 48   # BETTER_AUTH_SECRET
openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY  (exactly 32 random bytes)
openssl rand -hex 24      # RAG_AGENT_TOKEN  (same value in backend/.env.local and rag_agent/.env.local)
```

Then in the app: **Settings → API keys** (add your own OpenAI / OpenRouter / Groq key and test it) → **Settings → AI providers** (pick a default chat model and an embedding model) → **Documents** (upload) → **Conversation**.

To make yourself an admin: `cd backend && pnpm admin:grant you@example.com`.

### Environment variables
Each service documents its own: [backend/.env.example](.env.example), `frontend/.env.example`, `rag_agent/.env.example`. Values are validated at start-up with value-free error messages. Nothing sensitive is ever prefixed `NEXT_PUBLIC_`.

### Database migrations — what they do
* `pnpm db:migrate:dev` — **development only**; it may prompt to reset a drifted database. Use `--create-only` first and read the SQL. (`prisma migrate dev` against an AI agent session refuses to reset a database without your explicit consent; that guard is intentional.)
* `pnpm db:migrate:deploy` — applies committed migrations, nothing else. Never run automatically by the app or CI against production. Needs the `vector` and `pg_trgm` extensions (Neon supports both).
* The Part 2 migration creates tables, extensions (`vector`, `pg_trgm`), a generated `tsvector` column and an owner-check trigger; it drops nothing.

## Testing

| Where | Command | What it covers |
|---|---|---|
| backend | `pnpm test` (needs Postgres; uses the `studyforge_test` database) | unit + integration: crypto, validation, auth, credentials, cross-user denial, documents, ingestion jobs, conversations/chat, queue |
| rag_agent | `uv run pytest` (needs Postgres; uses `studyforge_rag_test`) | provider adapters (mocked HTTP), extraction, chunking, ingestion, retrieval isolation, LangGraph workflows |
| frontend | `pnpm test` | safe Markdown rendering, SSE parsing, validation |
| frontend | `pnpm test:e2e` (needs Postgres + Mailpit; builds and starts all three services with the mock provider on :3100/:4100/:8200, database `studyforge_e2e`) | full browser flows incl. accessibility scans |

No test needs a paid provider call. Live OpenAI/OpenRouter/Groq behaviour is **untested** (no keys were available); see the status doc.

## Security notes
See [docs/PROJECT_ARCHITECTURE.md §5](docs/PROJECT_ARCHITECTURE.md). Headlines: keys encrypted at rest (AES-256-GCM) and never returned; server-side authorization with ownership in every query; retrieval filtered in SQL; document-only answers verified in code; Markdown rendering sanitised with images disabled; CSP nonce, HttpOnly cookies, rate limits, redacted logs. The backend and rag_agent must not be exposed publicly. The application has **not** been independently audited.

## Known limitations
See the status doc. Notably: only text-based PDFs (no OCR), no video, one embedding model at a time (1536-d), email cannot be changed, stored files are not yet purged on account deletion, CI has not run on GitHub.
