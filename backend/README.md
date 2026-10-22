# StudyForge AI

An AI study workspace: bring-your-own-key chat, document-grounded answers with sources, AI-generated MCQ/CQ practice and a question bank, server-timed exams with deterministic grading, study groups with leaderboards, and personalised analytics with AI feedback. English and Bangla.

> **Status — Part 5 of 5 (release candidate, not yet production-verified).** Accounts/security (Part 1), AI providers (BYOK), conversations, document upload/processing and retrieval-augmented answers (Part 2), MCQ/CQ generation and the question bank (Part 3), and **timed exams, server-side grading, groups, invitations and leaderboards** (Part 4) are implemented and tested, as are **AI result analysis and study plans, personalized analytics, the administration console, English/Bangla UI and the release documentation** (Part 5). It has **not** been exercised with a live AI provider or deployed; read [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) before relying on it. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for exactly what works, what was verified, and what was not; Contracts: [docs/PART3_SPEC.md](docs/PART3_SPEC.md) (generation + bank) and [docs/PART4_SPEC.md](docs/PART4_SPEC.md) (exams, groups) and the schema is described in [docs/DATABASE.md](docs/DATABASE.md).

## Documentation
[PROJECT_ARCHITECTURE](docs/PROJECT_ARCHITECTURE.md) · [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) (what was verified) · [INTEGRATION_CHECKLIST](docs/INTEGRATION_CHECKLIST.md) · [SECURITY](docs/SECURITY.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [KNOWN_LIMITATIONS](docs/KNOWN_LIMITATIONS.md) · [DATABASE](docs/DATABASE.md) · [DECISIONS](docs/DECISIONS.md) · [CI_NOTES](docs/CI_NOTES.md) · contracts: [PART3](docs/PART3_SPEC.md), [PART4](docs/PART4_SPEC.md), [PART5](docs/PART5_SPEC.md), `rag_agent/CONTRACT.md`.

## Repository layout

```
frontend/    Next.js UI (no secrets, no DB). Proxies /api/* to the backend.
backend/     Hono API + Prisma + job worker. System of record. Also: docs/, infra/ (Docker Compose), prisma/.
rag_agent/   Python FastAPI AI service: providers, ingestion, retrieval, LangGraph chat/generation/analysis workflows.
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

Then in the app: **Settings → API keys** (add your own OpenAI / OpenRouter / Groq key and test it) → **Settings → AI providers** (pick a default chat model and an embedding model) → **Documents** (upload) → **Conversation**, or **MCQ Generator / CQ Generator** (from a topic, pasted text and/or documents; optional per-task models for `MCQ` and `CQ`) → review, edit and save into a collection in the **Question Bank**.

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
| backend | `pnpm test` (needs Postgres; uses the `studyforge_test` database) | unit + integration: crypto, validation, auth, credentials, cross-user denial, documents, ingestion jobs, conversations/chat, queue; **Part 3:** question schemas/validation, generation (mocked rag_agent), question bank, collections, exports; **Part 4:** grading/shuffle units, exam publication/snapshot immutability, attempts (injected server clock, concurrency races), results/release, groups, invites, leaderboard |
| rag_agent | `uv run pytest` (needs Postgres; uses `studyforge_rag_test`) | provider adapters (mocked HTTP), extraction, chunking, ingestion, retrieval isolation, LangGraph workflows; **Part 3:** generation validators, MCQ/CQ graphs with the mock provider, `sample_chunks` isolation, SSE endpoints |
| frontend | `pnpm test` | helpers, i18n catalogs/parity, exam timer/autosave logic, dashboard/admin components (279 tests) |
| frontend | `pnpm test:e2e` (needs Postgres + Mailpit; builds and starts all three services with the mock provider on :3100/:4100/:8200, database `studyforge_e2e`; ≈9 min) | 174 browser tests: auth, AI settings, documents/chat, generation, bank, exams, groups, dashboard/AI feedback, admin, Bangla UI, a11y sweep, and the full user journey incl. failure recovery |
| all | `bash backend/scripts/scan-secrets.sh` · `pnpm audit --prod` (backend, frontend) · `uv export --frozen --no-hashes --no-emit-project \| uvx pip-audit -r /dev/stdin --no-deps --disable-pip` (rag_agent) · `bash backend/scripts/smoke.sh <frontend-url>` | scans and the post-deployment smoke test |

Test databases: `studyforge_test` (backend), `studyforge_rag_test` (rag_agent), `studyforge_e2e` (browser tests) — each name must end in `_test`/`_e2e`; the tools refuse other databases. S3 driver tests need `S3_TEST_ENDPOINT` (e.g. adobe/s3mock on :9090).

No test needs a paid provider call. Live OpenAI/OpenRouter/Groq behaviour is **untested** (no keys were available); see the status doc.

## Security notes
See [docs/SECURITY.md](docs/SECURITY.md) and [docs/PROJECT_ARCHITECTURE.md §5](docs/PROJECT_ARCHITECTURE.md). Headlines: keys encrypted at rest (AES-256-GCM) and never returned; server-side authorization with ownership in every query; retrieval filtered in SQL; document-only answers verified in code; Markdown rendering sanitised with images disabled; CSP nonce, HttpOnly cookies, rate limits, redacted logs. The backend and rag_agent must not be exposed publicly. The application has **not** been independently audited.

## Known limitations
See [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md). Notably: only text-based PDFs (no OCR), no video, one embedding model at a time (1536-d), email cannot be changed, CI has not run on GitHub, and no live provider has ever been called — AI-generated questions are **not guaranteed correct** and are always shown as "review before use".
