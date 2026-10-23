# StudyForge AI — Project Architecture (through Part 5)

_Keep this file in sync with the code. Last verified: end of Part 5. Normative contracts: [PART3_SPEC.md](PART3_SPEC.md) (generation + bank), [PART4_SPEC.md](PART4_SPEC.md) (exams, attempts, grading, groups, leaderboards) and [PART5_SPEC.md](PART5_SPEC.md) (AI feedback/plans/assistant, analytics, admin); operations docs: [SECURITY.md](SECURITY.md), [DEPLOYMENT.md](DEPLOYMENT.md), [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md), [INTEGRATION_CHECKLIST.md](INTEGRATION_CHECKLIST.md); the schema is described in [DATABASE.md](DATABASE.md)._

## 1. Shape of the system

The repository root contains exactly three folders (plus `.git`, `.github`, `.gitignore`):

| Folder | Stack | Role |
|---|---|---|
| `frontend/` | Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui, TanStack Query | UI only. Calls the backend through a same-origin proxy. Holds **no** secrets and **no** database access. |
| `backend/` | TypeScript, Hono on Node, Prisma 7 + PostgreSQL, Better Auth | System of record: authentication, authorization, BYOK credential encryption, conversations, documents, storage, job queue, usage quotas. Also holds the Prisma schema/migrations, local Docker infra and project docs. |
| `rag_agent/` | Python 3.13, FastAPI, LangChain, LangGraph | Internal AI service: provider adapters (OpenAI / OpenRouter / Groq / Gemini), credential tests, model listing, document ingestion (extract → chunk → embed → pgvector, optionally also Pinecone), retrieval, the two grounded-chat workflows, the bounded MCQ / CQ generation workflows (Part 3) and the post-exam analysis / study-plan workflows (Part 5). |

```
Browser ──► frontend (Next.js :3000)
              ├─ pages / server components ──(forward session cookie)──┐
              └─ /api/[...path] proxy (streams SSE + uploads) ─────────┤
                                                                      ▼
                                              backend (Hono :4000) ── Prisma ──► PostgreSQL (+pgvector, pg_trgm)
                                                │   │                              ▲
                              job worker ───────┘   └── Storage (local disk | S3)  │
                                                │                                  │
                                                ▼  Bearer RAG_AGENT_TOKEN          │
                                       rag_agent (FastAPI :8100) ──(only "Document"/"DocumentChunk")──┘
                                                │
                                                ▼
                                  OpenAI / OpenRouter / Groq / Gemini  (user's own API key)
```

Why this split: the browser must never see the backend, the AI service or any provider key; the backend is the *only* place that decides who may touch which data; and the AI service is stateless with respect to users and secrets (keys arrive per request and are never stored or logged).

**Network rule:** only the frontend server (and a trusted load balancer) may reach the backend; only the backend may reach `rag_agent`. The backend trusts `X-Forwarded-For` from the frontend, so it must not be exposed publicly.

## 2. Request flow & trust boundaries

1. The browser only ever talks to the frontend origin. `frontend/src/app/api/[...path]/route.ts` forwards `/api/*` to the backend (streaming request/response bodies, passing `Set-Cookie` and redirects through). It adds no trust.
2. Server components call the backend with the incoming cookie (`frontend/src/lib/server/backend.ts`). `proxy.ts` only does optimistic redirects and sets the CSP nonce.
3. **Backend** (`backend/src/app.ts`): request id → same-origin (CSRF) guard on every mutating `/api` request → Better Auth (`/api/auth/*`) or module routers. Each router calls `requireAuth` (session re-read from the DB on every request; role/status never cached) and then module code that scopes every query by the actor's id.
4. For AI work the backend resolves the user's model preference, **decrypts the user's key server-side**, checks quotas, and calls `rag_agent` with `Authorization: Bearer RAG_AGENT_TOKEN`. Keys go in the request body only.
5. `rag_agent` treats the backend as the sole authority for *who* the user is and *which documents are permitted*, but still filters every SQL query by `ownerId` and the permitted document ids (defence in depth).

## 3. Backend layout (`backend/src`)

| Path | Responsibility |
|---|---|
| `config/env.ts` | Zod-validated environment, value-free error messages, production guards (https, no mock provider…) |
| `lib/` | `db` (Prisma + pg adapter), `errors`, `logger`, `redact`, `audit`, `mail`, `rate-limit` (Postgres fixed window), `crypto` (AES-256-GCM, HKDF subkeys, HMAC tokens) |
| `auth/` | Better Auth config, `session.ts` (`resolveSession`), `authorize.ts` + `permissions.ts` (RBAC/ownership primitives) |
| `http/` | context type, middleware (request id, CSRF, `requireAuth`, permission guard, error mapping), capped JSON reader |
| `modules/account` | profile, preferences, notifications, sessions, export, dashboard summary, admin overview |
| `modules/ai` | `credentials` (BYOK), `preferences` (default + per-task model, generation limits), `models` (per-credential cache of provider-reported models), `usage` (daily token/request quotas), `routes` |
| `modules/documents` | upload validation (extension + MIME + magic bytes), limits (single source of truth), service (quota, dedupe, retry, delete, signed download), `storage/` (`local`, `s3`) |
| `modules/conversations` | CRUD/search/paging, `chat.ts` (turn preparation, SSE, persistence, citations), routes |
| `modules/questions` | **Part 3.** `schemas` (strict Zod: question input, generation settings, bodies), `content`/`provenance` (row ↔ DTO mapping; server-derived provenance), `service` (save/edit/list/bulk/revisions), `collections`, `generation` (runs, quotas, model/credential/document resolution, result re-validation, single-question regeneration), `export/` (JSON / TXT / PDF), `routes` (`/api/questions`, `/api/collections`, `/api/generation`, `/api/export`) |
| `modules/exams` | **Part 4.** `schemas`/`limits` (strict Zod), `grading` (pure integer centi-mark grading, percentage, bands), `shuffle` (deterministic SHA-256 Fisher–Yates), `snapshot` (publish copy + hash + integrity), `eligibility`, `service` (drafts, preview, publish, cancel, duplicate, lists), `attempts` (start/resume under an advisory lock, autosave with `seq`, submit, the single row-locked `finalizeAttempt`), `results` (release-aware view; no key before release), `jobs` (`exam.expire`, `exam.sweep`, `exam.reminder`, `exam.release`), `lifecycle`, `release`/`bands` (pure) |
| `modules/groups` | **Part 4.** groups, members and the roles matrix, hashed 128-bit invite codes, join (group row lock + capacity trigger + per-user/per-IP rate limits), group exam history, and the SQL leaderboard/participants endpoints (competition ranking, best attempt, privacy names) |
| `modules/analysis` | **Part 5.** Workflow A/B orchestration: context building (review-policy-gated, no identifiers), jobs `exam.analysis` / `study-plan` (bounded retries, `NOT_CONFIGURED`, quota, idempotent rows), deterministic fallback feedback, `/api/analysis/*` |
| `modules/assistant` | **Part 5.** Workflow C: creates ordinary conversations (Part 2 engine/policies) with a first prompt built from data the caller may already see |
| `modules/analytics` | **Part 5.** `stats.ts`/`sources.ts` (the single SQL source for released results, topic stats, data levels), `/api/analytics/me`, suggestions |
| `modules/admin` | **Part 5.** least-privilege console API (users, usage, metrics, jobs, health, audit, config), `ops.heartbeat` job; `lib/metrics.ts` in-process counters → `MetricBucket` |
| `lib/clock.ts` | the one source of "now" for every deadline/window/release decision (server clock; replaceable in tests) |
| `modules/jobs` | Postgres-backed queue (`FOR UPDATE SKIP LOCKED`, dedupe key as lock, backoff, stale-lock reaping), worker loop, `ingest` handler |
| `clients/rag-agent.ts` | Typed HTTP client + SSE/NDJSON parsers for `rag_agent` |
| `index.ts` | Server + in-process worker + graceful shutdown |

The job worker runs inside the backend process by default (`JOB_WORKER_ENABLED`); it can be moved to its own process later because jobs live in Postgres.

## 4. Data model

_Part 3 tables (generation runs, question bank, collections) are documented in [DATABASE.md](DATABASE.md)._

Part 1 tables are unchanged (`User`, `Session`, `Account`, `Verification`, `RateLimit`, `UserProfile`, `UserPreference`, `Notification`, `AuditEvent`, `UsageRecord`, `RateLimitBucket`). Part 2 adds (migration `…_part2_ai_documents_chat`):

| Model | Notes |
|---|---|
| `ProviderCredential` | One key per `(user, provider)`. Stores `ciphertext`, `iv`, `authTag` (AES-256-GCM, AAD = `userId:provider`), `keyId` (rotation), `last4`, `status`, `lastTestedAt`, `lastErrorCode`. Never the plaintext. |
| `ModelPreference` | Per `(user, task)` where task ∈ `DEFAULT, CHAT, EMBEDDING, MCQ, CQ, ANALYSIS`; `modelId` + optional `temperature/topP/maxTokens`. Deleting a credential cascades. |
| `Conversation`, `ConversationDocument`, `Message`, `MessageCitation` | Messages carry `status` (`COMPLETE/STREAMING/INTERRUPTED/FAILED`), `provider`, `model`, `errorCode`, `insufficientEvidence`, token counts. Citations snapshot document name/page/quote so they survive document deletion. Trigram GIN indexes power case-insensitive search. |
| `Document` | `status` (`QUEUED/PROCESSING/READY/FAILED/NEEDS_OCR`), `statusCode/statusDetail`, `progress`, counts, `embeddingModel`, `processingVersion`, unique `(ownerId, sha256)` for dedupe, private `storageKey`. |
| `DocumentChunk` | `ownerId` (denormalised), `chunkIndex`, `processingVersion`, `page`, `section`, `content`, `embeddingProvider` + `embeddingModel` + generated `embeddingDimension` (= the vector's real length; together the embedding identity, part of the unique key so an active and a staged set can coexist), `embedding vector` (any length), generated `search tsvector`. A trigger rejects chunks whose owner differs from the document's. **No ANN index** (see DECISIONS D-022). `pineconeIndexedAt` marks chunks whose vector is also held (and was seen) in Pinecone; `embeddingDimension` is a plain column kept equal to the vector's length by a trigger ([VECTOR_STORE_SPEC.md](VECTOR_STORE_SPEC.md), D-045). |
| `EmbeddingReindex` | One staged embedding index per user (`BUILDING/ACTIVATED/FAILED/CANCELLED`, target provider/model/dimension; at most one `BUILDING` per user via a partial unique index). See EMBEDDING_SETTINGS_SPEC §5. |
| `Job` | Postgres queue; `dedupeKey` is `UNIQUE` while the job is active and cleared on completion. |

Migration workflow: `pnpm prisma migrate dev --create-only`, review the SQL, then apply. Raw SQL that Prisma can't express (the owner-check trigger) lives at the end of the Part 2 migration; extensions are declared in the schema (`postgresqlExtensions`). `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` reports no drift.

## 5. Security model

All Part 1 controls remain (see §5 of the earlier revision: session cookies, CSP nonce, rate limits, redaction, audit, enumeration resistance). Part 2 adds:

| Concern | Implementation | Verified by |
|---|---|---|
| **BYOK at rest** | AES-256-GCM, random IV, AAD binding to user+provider, key ring with rotation, master key from env only | unit `crypto.test.ts`, integration `credentials.test.ts` (ciphertext-only in DB, tamper/AAD-swap fail) |
| **BYOK in transit/use** | Decrypted only inside backend functions that call `rag_agent`; response DTOs are built from an explicit column `select` that excludes ciphertext; masked `••••last4` only | integration response scans over every AI/account endpoint; e2e DOM/storage scan |
| **No key in logs/errors** | `redact()` on all logs and audit metadata; upstream error text never forwarded; `rag_agent` uses `SecretStr` and a canary-key test | integration "secrets never reach logs"; rag_agent tests |
| **Cross-user credential use** | Keys always resolved by `(session userId, provider)`; there is no credential id in any request | integration cross-user tests |
| **No silent provider fallback** | Backend and `rag_agent` use exactly the provider the user selected; failures are returned with the provider's normalised error | integration + rag_agent tests |
| **Quotas** | Daily request/token caps (`UsageRecord`), per-endpoint rate limits (chat 30/min, tests 10/min, uploads 20/min…), message/history/context size caps | integration |
| **Conversation ownership** | `findFirst({ id, userId })` on every access; foreign ids → 404 | integration + e2e |
| **Upload safety** | extension allow-list, declared-MIME consistency, magic-byte signature, size/count/quota caps, generated storage keys (`u/<user>/<random>`), filename sanitising, video explicitly refused, content-hash dedupe; `rag_agent` re-validates content and parses in an isolated, time/memory-limited worker | unit + integration + e2e + rag_agent tests |
| **Downloads** | HMAC-signed token (60 s, bound to user+document, ownership re-checked on use), `attachment` + `nosniff` + sandbox CSP; S3 presigned URL with forced `attachment` | integration |
| **Retrieval isolation** | Backend sends only the caller's READY, model-matching document ids; `rag_agent` SQL filters `ownerId`, `documentId = ANY(…)`, current `processingVersion`, `READY`, `embeddingModel`; DB trigger enforces chunk/document owner equality | integration + rag_agent tests |
| **Document-only policy** | Gate (similarity threshold) → structured generation → deterministic verification (cited sources exist, quotes found verbatim in the chunk, markers valid, leak filter) → one bounded repair → fallback. The fallback makes **no** model call. Verified answers only are shown. | rag_agent tests; integration; e2e |
| **Prompt injection** | Sources only in the *user* turn inside a randomised delimited block; system prompt marks them untrusted; no tools; citations and document names come from the database, never from the model; output leak filter; permissions never depend on the prompt | rag_agent tests; e2e hostile-document scenario |
| **Markdown XSS / exfiltration** | `react-markdown` (no raw HTML) + `rehype-sanitize` allow-list, http/https/mailto links with `noopener noreferrer nofollow`, **images never rendered** | frontend unit tests + e2e |
| **Observability** | Request ids end-to-end; LangSmith optional and **off by default**; when on, inputs/outputs are hidden unless explicitly opted in | rag_agent unit tests (config logic only; no live LangSmith) |

### 5.1 Part 3 additions

| Concern | Implementation | Verified by |
|---|---|---|
| **Provenance can't be forged** | Save/edit input has no fields for sources, source support, review flags, answer basis or model; the server derives them from the stored `GenerationRun` and marks content the user changed (`modifiedByUser`, answers → `USER_PROVIDED`) | integration `generation.test.ts` ("provenance comes from the run"), `questions.test.ts` |
| **Generated output isn't trusted** | rag_agent validates; the backend re-validates every question with the same Zod rules, drops evidence that points at documents the request wasn't authorised to use, recomputes source support, enforces `SOURCE_ONLY` itself, strips answers in questions-only mode, removes duplicates and trims to the requested count | integration `generation.test.ts` |
| **Server-side validation on every write** | One schema for generation results, save, edit and export-drafts: ≥2/≤6 options, unique normalised options, valid correct reference, size limits, marks arithmetic, tag limits, unknown keys rejected, atomic batch | unit `question-schemas.test.ts`, integration |
| **Ownership** | Every query is scoped to the caller; foreign ids are 404 (or silently ignored in bulk/export); a DB trigger refuses cross-owner collection membership | integration `questions.test.ts`, `collections.test.ts`, `export.test.ts` |
| **Bounded work** | Env-configurable caps on counts, input sizes, documents, provider calls per run, output tokens, run timeout, per-minute rate and daily AI quota; one running generation per user; abort cancels the provider call | integration `generation.test.ts` |
| **Exports leak nothing** | Built from one explicitly constructed structure validated by a strict schema (export-local ids; no DB/document/run ids, owner, provider/model, review flags) | unit `export-*.test.ts`, integration `export.test.ts` |
| **Prompt injection (generation)** | Same defences as chat: sources only in the delimited *user* turn, neutralised, no tools, citations/document names from the database, leak filter on outputs, SPEC block carries no secrets | rag_agent `test_generation_graph.py` |

### 5.3 Part 5 additions

| Concern | Implementation | Verified by |
|---|---|---|
| **AI can't change grades** | analysis/plan are derived rows keyed to a result; grading, bands, ranks come only from deterministic code; failure of any AI step leaves the result, dashboard and leaderboard unchanged and the deterministic band feedback is always returned | `analysis-core.test` (failed AI never alters/blocks results), `analytics-me.test`, e2e journey |
| **No invented facts** | rag_agent verifies topics ⊆ supplied lists, every number derivable from the context (Bangla digits normalised), no mastery/trend claims unless the backend-computed data level allows; one repair, then error; backend re-validates | rag `test_analysis_verify/graph`, `analysis-verify.test` |
| **Privacy-minimal context** | no ids/names/e-mail/document text; item detail only when the exam's review policy allows (FULL/CORRECTNESS/NONE tiers); released results only | `analysis-core.test` |
| **Quotas & cost** | daily + monthly caps checked before every AI call (chat, generation, regeneration, analysis, plan); usage shown to the user; no price estimates | `usage-quota.test` |
| **Admin least privilege** | USER/SUPPORT/ADMIN catalogue, 404 for non-holders, audited mutations, suspension revokes sessions, no endpoint for user content or secrets | `admin.test`, `hardening.test`, `permissions.test` |
| **Observability** | request id on every response, error `category`, aggregate metrics (no user ids), worker heartbeat, queue lag, `/api/admin/health` | `admin-metrics.test`, `hardening.test` |
| **Account deletion** | cascades all user rows; stored files queued for deletion; members of a deleted owner's groups are notified first | `account-deletion.test` |

### 5.2 Part 4 additions

| Concern | Implementation | Verified by |
|---|---|---|
| **Published content can't change** | `ExamVersion`/snapshots/results are immutable (DB triggers reject `UPDATE`); snapshot hash re-verified for the author; bank edits/deletes don't touch snapshots | integration `exams-drafts.test.ts` (raw SQL UPDATE rejected; tamper → `MISMATCH`) |
| **Answer key never leaves early** | attempt/take/list/autosave payloads never select `isCorrect`, explanation, note or sources; results/review are gated by the release predicate evaluated per request | integration `exams-results.test.ts` (JSON scans over every pre-release payload; the same scans match after release, so they can fail) |
| **Server-authoritative time** | `deadlineAt` stored absolute; every comparison uses `lib/clock.ts`; client sends only option ids and a `seq`; the browser countdown is `remainingMs` + monotonic elapsed | integration `exams-attempts.test.ts` (injected clock, spoofed client time ignored) |
| **Race safety** | start: advisory lock + partial unique index + trigger; save/submit/expire: `SELECT … FOR UPDATE` on the attempt row; one `ExamResult` per attempt (unique) | integration: 8 concurrent starts → 1 attempt; 8 concurrent submits and a 10-way submit/save/expire/sweep race → exactly one result; removing the lock makes these tests fail |
| **Recovery** | expiry job + self-rescheduling sweeper + lazy finalization on any read/write/leaderboard read; grading uses only answers stored ≤ deadline + grace, so results are identical whenever finalization runs | integration (worker-down recovery) |
| **Groups** | roles matrix, one OWNER, capacity enforced by group-row lock *and* an advisory-locked trigger; invite codes are bearer secrets stored as hashes with generic failures and per-user/per-IP limits | integration `groups-*.test.ts` (12 parallel joins into 3 seats → exactly 3) |
| **Leaderboard** | SQL over finalized results of current members; best attempt; `rank()` competition ranking; hidden until released; anonymised names; opaque entry ids | integration `groups-leaderboard.test.ts` |

## 6. Frontend layout (`frontend/src`)

`app/(marketing)`, `app/(auth)`, `app/(app)/(main)` (workspace, dashboard, chat, documents, settings, placeholders), `app/(app)/admin`, `app/api/[...path]` (proxy), `components/{ui,app-shell,auth,account,ai,documents,chat,common}`, `lib/` (`api` client, `sse` reader, `server/backend` for server components, validation schemas). Server components never import database code; there is none in this package.

Part 3 UI: `/mcq`, `/cq` (generation workspaces) and `/question-bank` (collections + searchable bank) share `components/questions/*` — source and settings fields, a review workspace (editable cards with stable draft ids, selection, regenerate, save-to-collection, copy, export, print), badges for source support / review reasons / answer basis, and a print layout scoped under `html.sf-printing`. Types and local (advisory) validation live in `lib/questions.ts`; the server remains the authority.

Part 5 UI: `/dashboard` (real analytics: totals with null-vs-zero, trend, topic accuracy, breakdown, AI feedback, suggestions, saved content, groups), `/study-plan`, AI feedback card on results, usage and auto-feedback settings in Settings, the admin console `/admin/*` (overview, users, usage, metrics, jobs, health, audit, config), and English/Bangla localisation (`src/lib/i18n`, catalogs in `src/messages`, cookie `sf-locale` synced with the saved preference; English is the key so untranslated strings fall back invisibly).

Part 4 UI: `/exams` (mine / available / history), the exam wizard (`/exams/new`, `/exams/[id]/edit`), `/exams/[id]`, the focused exam screen `/attempts/[id]` (own `(exam)` layout on the mint canvas, no app shell), `/attempts/[id]/result` (server-computed score, band, topic chart, review), `/groups`, `/groups/[id]`, `/join[/code]`, and `/exams/[id]/leaderboard` (Recharts score-distribution chart with a text alternative). The UI renders server values only; it never computes scores, ranks or release state.

Chat UI: conversation list (search, paging, rename/delete), per-conversation policy toggle (Documents only / General AI), document picker, model badge, streaming with Stop, regenerate/retry, copy, safe Markdown, citation popovers (verified-quote vs. excerpt), earlier-history paging, explicit empty/loading/error/rate-limit/quota/not-configured states.

## 7. Extension points for Part 5

| Need | Plug in |
|---|---|
| AI result analysis / recommendations | Read finalized `ExamResult`/`ExamResultItem` + snapshot topics (grading data is trustworthy and AI-free); call rag_agent with a new workflow; never let a model alter a score |
| Group analytics beyond the leaderboard | New read-only SQL over `ExamResult` joined to current `GroupMember`s |
| Email notifications | `notifyUsers` is the single delivery point; add a consent-gated channel there |
| OCR / transcription | `rag_agent/app/ingest` already reports `NEEDS_OCR`; video limits are centralised in `modules/documents/limits.ts` |
| Localisation | `UserPreference.locale` stored; use cookie-based locale so routes never move |
