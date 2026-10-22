# Decision Log

Format: **ID — decision** · status · reason · consequences. Newest decisions are appended at the bottom.

### D-001 — Single Next.js application, not a pnpm monorepo · superseded by D-019
`plan.md` proposed `apps/web`, `apps/worker` and `packages/*`. For Part 1 there is nothing to share, so a single package keeps tooling and imports simple. The `src/server`, `src/lib` split already enforces the boundary. **Revisit in Part 3**, when a background worker needs the domain code; extracting packages then is mechanical.

### D-002 — TypeScript-only for now; Python service deferred · superseded by D-020
No Python code exists. A FastAPI sidecar is only justified for OCR/transcription (Part 3+), behind an HTTP contract.

### D-003 — No microservices · amended by D-019/D-020 (three folders: one internal AI service, no more)
One deployable. A worker process may be added in Part 3 (pg-boss on Postgres), sharing the same codebase.

### D-004 — Authentication: Better Auth (not Auth.js) · accepted
Maintained, self-hosted, Prisma adapter, built-in email verification/reset, DB-backed rate limiting, server-side sessions. Alternatives (Auth.js, hosted providers) were not evaluated in depth. Consequences: its table shapes are part of our schema; we pinned `better-auth@1.7.12`; its admin plugin (impersonation, ban) is intentionally **not** used — roles are our own enum.

### D-005 — Prisma 7 with driver adapter · accepted
`prisma@7.10.1` (the `latest` dist-tag is an 8.0 release candidate and was avoided). Generated client lives in `src/generated/prisma` (git-ignored, produced by `postinstall`). Connection config is in `prisma.config.ts`; runtime uses `@prisma/adapter-pg`.

### D-006 — Database: PostgreSQL; Neon for hosted, Docker for local · accepted
No Neon project was created (no authorization, and not needed). `DATABASE_URL`/`DIRECT_URL` support Neon's pooled/direct split. The local compose image is `pgvector/pgvector:pg16` so Part 3 needs no image change, but Part 1 migrations do not require the extension.

### D-007 — Local ports are offset · accepted
This machine already runs other Postgres containers on 5432–5435. StudyForge uses **5440** (db), **1025/8025** (Mailpit), **3000** (dev) and **3100** (E2E).

### D-008 — Session user is re-read from the database every request · accepted (unchanged; now in backend/src/auth/session.ts)
Better Auth's signed cookie cache is disabled and `role`/`status` are queried per request, trading one indexed lookup for immediate suspension/demotion/revocation. Optimise only with a revocation-aware cache.

### D-009 — `proxy.ts` is UX-only; authorization is in the backend · accepted
It redirects signed-out visitors and sets the CSP nonce. Every page/action/handler authenticates independently (Next layouts do not re-run on client navigation).

### D-010 — Admin is not a first-class UI feature yet · accepted
Admin role is granted only via `pnpm admin:grant`. The dashboard shows aggregates and audit metadata only. Suspension *enforcement* exists (tested) but there is no suspend/unsuspend UI yet (Part 7).

### D-011 — Own rate limiter for app endpoints, Better Auth's for auth endpoints · accepted
Postgres-backed so no Redis is required. Interface (`checkRateLimit`) lets a Redis implementation drop in. Trusts `X-Forwarded-For` — **only safe behind a proxy that overwrites it (e.g. Vercel)**; document when deploying elsewhere.

### D-012 — Session list is custom (opaque ids), not Better Auth's `listSessions` · accepted (served by the backend)
Better Auth's endpoint returns session tokens to JavaScript. We expose only row ids, and revoke with an owner-scoped delete, so XSS cannot harvest other sessions' tokens from the settings page.

### D-013 — Immediate account deletion · accepted (temporary). Note: stored document objects are NOT yet purged on account deletion (DB rows cascade) — see IMPLEMENTATION_STATUS
`plan.md` assumed a 7-day grace period. With no stored files yet, immediate cascade deletion is simpler and honest. Revisit in Part 3 when object storage needs a purge job.

### D-014 — Email cannot be changed yet · accepted
Needs a verification flow for both addresses; deferred. Documented as a limitation.

### D-015 — i18n deferred; locale stored only · accepted
Will use a cookie-based locale (no `/en` prefix) so existing routes never move. UI is English for now; `Noto Sans Bengali` is loaded for Bangla content later.

### D-016 — UI visual direction from user-supplied references · accepted
Lavender/violet SaaS dashboard (ref 1), mint exam canvas with indigo selected option and green submit (ref 2), teal leaderboard styling (ref 3). Implemented as CSS tokens. Reference screenshots show sample data; **no sample data is reproduced** in the product (placeholder pages are explicitly labelled).

### D-017 — Font: Inter (+ Noto Sans Bengali) · accepted
Plus Jakarta Sans was tried first but rendered with cramped word spacing at 14–15 px; Inter reads better in dense UI.

### D-018 — No commits made · pending user input
Global Git identity does not match the session's account email; see IMPLEMENTATION_STATUS "Git state".

### D-019 — Repository split: `frontend/`, `backend/`, `rag_agent/` (user requirement) · accepted
The user asked that the root contain only these three folders. Consequences: the Part 1 Next.js server code (Prisma, Better Auth, services, actions) moved into a TypeScript/Hono **backend**; the Next.js app became a pure UI that proxies `/api/*` (same-origin cookies, no CORS). Project-wide docs, the Docker Compose file and the Prisma schema live under `backend/` (docs in `backend/docs`, infra in `backend/infra`). `.git`, `.github` and `.gitignore` stay at the root because tools require them there. Shared Zod schemas are **duplicated** in `frontend/src/lib/validation` (client forms) and `backend/src/modules/account/schemas.ts` (authoritative); the backend always re-validates.

### D-020 — `rag_agent` is a Python FastAPI service for all LLM/provider work · accepted
Provider adapters, credential tests, model listing, ingestion, retrieval and the LangChain/LangGraph workflows live in one place (Python), so there is a single implementation of the provider interface. The TypeScript backend never calls a provider directly. Trade-off: provider keys must travel backend → rag_agent per request (bearer-authenticated, private network, never logged). The alternative (adapters in both languages) was rejected as duplication.

### D-021 — Hono + Node for the backend (not Next route handlers, not FastAPI) · accepted
Reuses the verified Part 1 TypeScript (Better Auth, Prisma, Zod, redaction, rate limiting) unchanged, uses web-standard `Request/Response` (so handlers are testable in-process with `app.request()`), and streams SSE natively.

### D-022 — No ANN index on embeddings; exact filtered search · accepted
Retrieval is always restricted to one owner's selected documents (hundreds to low thousands of chunks). HNSW/IVFFlat post-filter, so with many users they can return too few rows for a small owner; exact scans over the filtered rows are both correct and fast at this scale. Revisit (iterative scan / partitioning) beyond ~50k chunks per user.

### D-023 — Fixed `vector(1536)`; one embedding model per document set · accepted
OpenAI `text-embedding-3-*` (via the `dimensions` parameter) and `ada-002` produce 1536-d vectors; other models are rejected with a clear error. Each chunk records its `embeddingModel`; retrieval only reads chunks made by the user's *current* embedding model, and changing the model requires reprocessing (UI warns and offers Reprocess). Groq has no embeddings.

### D-024 — Document-only answers are verified before they are shown (no token streaming) · accepted
To guarantee "no unsupported answers", the model's JSON (answer + citations) is verified deterministically (quotes must occur verbatim in the cited chunk) and only then emitted. General mode streams tokens live. The cost is latency in document-only mode (answer appears at once after a "Searching/Checking sources" status).

### D-025 — Postgres-backed job queue inside the backend process · accepted
`Job` table with `FOR UPDATE SKIP LOCKED` claiming, `dedupeKey` unique-while-active, exponential backoff, stale-lock reaping. No Redis or pg-boss dependency; the worker can move to its own process later.

### D-026 — Mock provider for tests/demos only · accepted
`ALLOW_MOCK_PROVIDER` offers a deterministic provider (`mock-valid-key`). The backend refuses to start in production with it enabled, and rag_agent ignores it unless `APP_ENV != production`. It exists so CI and the E2E suite need no paid provider calls.

### D-027 — Fresh local dev database after a schema mistake · accepted
While designing the Part 2 migration, an early `prisma migrate dev` generated destructive `DROP COLUMN` statements for the pgvector/tsvector columns. The migration was discarded and recreated from a corrected schema; because Prisma's own guard refuses `migrate reset` when invoked by an AI agent without explicit user consent, a **new** database (`studyforge_dev`) was created instead of resetting the old `studyforge` one. The old database is obsolete and can be dropped by the user.
