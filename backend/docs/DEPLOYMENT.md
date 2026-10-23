# StudyForge AI — Deployment

_Nothing in this repository deploys itself. Never run a production migration, change production credentials or deploy without an explicit decision by the owner. This guide describes what must exist and how to verify it; **it has not been exercised against a real production environment**._

## 1. Services and dependencies

| Component | What it is | Requirements |
|---|---|---|
| **frontend** | Next.js 16 (App Router), server-rendered; `/api/*` same-origin proxy to the backend | Node ≥ 22 runtime (Vercel, a container, or any Node host). Public. Env: `BACKEND_URL` (server-side only). |
| **backend** | Hono API + in-process job worker | Node ≥ 22. **Private** (reachable only from the frontend server). Needs PostgreSQL, storage, the rag_agent URL. |
| **rag_agent** | FastAPI AI service (providers, ingestion, retrieval, LangGraph workflows) | Python 3.13. **Private** (reachable only from the backend). Needs the *same* PostgreSQL (reads `Document`/`DocumentChunk`, writes chunks) and outbound HTTPS to the AI providers. |
| **PostgreSQL 16** | System of record **and** (default) vector search **and** job queue **and** rate limiter | Extensions `vector` (pgvector) and `pg_trgm`. Neon, Supabase, RDS (with pgvector) or self-hosted all work. Daily backups with point-in-time recovery strongly recommended. |
| **Object storage** | Uploaded documents | `STORAGE_DRIVER=local` (a persistent volume; single instance only) **or** `s3` (Cloudflare R2, AWS S3, MinIO — private bucket, path-style where required) **or** `cloudinary` (private raw/authenticated objects; setup, limits and driver switching in [CLOUDINARY_STORAGE.md](CLOUDINARY_STORAGE.md)). Only adobe/s3mock (S3) and a mocked SDK (Cloudinary) were exercised in tests. |
| **Queue** | Postgres `Job` table (`FOR UPDATE SKIP LOCKED`) | **No Redis is required.** Run ≥ 1 backend instance with `JOB_WORKER_ENABLED=true`; several instances are safe (jobs are claimed atomically). |
| **SMTP** (optional) | Verification/recovery e-mail | `SMTP_URL`; without it e-mail is skipped (set `AUTH_REQUIRE_EMAIL_VERIFICATION=false`). |
| **LangSmith** (optional) | Tracing | Off by default; see rag_agent README for the content-hiding settings. |
| **AI providers** | OpenAI / OpenRouter / Groq | Supplied per user (BYOK). The platform needs **no** provider key. |

By default vector search is pgvector inside the same Postgres (exact, owner-filtered scans; no ANN index by design — see DECISIONS D-022) and no other external service is required. **Optionally** vectors can also live in Pinecone (`VECTOR_STORE=dual|pinecone`, the same value in backend and rag_agent; Pinecone credentials only in rag_agent): [VECTOR_STORE_SPEC.md](VECTOR_STORE_SPEC.md) has the index requirements, the migration, the backfill and the staged rollout/rollback. Moving between modes never requires deleting data.

## 2. Configuration
Every variable is documented in `backend/.env.example`, `rag_agent/.env.example` and `frontend/.env.example`; unit tests (`env-docs`) fail if code and examples drift. Required in production:

* Backend: `NODE_ENV=production`, `DATABASE_URL`, `APP_URL` (**https**, the public frontend origin), `BETTER_AUTH_SECRET` (≥ 32 chars, `openssl rand -base64 48`), `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes base64: `openssl rand -base64 32`; keep a backup — losing it makes stored keys unreadable; rotation via `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`), `RAG_AGENT_URL`, `RAG_AGENT_TOKEN` (`openssl rand -hex 24`, identical in rag_agent), storage settings, optionally `VECTOR_STORE` (default `pgvector`; must equal rag_agent's), optionally `EMBEDDING_DIMENSIONS` (deployment default for the embedding size, 8–4096; only seeds users who have not saved a size — see EMBEDDING_SETTINGS_SPEC §2). **Leave `ALLOW_MOCK_PROVIDER` unset** (production start-up refuses it). Optional Google sign-in: `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET` (both or neither; backend only) — setup and the exact redirect URI in `GOOGLE_OAUTH_SETUP.md`.
* rag_agent: `APP_ENV=production`, `DATABASE_URL`, `RAG_AGENT_TOKEN`, `HOST` (bind to a private interface).
* frontend: `BACKEND_URL` (internal URL of the backend).
* Tune limits (`AI_DAILY_*`, `AI_MONTHLY_*`, upload, generation, exam, group limits) to your capacity and provider budgets.

## 3. Network rules
Public: frontend only (TLS terminated by the platform/proxy; HSTS is sent by the app). Private: backend, rag_agent, database, storage. The backend trusts `X-Forwarded-For` from the frontend proxy — do not expose it. Restrict rag_agent ingress to the backend. Outbound: rag_agent → provider hosts; backend → rag_agent, DB, storage, SMTP.

## 4. Container images (verified to build locally)
`backend/Dockerfile` (extra `migrate` target with the Prisma CLI), `rag_agent/Dockerfile`, `frontend/Dockerfile` — multi-stage, non-root, health-checked. `backend/infra/docker-compose.prod-example.yml` shows the wiring for **local verification only** (placeholder secrets). Image sizes measured locally: backend ≈ 0.95 GB, migrate target ≈ 1.5 GB, rag_agent ≈ 0.4 GB, frontend ≈ 1.3 GB.

Note: the frontend build uses `next/font/google` (Inter, Noto Sans Bengali), which downloads the fonts **at build time** — the build host needs outbound access to Google Fonts (or vendor the fonts and switch to `next/font/local`).

## 5. Release procedure (manual, with explicit authorization)
1. Back up the database (snapshot / PITR marker).
2. Build images from a tagged commit with CI green (lint, types, tests, migration validation, audits, secret scan).
3. Apply migrations as a **separate step**: run the backend image's `migrate` target (`prisma migrate deploy`) against the target database. Migrations in this repository are additive unless stated; read the SQL first. **`20261026090000_embedding_dimensions` is NOT backward compatible with the previous code**: it widens `DocumentChunk.embedding` to an unconstrained `vector`, adds the NOT NULL `embeddingProvider` and a generated `embeddingDimension`, and changes the chunk unique key. Deploy it together with the matching rag_agent + backend (step 4) and avoid uploads in between: old rag_agent inserts fail until it is replaced (documents then show FAILED and can be retried). Never run `migrate dev`/`reset` against shared data.
4. Roll out rag_agent, then backend, then frontend (backend tolerates an older frontend; keep one release of API compatibility when changing contracts).
5. Smoke test: `bash backend/scripts/smoke.sh https://app.example.com [BACKEND_URL] [RAG_AGENT_URL]` (read-only GETs; checks pages, security headers, that unauthenticated APIs are refused, health/ready, rag_agent token enforcement).
6. Sign in as an administrator, open `/admin/health` (database, rag_agent, worker heartbeat, queue lag, storage).
7. Create an administrator: `cd backend && pnpm admin:grant you@example.com` (run once against the production database from a trusted shell).

**Rollback:** redeploy the previous images; migrations are forward-only and, except as noted in step 3, additive, so older code keeps working with the newer schema; restore from backup only for data corruption. To run the *previous* code against the embedding-dimensions schema run `ALTER TABLE "DocumentChunk" ALTER COLUMN "embeddingProvider" DROP NOT NULL;` first (old inserts do not set it); old retrieval then keeps working for 1536-d data, — cancel any running re-index in Settings first (cancelling deletes exactly its staged chunk set).

## 6. Operations
* **Health:** `/api/health` (liveness), `/api/ready` (DB; AI up/down), rag_agent `/health` and `/ready`; admin `/api/admin/health` has the worker heartbeat and queue lag. Alert on: `ready` 503, heartbeat age > 3 min, failed-job count rising, 5xx rate, oldest pending job age.
* **Logs:** structured JSON on stdout with request ids (`x-request-id` on every response). No prompts, answers, document text or keys are logged. Ship to your log platform; set retention per your privacy policy.
* **Metrics:** `/admin/metrics` (counts only, per process, 14 days retained). There is no Prometheus/OTel exporter in this release.
* **Backups/restore:** Postgres backups include documents' metadata, chunks, questions, exams and results. Object storage (local disk, bucket or Cloudinary) must be backed up separately. Test restores.
* **Scaling:** frontend and backend are stateless except the in-process worker and in-memory metric counters; run N backend instances behind the proxy (all can run the worker). rag_agent ingestion concurrency is capped (`MAX_CONCURRENT_INGESTS`); scale it horizontally. `STORAGE_DRIVER=local` forces a single backend instance.
* **Time:** keep server clocks NTP-synchronised (exam deadlines).
* **Cost controls:** per-user daily/monthly caps and per-run limits are environment settings; usage is visible to users and admins (tokens as reported by providers; no price estimates).

## 7. Estimated service dependencies (small deployment)
Frontend host + backend container + rag_agent container + Postgres (with pgvector) + S3-compatible bucket = **5 managed pieces**; SMTP and LangSmith optional; no Redis, no separate queue service, and no separate vector database unless you opt into Pinecone (one more piece, see VECTOR_STORE_SPEC.md).

## 8. What was not verified
Real production hosting, TLS/proxy configuration, CDN/WAF, S3-compatible stores other than the test mock, large-scale load, multi-instance clock skew, GitHub Actions execution (the workflow was linted and each job's commands were run locally; see [CI_NOTES.md](CI_NOTES.md)).
