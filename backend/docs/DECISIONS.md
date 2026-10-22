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

### D-028 — Generation is a persisted draft ("run"); the server owns provenance · accepted (Part 3)
Generated questions are validated and stored as a `GenerationRun` (expires after `RUN_RETENTION_DAYS`) and only become bank questions when the user saves them. On save the server derives `sources`, `sourceSupport`, `reviewReasons`, the model/provider and each answer's `basis` **from the stored run** — the request schema has no fields for them, so a client cannot claim "verified against your document". Edited text is detected by hashing (`versionedHash`) and marks the question `modifiedByUser`; an edited or newly written answer becomes `USER_PROVIDED` with no evidence. Rejected alternative: stateless generation that returns questions and trusts the client to send back provenance. Trade-off: a table of short-lived drafts and one extra read on save.

### D-029 — "Source-quoted" is not "correct" · accepted (Part 3)
`SOURCE_QUOTED` only means an evidence quote exists verbatim in an authorised source chunk. The UI and docs call AI output "review before use". Weak signals that the key might be wrong (independent solver disagrees, explanation names another option, key not in the evidence, near-duplicate, language mismatch) become `reviewReasons` that mark the question *Needs review* instead of silently deleting it; hard structural failures are rejected. `MODEL_ONLY` (no evidence) is an informational chip, not a review reason.

### D-030 — Questions are rows, collections are relations, versions are snapshots · accepted (Part 3)
`Question` (+ `QuestionOption`, `QuestionPart`, `ModelAnswer`, `QuestionSource`) is stored once; `CollectionQuestion(collectionId, questionId, position)` expresses membership, so a question can serve many collections/exams without copies. Exact duplicates are prevented per owner by a content hash. Every *exam-visible* change creates an immutable `QuestionRevision` JSON snapshot and bumps `version`; metadata edits (tags, subject, topic, difficulty) don't. Part 4 exams will reference `(questionId, version)` and copy the snapshot when published, so editing or deleting a bank question never changes a published exam. Option/part ids are server-issued cuids (client-supplied ids are only used to recognise an existing option during an edit), so ids can never collide across users.

### D-031 — Tags are `text[]` with a GIN index · accepted (Part 3)
Tags are per-question labels with no attributes of their own, normalised (lower-case, trimmed, ≤10 × 40 chars). A join table would add a write and a join for no query the app needs; `tags @> …` and `unnest()` facets are index-friendly. Revisit if tags gain owners/colours.

### D-032 — Server-side PDF with pdfkit + Noto fonts · accepted (Part 3)
PDF export is rendered on the server (no headless browser). Bengali shaping (conjuncts, pre-base vowel signs, reph) was verified visually on a rendered page image; Latin and Bengali are split by script so each run uses the font that has its glyphs. Characters in no bundled font degrade (`₂`→`2`, emoji→`?`). Exports are built from one explicitly constructed, strictly validated structure, so no database id, owner data, provider/model, run id or document id can reach JSON/TXT/PDF.

### D-033 — Bounded generation · accepted (Part 3)
Limits are env-configurable and enforced in the backend (counts, input sizes, documents, provider calls per run, output tokens, whole-run timeout, per-minute rate, daily AI quota, one running generation per user) and again in rag_agent (batching, ≤2 regenerations per batch, ≤`max_llm_calls`). Zero valid questions after the bounded attempts is an error with a reason; partial success carries a `FEWER_THAN_REQUESTED` warning. Nothing invalid is ever saved.

### D-034 — Exams are immutable versions; grading uses integers · accepted (Part 4)
Publishing copies the draft into an `ExamVersion` with question/option snapshots (content hash stored and re-verifiable); database triggers reject `UPDATE` on versions, snapshots and results, so neither bank edits nor application bugs can change what was published or graded. Marks are centi-marks (integers), negative marking is a basis-point fraction applied at publish, the total is clamped at zero, and the percentage is rounded half-up to two decimals; the feedback band is derived from that displayed percentage so the number and the label always agree. Rejected: floating-point scoring, grading from the live question bank.

### D-035 — One idempotent finalizer, row-locked; time is the server's · accepted (Part 4)
Manual submit, the expiry job, the sweeper and lazy finalization (any request touching an expired attempt) all call `finalizeAttempt`, which locks the attempt row (`FOR UPDATE`) and returns the existing result if already finalized. Deadlines are absolute server timestamps; `lib/clock.ts` is the only source of "now"; the browser derives its countdown from the `remainingMs` it just received plus monotonic elapsed time. A small configurable grace (`EXAM_GRACE_SECONDS`, default 5 s) tolerates network latency for saves/submits; later requests are rejected and the attempt is finalized from the answers already stored, so the outcome is independent of *when* finalization happens (worker down, API down, retries).

### D-036 — Group exams: same snapshot for all, author doesn't compete · accepted (Part 4)
All members use the one published version; per-participant randomization only permutes order (deterministic SHA-256 counter-mode Fisher–Yates stored on the attempt). The author (who knows the key) cannot take their own group exam. Leaderboards rank each current member's best finalized attempt with competition ranking (1, 2, 2, 4) computed in SQL; removed members drop off; results/ranks are hidden until the release policy permits; members may hide their name (shown as "Anonymous participant" to others).

### D-037 — Invite codes are bearer secrets stored as hashes · accepted (Part 4)
128-bit random codes, shown once, only SHA-256 stored (like password-reset tokens); every failure mode returns the same `INVALID_INVITE`; per-user and per-IP hourly attempt limits count failures and successes; direct (e-mail) invites never reveal whether an account exists. Capacity is enforced three ways: group-row lock in the join transaction, advisory-locked DB trigger, and a CHECK on capacity.

### D-038 — AI is derived text; the verified result is the source of truth · accepted (Part 5)
`ExamAnalysis`/`StudyPlan` are stored separately from `ExamResult`, created by retryable jobs, and always accompanied by the deterministic band feedback. A failed, slow or unconfigured provider never blocks or alters a result, the dashboard or the leaderboard. The model may only choose among topics/lists the backend computed; every number in its text must be derivable from the supplied context (verified in code, Bangla digits included), and "mastery/trend" claims are rejected unless the backend-computed data level allows them. Rejected: letting the model compute statistics or classification.

### D-039 — Analytics use released results only, through one SQL source · accepted (Part 5)
Dashboard, analysis context, assistant, study plan and group topic analytics all read finalized *and released* results via `releasedSql`, with `accuracyBp` rounding and `sufficient` (≥ 3 answered) / data-level (≥ 3 results and a topic with ≥ 5 answers) rules defined once. A consistency test asserts the dashboard, results list and leaderboard report identical scores. "No data" (null) is always distinct from 0.

### D-040 — Study assistant reuses the Part 2 conversation engine · accepted (Part 5)
Instead of a second chat stack, assistant sessions create an ordinary conversation (GENERAL or DOCUMENT_ONLY) and return a first prompt built from data the caller may already see (e.g. a missed question when the exam's review policy is FULL). Authorization, quotas, citations, document checks and injection defences are therefore exactly Part 2's.

### D-041 — Least-privilege operations; no break-glass access · accepted (Part 5)
`SUPPORT` is read-only; every mutation is ADMIN-only and audited; non-holders see 404. There is deliberately no endpoint through which any administrator can read conversations, documents, credentials or exam answers; if a support workflow ever needs it, it must be a separate, explicitly authorised, narrowly scoped and audited design. Metrics are in-process counters flushed to Postgres (no external stack required); this trades fidelity for zero extra infrastructure.

### D-042 — Postgres is the queue; no Redis · accepted (Part 5)
Exam expiry, reminders, release notices, AI feedback/plan jobs and ingestion run on the existing `Job` table with bounded retries, dedupe keys and heartbeat visibility. A Redis-compatible queue would add an operational dependency without a feature need at the supported scale.
