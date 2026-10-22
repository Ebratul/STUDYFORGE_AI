# StudyForge AI — Implementation Plan

> Status: **planning only. No code has been written yet.**
> Source of truth for scope: the Master Implementation Prompt (§1–§26). This file turns it into an executable, phase-by-phase plan.
> Convention: `[ ]` not started · `[~]` in progress · `[x]` done **and verified** (backend + DB + validation + authz + tests).

---

## 0. Repository Audit (done)

| Item | Finding |
|---|---|
| `/storage/STUDYFORGE_AI` | Empty directory, **not a Git repo** → greenfield |
| Toolchain | Node 24.15, pnpm 11.24, Python 3.13, Docker 29.8 available |
| Global Git identity | `Ebratul <ebratulshaharier@gmail.com>` — **differs from the account email on this session (`gazimohammadsayem@gmail.com`)**. Must be confirmed before any commit (see §14). |
| Neon MCP | Available in this session (project/branch/SQL tools). Creating projects or running SQL against a real database needs your explicit go-ahead. |
| Provider keys / R2 / Redis | None present. Treated as blockers for live-provider testing only; everything else is built against mocks/local services. |

Consequence: no existing architecture to preserve, so the decisions in §1 are free choices, made to minimize moving parts.

---

## 1. Key Architecture Decisions (and why)

| # | Decision | Rationale / trade-off |
|---|---|---|
| D1 | **Single Next.js (App Router, TypeScript) application** as the system of record: UI + Route Handlers + service layer. | Prompt §4 says no microservices without demonstrated need. One deployable keeps authz boundaries in one place. |
| D2 | **TypeScript-only AI stack for v1**: LangChain.js + LangGraph.js. **No Python service in v1.** | Document extraction (PDF/DOCX/MD/TXT), chunking, embeddings, and all workflows are doable in TS. A FastAPI sidecar is only justified for OCR / video transcription, so it is a **Phase 3 optional add-on**, behind a narrow HTTP contract. Avoids a second runtime, second deploy, and cross-service auth. |
| D3 | **Monorepo (pnpm workspaces)** with `apps/web`, `apps/worker`, and `packages/*` (db, ai, core, config). | Worker (background jobs) and web share the same domain code without duplication. Not microservices — same codebase, two processes. |
| D4 | **PostgreSQL (Neon) + Prisma + pgvector**. Vector columns via `Unsupported("vector(N)")` + raw SQL for similarity queries (Prisma has no native vector ops). | Per prompt. Embedding dimension is stored per-model so re-embedding is possible. |
| D5 | **Auth: Better Auth** (Prisma adapter, email+password, email verification, password reset, session mgmt). Fallback: Auth.js. Verify current maturity before locking in. | Maintained, self-hosted (no extra vendor), cookie sessions with server-side revocation. |
| D6 | **Background jobs: `pg-boss`** (Postgres-backed queue) run by `apps/worker`. | No Redis needed for jobs; works locally and on any host. Vercel Queues is an alternative for Vercel-only deployment. Behind a `JobQueue` interface so it can be swapped. |
| D7 | **Rate limiting & caching: Redis-compatible (Upstash or local Redis) when configured; Postgres-backed fallback limiter otherwise.** | Prompt says external services optional where feasible. |
| D8 | **Object storage: S3-compatible API** (Cloudflare R2 in prod, **MinIO** in Docker Compose). Private bucket, UUID object keys, short-lived presigned URLs. | Provider-neutral via `@aws-sdk/client-s3`. |
| D9 | **LLM access: own provider-adapter layer** (OpenAI, OpenRouter, Groq) built on LangChain.js chat models where they help, with *our* interface for capability check, normalized errors, retries, timeouts, usage. **BYOK is the primary mode**; no silent cross-provider fallback. | Prompt §7. Vercel AI Gateway is not used because users bring their own keys and must control provider choice. |
| D10 | **Embeddings**: configurable embedding provider (OpenAI `text-embedding-*` or OpenRouter-compatible), selected in settings; dimension recorded per chunk set. Groq has no embeddings → documented. Optional local embedding (e.g. via Ollama/`transformers.js`) is a future item. | Retrieval needs embeddings even if chat uses Groq. Must be surfaced clearly in UI. |
| D11 | **i18n: `next-intl`**, locales `en`, `bn`; all strings in message catalogues; Bangla font (Noto Sans Bengali) loaded. | Extensible to more languages. |
| D12 | **UI: Tailwind + shadcn/ui (Radix) + Lucide + Recharts + TanStack Query + React Hook Form + Zod.** | Per prompt. |
| D13 | **Testing: Vitest (unit/integration), Playwright (E2E), pytest only if the Python sidecar is built.** Mock LLM provider for deterministic CI; real Postgres+pgvector in CI via service container. | Per prompt §22. |
| D14 | **Typed contracts**: Zod schemas in `packages/core` shared by client forms, route handlers, and LLM structured-output parsing. | Single validation source. |
| D15 | **Exact dependency versions and model IDs are resolved at install time**, never copied from memory. Model catalogue comes from provider `/models` endpoints + a validated JSON capability catalogue with a "last verified" date. | Prompt §4/§7. |

### Items I will verify at the moment of implementation (not assume now)
Next.js / React / Prisma / Better Auth / LangGraph.js current major versions and APIs · Prisma + pgvector workflow · Neon pgvector availability · OpenAI/OpenRouter/Groq `/models` response shape and capability fields · Groq tool/JSON-mode support per model · R2 presign compatibility · Vercel 4.5 MB body limit (→ direct-to-storage uploads via presigned URLs).

---

## 2. Target Repository Layout

```
studyforge/
├─ apps/
│  ├─ web/                      # Next.js app (UI + route handlers)
│  │  ├─ src/app/[locale]/
│  │  │  ├─ (marketing)/        # landing, privacy, terms, help
│  │  │  ├─ (auth)/             # login, register, forgot/reset, verify
│  │  │  ├─ (app)/              # authenticated shell
│  │  │  │  ├─ workspace/ chat/ mcq/ cq/ documents/ question-bank/
│  │  │  │  ├─ exams/ (setup, [id]/take, [id]/result)
│  │  │  │  ├─ dashboard/ groups/ (…/[id]/exams/[examId]/leaderboard)
│  │  │  │  ├─ settings/ (providers, keys, profile, privacy) notifications/
│  │  │  └─ (admin)/admin/
│  │  ├─ src/app/api/           # route handlers (thin: parse → authz → service)
│  │  ├─ src/components/ src/lib/ src/messages/{en,bn}.json
│  └─ worker/                   # pg-boss consumers: ingest, embed, analysis, cleanup
├─ packages/
│  ├─ db/                       # Prisma schema, migrations, client, RLS SQL, vector helpers
│  ├─ core/                     # Zod schemas, domain types, scoring, ranking, thresholds, errors
│  ├─ services/                 # service layer: authz-checked use-cases (exams, groups, docs…)
│  ├─ ai/                       # provider adapters, model catalogue, LangGraph workflows, prompts
│  ├─ storage/                  # S3 client, signed URLs, upload validation (magic bytes)
│  ├─ security/                 # crypto (AES-GCM), redaction, rate-limit, invite codes, CSP helpers
│  └─ config/                   # tsconfig, eslint, tailwind presets, env schema (Zod)
├─ e2e/                         # Playwright
├─ infra/ (docker-compose.yml, Dockerfiles, minio init, postgres init with pgvector)
├─ docs/ (architecture, security, deployment, providers, troubleshooting, limitations, ADRs)
├─ .github/workflows/ (ci.yml, security.yml)
├─ .env.example  README.md  plan.md  CHECKLIST.md
```

**Layering rule (enforced by lint boundaries):** route handler → `services` (authz + transaction) → `db`/`ai`/`storage`. UI never imports `db`. `ai` never imports `db` directly; tools receive scoped repository interfaces.

---

## 3. Cross-Cutting Design

### 3.1 Authorization model
- Every service function takes an `Actor` (`{ userId, role, sessionId }`) as its first argument; **no service reads the user from ambient context**.
- Resource access via `assertCan(actor, action, resource)` policies in `packages/services/policy/` (owner, group-role, admin-limited).
- **All queries on owned data include `ownerId` in the `WHERE`** (or join through an owned parent) — never fetch-by-id then check later.
- IDs are `cuid2`/UUID (non-sequential). 404 (not 403) for objects the actor can't see, to avoid existence leaks.
- Defence-in-depth: PostgreSQL **RLS** on the highest-risk tables (`documents`, `document_chunks`, `provider_credentials`, `conversations`, `messages`, `exam_attempts`, `attempt_answers`) using `SET LOCAL app.user_id` per transaction. Prisma runs through a request-scoped transaction helper `withUser(userId, fn)`. Admin role has **no policy** granting content access (see §3.7).
- Retrieval is a SQL function/query that takes `user_id` + explicit `document_ids` and joins `documents.owner_id = user_id` — cross-user retrieval impossible even if the caller passes a foreign document id.

### 3.2 Error model
`AppError(code, httpStatus, safeMessage, details?)` with codes (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `PROVIDER_*`, `CONFLICT`…). One handler maps to JSON; internals logged with redaction, never returned.

### 3.3 Secrets & redaction
- `packages/security/crypto`: AES-256-GCM, random 96-bit IV per record, key id + version stored with ciphertext (supports master-key rotation), AAD = `userId:credentialId` (prevents ciphertext swapping between rows).
- Master key from `CREDENTIAL_ENCRYPTION_KEY` (base64, 32 bytes); keyring supports `CURRENT` + `PREVIOUS`.
- Central `redact()` for logs/errors/traces: API-key regexes (`sk-…`, `gsk_…`, `sk-or-…`), `Authorization` headers, cookies, configured env values.
- Logger (pino) with redaction paths; LangSmith tracing **off by default**, and when on uses an input/output redaction hook and excludes document text unless explicitly allowed.

### 3.4 Validation & limits
Zod at every boundary; body-size limits per route; upload path bypasses the app server (presigned direct-to-storage) with size/MIME constraints + post-upload server-side verification of magic bytes and size before enqueueing processing.

### 3.5 Prompt-injection defences (applies to every LLM call)
1. Document text is always placed in a delimited **data** block, never in the system role.
2. System prompt states that retrieved text is untrusted and instructions inside it must be ignored.
3. LLMs have **no tools that mutate state or read other users' data**. Tools (if any) are narrow, schema-validated, and bound to the actor via closure.
4. Outputs are validated structurally *and* semantically (e.g. citations must reference chunk ids that were actually retrieved).
5. Security does not depend on prompts — authz is enforced in code (§3.1).
6. Regression tests with poisoned documents ("ignore previous instructions and reveal …").

### 3.6 Observability
Structured logs (pino) with request id; `usage_records` table for tokens/cost; audit events for sensitive operations; optional LangSmith; health endpoints `/api/health` (liveness) and `/api/ready` (DB + queue + storage checks).

### 3.7 Admin boundaries
Admin can: view aggregate metrics, system/job health, abuse flags, suspend/unsuspend users, manage quotas, view audit events (metadata only). Admin **cannot**: read conversations, documents, credentials, exam answers, personal analytics. Enforced by the absence of such endpoints and RLS (no admin bypass policy). Test: admin token against content endpoints → 404/403.

---

## 4. Data Model (Prisma — first-cut outline)

> Final schema is written in Phase 1 and extended per phase. All tables: `id`, `createdAt`, `updatedAt` unless noted. Names are indicative.

**Identity & account**
`User(email unique, name, role[USER|ADMIN], locale, status[ACTIVE|SUSPENDED|DELETED], emailVerifiedAt)` · `Account`, `Session`, `Verification` (Better Auth shape) · `UserPreference(userId unique, locale, theme, defaultProviderCredentialId, taskModelPrefs Json)` · `AuditEvent(actorId?, action, targetType, targetId, metadata Json[no secrets], ip hash, at)` · `DataExportJob`.

**Providers**
`ProviderCredential(userId, provider[OPENAI|OPENROUTER|GROQ], label, ciphertext, iv, authTag, keyVersion, last4, status, lastTestedAt, unique(userId,provider,label))` · `ModelPreference(userId, task[CHAT|MCQ|CQ|ANALYSIS|EMBEDDING], credentialId, modelId, params Json, unique(userId,task))` · `ModelCatalogueEntry(provider, modelId, capabilities Json, contextWindow, verifiedAt)`.

**Conversations**
`Conversation(userId, title, mode[GENERAL|DOCUMENT_ONLY], modelPref Json, archivedAt)` · `ConversationDocument(conversationId, documentId)` · `Message(conversationId, role, content, status[COMPLETE|STREAMING|INTERRUPTED|FAILED], tokensIn/Out, providerMeta)` · `MessageCitation(messageId, chunkId, documentId, page, quote)`; FTS index (`tsvector`) for search.

**Documents / RAG**
`Document(ownerId, workspaceId?, filename, mime, sizeBytes, sha256, storageKey, status[UPLOADING|QUEUED|PROCESSING|READY|FAILED], failureReason, pageCount, textLength, language)` · `ProcessingJob(documentId, stage, attempts, progress, error)` · `DocumentChunk(documentId, ownerId[denormalized for RLS/fast filter], ordinal, page, content, tokenCount, embedding vector(N), embeddingModel, metadata)` with HNSW (or IVFFlat) index + btree(ownerId, documentId).

**Question bank**
`QuestionCollection(ownerId, name)` · `Question(ownerId, type[MCQ|CQ], stem, explanation, shortNote, difficulty, language, marks, status[DRAFT|VALIDATED|ARCHIVED], sourceMeta Json, version, contentHash)` · `QuestionOption(questionId, key, text, isCorrect, ordinal; partial unique: exactly one correct for single-answer)` · `QuestionTag(questionId, tag)` · `CollectionQuestion(collectionId, questionId)` · `CqSet(ownerId, title, mode[QUESTIONS_ONLY|WITH_ANSWERS], content Json, sources)` · `GenerationRun(userId, kind, params, status, usage, validationReport)`.

**Exams**
`Exam(ownerId, groupId?, title, description, durationSec, totalMarks, negativeMarking Json, availableFrom/Until, attemptLimit, resultPolicy, reviewPolicy, randomization Json, status[DRAFT|VALIDATED|PUBLISHED|CLOSED|ARCHIVED], publishedAt, snapshotVersion)` · `ExamQuestionSnapshot(examId, ordinal, marks, stem, options Json[with correct key], explanation, shortNote, tags, sourceQuestionId?, sourceVersion, contentHash)` — **immutable after publish** (DB trigger blocks UPDATE/DELETE once exam is published) · `ExamAttempt(examId, userId, attemptNo, startedAt, deadlineAt[server-computed], submittedAt, status[IN_PROGRESS|SUBMITTED|GRADED|EXPIRED], idempotencyKey, unique(examId,userId,attemptNo))` · `AttemptAnswer(attemptId, snapshotId, selectedKey, answeredAt, unique(attemptId,snapshotId))` · `AttemptResult(attemptId unique, rawScore, maxScore, percentage, correct, incorrect, unanswered, band, topicBreakdown Json, rank?, gradedAt, scoringVersion)` · `ResultAnalysis(attemptId unique, content Json, modelUsed, usage)`.

**Groups**
`Group(ownerId, name, description, capacity)` · `GroupMember(groupId, userId, role[OWNER|ADMIN|MEMBER], joinedAt, unique(groupId,userId))` · `GroupInvite(groupId, codeHash (HMAC-SHA256), codePrefix?, expiresAt, maxUses, usedCount, revokedAt, createdBy)` · `GroupExamParticipant(examId, userId, status[INVITED|JOINED|IN_PROGRESS|SUBMITTED|ABSENT], unique(examId,userId))` · `LeaderboardSnapshot(examId, computedAt, rows Json)` (written at close; live view computed otherwise).

**Platform**
`Notification(userId, type, payload, readAt)` · `UsageRecord(userId, provider, model, task, tokensIn, tokensOut, costEstimate?, at)` · `Quota(userId|plan, key, limit, window)` · `RateLimitBucket` (Postgres fallback) · `UploadQuota`.

**Key constraints / indexes (non-exhaustive):** `(ownerId, createdAt desc)` on every owned list; `(examId, userId)` on attempts; HNSW on `embedding`; GIN on message FTS; partial unique to enforce one in-progress attempt per user/exam; `CHECK` that MCQ has ≥2 options and exactly one correct.

---

## 5. Domain Rules That Must Be Specified Up Front (assumptions to document)

### 5.1 Scoring (deterministic, `packages/core/scoring`)
- Per question: correct → `+marks`; unanswered → `0`; incorrect → `−marks × negativeFraction` (default `negativeFraction = 0`; configurable e.g. 0.25). Single-answer MCQ only in v1 (no partial credit; multi-answer is a documented future item).
- Use **integer arithmetic in "milli-marks"** (marks × 1000) to avoid float error; percentage = `round half-up` to 2 decimals for display, but **band classification uses the exact rational comparison** (e.g. `score*100 >= 90*max`) so boundaries are exact.
- Total score floor: configurable (`allowNegativeTotal`, default `false` → floor at 0).

### 5.2 Feedback bands (exact)
| Percentage | Label |
|---|---|
| `>= 90` and `<= 100` | Excellent |
| `>= 80` and `< 90` | Good |
| `>= 70` and `< 80` | Not Good / Needs Improvement |
| `>= 60` and `< 70` | Bad |
| `< 60` | Very Bad |

Unit tests at 59.99, 60, 69.99, 70, 79.99, 80, 89.99, 90, 100, and with max-score 0 (guard).

### 5.3 Ranking
Competition ranking (1, 2, 2, 4). Sort: score desc → (policy tie-break, default **none** so ties share rank) → display order by earlier `submittedAt` only as *display* order, not rank. Unsubmitted/expired-without-submission shown as "Did not submit", unranked. Auto-submitted-at-deadline attempts are ranked normally and labelled.

### 5.4 Exam timing
- `deadlineAt = min(startedAt + durationSec, exam.availableUntil)` computed on server at attempt start and stored.
- Client timer is display-only, resynced from server on each autosave/heartbeat (`serverNow`, `deadlineAt`).
- Autosave rejected after `deadlineAt + gracePeriod` (default 5 s, configurable); submission after deadline is accepted only as an auto-finalize of already-saved answers.
- A worker sweep (and lazy finalization on any read) moves expired attempts to `SUBMITTED/EXPIRED` and grades them.

### 5.5 Idempotency & concurrency
- Submit endpoint requires `Idempotency-Key`; `ExamAttempt` row locked with `SELECT … FOR UPDATE` in a transaction; status transition `IN_PROGRESS → SUBMITTED` is compare-and-set; grading writes `AttemptResult` with unique constraint on `attemptId`. Duplicate/racing requests return the existing result.
- Autosave uses last-write-wins per question with a monotonically increasing `clientSeq` to ignore stale writes.

### 5.6 Result release policies
`IMMEDIATE` (score + review) · `SCORE_ONLY_THEN_REVIEW_AFTER_CLOSE` · `AFTER_CLOSE` · `MANUAL`. Answer keys/explanations are never included in any payload before the policy allows it (enforced in the DTO builder, tested by asserting absence of fields).

### 5.7 Invite codes
128-bit random → base32 (~26 chars, grouped). Stored as HMAC-SHA256 with a server pepper; looked up by hash. Rate limit per user and per IP on `join`; constant-time compare; expiry, max-uses, revocation, capacity checked inside a transaction (`FOR UPDATE` on group row). Optional shareable link form `/join/<code>`.

### 5.8 Document limits (defaults, all env-configurable)
Max file 25 MB · files per upload 10 · per-user storage 500 MB · extracted text 2 M chars · max pages 500 · embedding token budget per doc · video (if enabled) 200 MB / 30 min. Allowed: PDF, TXT, DOCX, MD (validated by extension **and** magic bytes; DOCX = zip with `[Content_Types].xml`; zip-bomb guard on DOCX decompress ratio).

### 5.9 Grounding
- **Document-only mode**: retrieve top-k (hybrid: vector + keyword) from authorized docs → relevance threshold → if below threshold or no chunks: return fixed fallback ("The selected documents don't contain enough information…") **without calling the LLM**. Otherwise the LLM must answer only from supplied chunks and return citations (chunk ids); a post-check verifies citations ⊆ retrieved set; uncited claims → regenerate once, else fallback.
- **General mode**: plain chat; optional "use documents as context".

---

## 6. Phased Implementation

Each phase ends with: ✅ type-check · lint · unit/integration tests · build · checklist update · short summary of changed files and verified outcomes · documented blockers.

### Phase 1 — Foundation: audit, architecture, design system, auth, schema, env
**Requirements covered:** §2, §5 (shell), §6, §19 (core), §20 (headers/base), §23 (partial)

Tasks
1. [ ] Scaffold pnpm monorepo (`apps/web`, `apps/worker`, `packages/*`), TS strict, ESLint (with import-boundary rules), Prettier, Vitest, `.editorconfig`, `.gitignore` (incl. `.env*`, `.claude/`, local logs), `.nvmrc`.
2. [ ] `packages/config`: Zod env schema (`server` vs `public` split; fail-fast at boot; **no secret in `NEXT_PUBLIC_*`** — a test greps the build output).
3. [ ] `infra/docker-compose.yml`: Postgres 16 + pgvector, MinIO (+ bucket init), Redis, Mailpit (dev email), web, worker. Healthchecks. Dev DB bootstrapped with `CREATE EXTENSION vector`.
4. [ ] Prisma schema v1: identity, preferences, audit, notification, usage, quota (+ migration). RLS policy SQL file & `withUser` helper. Seed script (dev fixtures only, clearly named).
5. [ ] Better Auth integration: register, login, logout, email verification (Mailpit locally / SMTP or Resend in prod), forgot/reset, session list & revoke, cookie flags (`HttpOnly; Secure; SameSite=Lax`), password policy + breach-agnostic strength check, **session invalidation on password/email change**, login rate limiting + lockout backoff.
6. [ ] Server auth helpers: `requireActor()` for route handlers/server components; Next.js `proxy`/middleware only as a *UX redirect*, never as the authz layer.
7. [ ] Design system: tokens (colour/spacing/typography/radii, light+dark, accessible contrast), shadcn components, app shell (sidebar desktop, bottom-sheet/drawer mobile, workspace indicator, user menu), Skeleton/Empty/Error/Toast/ConfirmDialog primitives, form field components with inline errors.
8. [ ] i18n scaffold (`en`, `bn`), language switcher, Bangla font, locale-aware dates/numbers.
9. [ ] Public pages: landing, privacy, terms, help (content real, not lorem).
10. [ ] Security baseline: CSP (nonce-based), HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors; CSRF strategy (SameSite + Origin check on all mutating route handlers + custom header for JSON); body-size limits; central error handler; pino logger with redaction.
11. [ ] Profile & privacy settings; **account deletion** (soft-delete → hard purge job incl. storage objects) and **data export** (job producing a ZIP/JSON of user-owned data; link via short-lived signed URL).
12. [ ] GitHub Actions CI v1: install → typecheck → lint → unit tests → build, with Postgres(pgvector) service container; secret scanning (gitleaks) and dependency audit jobs.
13. [ ] `CHECKLIST.md` generated from this file; `.env.example`; README skeleton; ADR-001 (stack decisions).

Acceptance: `docker compose up` + `pnpm dev` → register → verify (Mailpit) → login → see empty workspace shell in en/bn; unauthenticated API call → 401; user A cannot read user B's profile/session by ID; CI green.
Tests: auth integration tests, session-invalidation test, rate-limit test, RLS test (raw SQL as user A cannot select user B's rows), env-schema test, security-header test, a11y smoke (axe) on landing/login.

### Phase 2 — Provider adapters, BYOK security, model selection
**Requirements:** §7, §20, §21 (usage/quotas)

1. [ ] `packages/ai/providers`: `LlmProvider` interface — `listModels()`, `getCapabilities(modelId)`, `invoke()`, `stream()`, `invokeStructured(schema)`, `testConnection()`, `normalizeError()`; adapters for **OpenAI**, **OpenRouter** (OpenAI-compatible, extra headers, per-model routing metadata), **Groq** (OpenAI-compatible).
2. [ ] Normalized error taxonomy: `AUTH_INVALID`, `RATE_LIMITED(retryAfter)`, `CONTEXT_TOO_LONG`, `MODEL_NOT_FOUND`, `CAPABILITY_UNSUPPORTED`, `TIMEOUT`, `PROVIDER_DOWN`, `CONTENT_FILTERED`, `UNKNOWN`. Bounded retries with exponential backoff + jitter **only** on retryable classes; hard timeout via `AbortSignal`.
3. [ ] Model discovery: fetch `/models` per provider with the user's key (server-side), merge with `ModelCatalogueEntry` capability catalogue (structured output / JSON mode / tools / streaming / context window), cache per-user-credential with TTL. Unknown capability = "unverified" → feature requires user confirmation, never assumed.
4. [ ] Capability gate: `requireCapability(model, 'structuredOutput')` returns a typed, user-readable error; MCQ/CQ generators choose *native structured output* if supported, otherwise *JSON-in-prompt + strict parse/repair (bounded)*.
5. [ ] Credential service: create/rotate/delete/list (masked: `••••last4`), AES-GCM encrypt (§3.3), decrypt only inside server-side adapter factory `getProviderForUser(actor, task)`. API never returns plaintext; response DTO type has no secret field (compile-time guarantee + test).
6. [ ] `testConnection`: minimal low-cost call (list models or 1-token completion); returns `{ok, errorCode, message}` with redacted detail.
7. [ ] Settings UI: provider cards, add/rotate/delete key dialogs, model picker (searchable, capability badges), model-ID free entry with validation, default model + per-task overrides (chat/MCQ/CQ/analysis/embedding), generation params within per-model limits (temperature, max tokens, top-p).
8. [ ] Usage & quota: record tokens per call; configurable per-user daily/monthly token & request caps; pre-flight enforcement; `QUOTA_EXCEEDED` message; cost estimate shown only when the price table entry exists and is dated.
9. [ ] **No automatic provider fallback.** On failure, UI shows normalized error + "Retry", "Change model", "Change provider" actions.
10. [ ] Mock provider (`MockLlmProvider`) with scripted responses, latency, error injection — used by tests and a `MOCK_LLM=1` dev switch (clearly labelled in UI when active).

Acceptance: user stores a key → DB contains only ciphertext; API responses and logs contain no key; test-connection works with valid/invalid key (mocked HTTP in CI; live only if you supply keys); rotating/deleting works; user B cannot read/use user A's credential id.
Tests: crypto round-trip + tamper detection (flip a bit in ciphertext/AAD swap → fails), redaction unit tests (keys in errors, headers, nested objects), adapter contract tests run against all three adapters using recorded/mocked HTTP, retry/timeout tests, IDOR test on credential endpoints, quota tests.
**Blocker note:** live-provider verification needs your OpenAI/OpenRouter/Groq keys — will be marked "untested live" until supplied.

### Phase 3 — Storage, document processing, embeddings, retrieval, conversation
**Requirements:** §8, §9, §21

1. [ ] `packages/storage`: S3 client, private bucket, `createUploadIntent()` (validates declared size/MIME/quota → presigned PUT with content-length condition, key `u/<userId>/<uuid>`), `finalizeUpload()` (HEAD object, read first bytes → magic-byte check, size check, sha256, dedupe per user), presigned GET (60 s), delete.
2. [ ] Upload UI: drag-drop multi-file, per-file progress, status polling/SSE, retry failed, delete with confirm, storage meter.
3. [ ] Worker pipeline (pg-boss jobs, idempotent, resumable per stage, bounded attempts): `extract → clean → chunk → embed → index → ready`. Stage + progress persisted on `ProcessingJob`.
   - PDF: `unpdf`/pdfjs-based text extraction with page numbers; DOCX: `mammoth` → text/markdown; MD/TXT: direct. Parsers run in a **resource-limited child process/worker thread with timeout and memory cap**.
   - Detect "no text layer" PDFs → status `NEEDS_OCR`. OCR is the **optional Python sidecar** (Tesseract/OCRmyPDF behind `OCR_SERVICE_URL`); when absent the UI says "Scanned PDF — OCR not configured" (no fake text).
   - Chunking: recursive splitter, ~800 tokens / 100 overlap, page-aware, Bangla-aware sentence boundaries (`।`), metadata (page range, heading path).
   - Embeddings via configured embedding model, batched, token-budget and quota enforced, dimension recorded; failures retried with backoff; partial progress resumable.
4. [ ] Retrieval service `retrieve({actor, query, documentIds, k})`: ownership verified in SQL; hybrid ranking (pgvector cosine + `tsvector` keyword, reciprocal-rank fusion); MMR de-dup; returns chunks with doc/page metadata; relevance threshold configurable.
5. [ ] Conversation backend: CRUD, rename, delete (cascade), search (FTS over own messages), pagination; `POST /messages` streams via SSE (ReadableStream on Node runtime), persists assistant message with status; **stop** via AbortController (message marked `INTERRUPTED` with partial content); regenerate creates a sibling version; context window management (summarize/trim oldest with token counting); token limit errors surfaced clearly.
6. [ ] LangGraph `ConversationGraph`: `route(mode) → [retrieve → relevanceGate → generate → citationCheck] | [generate]`; document-only fallback node (no LLM call). Bounded loops (max 1 repair).
7. [ ] Chat UI: message list virtualized, Markdown (`react-markdown` + `rehype-sanitize`, code highlight, copy), source chips with doc name + page, mode toggle (Document-only / General), document picker, stop/regenerate/copy, search, error banners with retry, interrupted-response handling (resume/regenerate).
8. [ ] Optional video: upload limits + validation only; **processing disabled unless `TRANSCRIPTION_PROVIDER` configured**; UI states "Video processing unavailable" otherwise. Transcription via provider API (e.g. OpenAI audio) as a worker stage when configured.
9. [ ] Document deletion: transactional delete of chunks, jobs, conversation links; storage object removal job with retry; quota recalculated.

Acceptance: upload PDF/DOCX/MD/TXT → READY; ask question in document-only → answer with page citations; ask something absent → fallback with **zero LLM calls** (asserted in test); user B cannot retrieve user A's chunks even with A's document id; poisoned document does not alter behaviour; delete removes all vectors + object.
Tests: file-signature tests (renamed `.exe` as `.pdf`, polyglot, zip-bomb DOCX, oversize), pipeline integration with real Postgres/pgvector + MinIO + mock embeddings, retrieval isolation test, grounding fallback test, prompt-injection fixtures, SSE stream/abort test, quota test.

### Phase 4 — MCQ generation, validation, question bank, CQ generation
**Requirements:** §10, §11, §12

1. [x] _(Part 3)_ Zod `McqQuestionSchema` (stable option ids `A..`, `correctOptionId`, `explanation`, `shortNote`, `difficulty`, `tags[]`, `sources[]{documentId,chunkId,page,quote?}`).
2. [x] _(Part 3; batched, ≤2 regenerations per batch, MCQ and CQ graphs in `rag_agent/app/graphs/generation.py`)_ `McqGraph` (LangGraph): `plan(topic coverage, difficulty mix) → retrieve context (if docs) → generate batch (structured) → validate → [repair/regenerate failures, max 2 rounds] → dedupe → finalize`.
3. [x] _(Part 3; rag_agent `app/generation/validate.py` + backend re-validation. Answer-key verification is an independent solver pass whose disagreement **flags** the question `SOLVER_DISAGREES` instead of regenerating)_ Deterministic validator (never trusts LLM): exactly one correct id that exists; no duplicate/empty options (normalized compare); option count matches request; no "all of the above"-style ambiguity flags (configurable); stem length bounds; near-duplicate detection (normalized trigram/Jaccard + embedding similarity for same batch); language check; for grounded mode **verify the cited quote exists in the cited chunk text** and run an optional second-pass "answer-key verification" LLM call that must independently select the same option (mismatch → regenerate/flag `UNVERIFIED`). Validation report stored in `GenerationRun`.
4. [x] _(Part 3; grounding policy `SOURCE_ONLY | SOURCE_PREFERRED | GENERAL`)_ MCQ UI: input panel (topic / pasted text / docs, count, difficulty or mix, language en/bn, options per question, marks, negative marking, explanation & short-note toggles, grounding policy `strict | prefer | none`), live progress, preview cards with edit-in-place, delete, regenerate single question, bulk save to collection / question bank, validation badges.
5. [x] _(Part 3; parts store the level and marks, answers carry a `basis`: source-supported / general reasoning / insufficient evidence / user-provided)_ CQ: `CqSetSchema` with flexible structure: `{stimulus?, parts[{label, level?: knowledge|comprehension|application|higher-order, text, marks, modelAnswer?, sourceRefs?}]}`; Bangla stimulus-based preset (ক/খ/গ/ঘ with 1/2/3/4 marks) as one *preset*, plus free-form option. Mode A **questions only**, Mode B **with answers** where each answer tags statements as `source-supported` vs `additional-reasoning`. No timer anywhere in CQ flow.
6. [x] _(Part 3; server-side pdfkit + embedded Noto fonts, Bangla verified visually)_ CQ UI: generate, edit, regenerate part/set, save, copy, print stylesheet, **PDF export** (server-side via `@react-pdf/renderer` or Playwright-less HTML→PDF; must embed Bangla font — verified by test rendering).
7. [~] _(Part 3: CRUD, collections, filters, trigram search, pagination, bulk actions, versions + `contentHash`, ownership, JSON/TXT/PDF export done. **Not built:** import, CSV export, "used in N exams" (needs Part 4), Postgres FTS — ILIKE + pg_trgm is used instead)_ Question bank: CRUD, collections, tags/subject/topic/difficulty filters, FTS search, pagination, version increment + `contentHash` on edit, import/export (JSON schema-validated; CSV for MCQ), ownership checks everywhere, "used in N exams" indicator (read-only snapshot link).
8. [x] _(Part 3)_ Rate/cost guard: max questions per run, max tokens, chunk budget.

Acceptance: generate 10 grounded MCQs from a doc → all pass validator or are flagged; malformed mock output is rejected/regenerated (test); edit & save to bank; CQ both modes; PDF with Bangla text renders.
Tests: validator unit tests (≥25 malformed cases), graph tests with scripted mock provider (malformed → repair → success; repeated failure → bounded stop with clear error), grounded-quote verification test, bank authz tests, import schema tests.

### Phase 5 — Timed individual exams, autosave, grading, analytics
**Requirements:** §13, §15 (deterministic part), §16

1. [ ] Exam builder: pick from fresh generation or bank/collection, order, per-question marks, config (§5.4–5.6), validate (≥1 question, marks sum, options valid) → **Publish creates immutable `ExamQuestionSnapshot` rows** (DB trigger forbids later mutation; test attempts direct SQL update).
2. [ ] Attempt lifecycle API: `start` (enforces window, attempt limit, single in-progress; sets `deadlineAt`; returns questions **without correct answers/explanations**, with per-attempt shuffle seed if randomization on), `autosave` (batched, seq-numbered), `heartbeat/sync`, `submit` (idempotent), `getResult` (policy-gated).
3. [ ] Deterministic grader in `packages/core` + `gradeAttempt` service (transaction, row lock, writes `AttemptResult`). `scoringVersion` stored for future-proofing.
4. [ ] Expiry worker + lazy finalize.
5. [ ] Exam UI: server-synced countdown (drift-corrected), question palette (answered/unanswered/flagged), keyboard nav (←/→, 1–9/A–D), autosave indicator + offline queue with retry (IndexedDB/localStorage — only non-sensitive: question ids + chosen keys), `beforeunload` warning, reconnect flow, submit confirmation with unanswered count, mobile layout.
6. [ ] Result page: score, percentage, band label, counts, per-question review (submitted vs correct, status, explanation, short note, sources) **only when policy allows**; topic breakdown chart.
7. [ ] Student dashboard (real queries): exams completed, average/recent/best, trend line, topic radar/bars, correct vs incorrect donut, recent attempts, saved collections, CQ sets, revision recommendations (rule-based from topic accuracy — AI text comes in Phase 7), group summary placeholders wired to Phase 6 data. Empty states.
8. [ ] Analytics queries as SQL views/materialized or indexed aggregates; all scoped by `userId`.

Acceptance: full flow create → publish → start → autosave → submit → result; refresh mid-exam resumes; tampering with client score/timer has no effect; answer key never present in any pre-release payload.
Tests: scoring + boundary tables, negative marking, unanswered, rounding; **race tests** (50 concurrent submits → one result; submit vs expiry sweeper race; autosave after deadline rejected); attempt-limit race (parallel `start`); snapshot immutability; payload-leak test (JSON schema asserts no `isCorrect`/`explanation` before release); IDOR on attempts/results; Playwright full-flow with clock control.

### Phase 6 — Groups, invitations, shared exams, ranking, charts
**Requirements:** §14, §17

1. [ ] Group CRUD, roles (OWNER/ADMIN/MEMBER) & permission matrix, capacity, leave/remove, transfer ownership, delete.
2. [ ] Invitations per §5.7: generate (expiry, max-uses, optional role), copy link/code, revoke, list (shows prefix only, never the full code after creation), join flow with generic error messages (don't reveal whether code exists vs expired), per-IP + per-user throttle, audit events.
3. [ ] Group exams: owner/admin publishes snapshot to group; same deadline/policy for everyone; scheduled window; late-join policy (`ALLOW_UNTIL_END | BLOCK_AFTER_START`), duplicate-participation guarded by unique constraints; participants see **only** their own in-progress state.
4. [ ] Group exam history, participant status board (joined / in progress / submitted — no answers).
5. [ ] Leaderboard service: competition ranking, group avg/min/max, completion count, percentage-band distribution (0–59, 60–69, 70–79, 80–89, 90–100) for the chart, per-question/topic accuracy (aggregate only). Visibility governed by exam `leaderboardVisibility` (`AFTER_CLOSE | LIVE | OWNER_ONLY`). Display name policy: group-scoped display name; no emails.
6. [ ] Group UI: list, detail, invite dialog, members table, exam list, leaderboard table, distribution chart (Recharts, accessible: table alternative + colour-blind-safe palette — see `dataviz` guidance at implementation time), group analytics.
7. [ ] Notifications hooks: invited exam published, exam starting soon, results released.

Acceptance: A creates group + invite; B joins by code; expired/revoked/over-capacity/guessed codes fail safely; both take the same snapshot exam; leaderboard matches DB; non-member gets 404 on all group routes; B never sees A's answers.
Tests: invite entropy/hash storage test, brute-force throttle test, capacity race test (N joins at capacity−1), ranking tie tests (1,2,2,4), distribution band boundary tests, non-member/IDOR, removed-member loses access immediately, snapshot equality across participants, Playwright two-user flow.

### Phase 7 — AI result analysis, notifications, admin, observability, quotas, advanced
**Requirements:** §15 (AI), §18, §20–21, admin parts of §3

1. [ ] `AnalysisGraph`: input = **verified** `AttemptResult` + per-question outcomes + topic breakdown + (optional) prior attempts summary computed by SQL → LLM produces recommendations as structured JSON (`strengths[]`, `weaknesses[{topic,evidence}]`, `studyPlan[]`, `encouragement`). Post-validator: every referenced topic/question must exist in the input; numeric claims must match input (checked programmatically); on mismatch → regenerate once → else show rule-based fallback. LLM never receives write access to scores. Cached per attempt (not shared across users). Missing key → rule-based advice with notice.
2. [ ] Request router graph (intent → conversation / MCQ / CQ / analysis) used by the workspace "ask anything" input; unit-tested with mock classifier.
3. [ ] Notification center: in-app list, unread badge, mark read, preferences; email notifications optional (SMTP configured).
4. [ ] Admin dashboard (aggregates only): users count/active, signups, jobs queue depth/failures, storage totals, provider error rates (no content), abuse flags (rate-limit hits, repeated failed invites), suspend/unsuspend, quota overrides, audit log viewer. Admin actions audited. Bootstrap first admin via CLI/env allow-list (not via UI).
5. [ ] Observability: request IDs, structured logs, `/api/health`, `/api/ready`, optional LangSmith (opt-in, redacted, documented privacy trade-off), job metrics.
6. [ ] Abuse controls: per-endpoint limiters (auth, invite join, generate, upload intents, chat), IP + user keys, `Retry-After`.
7. [ ] Optional/future: CrewAI — **not built**; documented as "only if measurable value" in ADR.

Acceptance: analysis text only cites real data (tamper test: mock LLM returns invented stats → rejected); admin cannot fetch user content; suspended user is logged out and blocked.
Tests: analysis validator tests, admin authz matrix, rate-limit tests, audit-event tests (no secrets in metadata), notification tests.

### Phase 8 — Security review, QA, accessibility, build, CI, docs, release
**Requirements:** §20, §22, §23, §26

1. [ ] Security review pass against OWASP ASVS L2-lite checklist; threat model doc (STRIDE per asset: credentials, documents, exams, invites). Run `/security-review`-style audit of the full diff.
2. [ ] Complete test matrix from §22 (unit/integration/security/E2E). Coverage targets: `core` & `security` packages ≥ 90 %, services ≥ 80 %.
3. [ ] Playwright E2E suites (all 9 flows in §22) running against Docker Compose with mock LLM.
4. [ ] Accessibility: axe checks in E2E, keyboard-only walkthroughs for exam taking, chat, and dialogs; focus management; `prefers-reduced-motion`; contrast audit; screen-reader labels for charts + data-table alternatives.
5. [ ] Performance: indexes verified with `EXPLAIN` on hot queries (Neon MCP `explain_sql_statement`/slow query tools if using Neon); bundle analysis; lazy-load charts/markdown highlight.
6. [ ] Dependency & secret scanning in CI (`pnpm audit`, gitleaks, CodeQL optional); Dockerfile hardening (non-root, minimal image).
7. [ ] Docs: README, architecture, env reference, provider setup, storage setup, DB/migrations, test commands, deployment guide (Vercel for web + separate long-running host/container for worker, e.g. Fly/Railway/Render; or Vercel Queues/Workflow alternative), backup & recovery (Neon PITR/branches, R2 versioning/lifecycle), security & privacy doc, troubleshooting, known limitations, cost/credentials matrix.
8. [ ] Release checklist & final report separating **Implemented / Tested / Untested / Blocked / Future**.

---

## 7. Feature ↔ External Dependency Matrix (for README)

| Feature | Needs | Works without it? |
|---|---|---|
| Auth, exams, groups, analytics | Postgres | No (core) |
| Document upload | S3-compatible storage (MinIO locally) | No |
| Embeddings / grounded chat | Embedding-capable provider key (OpenAI / OpenRouter) | Upload works; retrieval disabled with clear UI message |
| Chat, MCQ, CQ, analysis | Any one provider key (user-supplied) | Mock mode for dev/tests only; rule-based analysis fallback |
| OCR for scanned PDFs | Optional Python sidecar | Scanned PDFs flagged "OCR unavailable" |
| Video transcription | Transcription provider key | Video upload rejected/flagged "unavailable" |
| Email (verify/reset) | SMTP/Resend (Mailpit locally) | Can disable verification in dev only |
| Rate limiting at scale | Redis/Upstash | Postgres fallback limiter |
| LangSmith | API key | Off by default |
| Hosting | Vercel (web) + worker host; Neon; R2 | Paid tiers may be needed at scale — no free-tier guarantees promised |

---

## 8. Testing Strategy Summary

| Layer | Tooling | Where |
|---|---|---|
| Unit | Vitest | `packages/core` (scoring, ranking, bands), `security` (crypto, redact, invite), `ai` (validators, adapters w/ mocked HTTP) |
| Integration | Vitest + real Postgres/pgvector + MinIO (Testcontainers or Compose in CI) | services, RLS, pipeline, graphs w/ mock LLM |
| Security | Vitest suites named `security/*` | IDOR matrix across every resource, upload attacks, injection fixtures, invite brute force, leak assertions, race tests |
| E2E | Playwright (multi-context for two users) | the 9 flows in prompt §22 |
| Static | `tsc --noEmit`, ESLint, `pnpm audit`, gitleaks | CI |

**IDOR matrix rule:** a generic test helper iterates every route/service that takes a resource id and asserts user B gets 404 for user A's object; adding a new resource type without registering it fails CI.

Mock LLM is the default in CI; live-provider smoke tests are opt-in (`pnpm test:live`, require env keys, excluded from CI by default).

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM returns malformed/incorrect answer keys | Schema + deterministic validator + grounded-quote check + independent key-verification pass; flag `UNVERIFIED`; user review before publish |
| Provider capability differences (JSON mode, tools) | Capability catalogue + runtime gate + JSON-parse/repair path |
| pgvector + Prisma friction | Isolate raw SQL in `packages/db/vector`; migration SQL hand-written and reviewed |
| Vercel body/time limits | Direct-to-storage uploads; heavy work in worker; streaming on Node runtime |
| Race conditions (submit/expiry/join) | Row locks, unique constraints, CAS transitions, explicit concurrency tests |
| Bangla PDF/export rendering | Embed Noto Sans Bengali; test render; document limits |
| Scope size | Strict phase gates; vertical slices; checklist honesty rule — nothing marked `[x]` without passing tests |
| Embedding provider lock-in (dimension) | Store model + dimension per chunk; re-embed job; separate index per dimension if needed |
| Cost runaway on BYOK | Quotas, token caps, per-run limits, pre-flight estimates |
| Parser exploits | Isolated, time/memory-limited parsing; magic-byte validation; zip-bomb guards; no execution of document content |

---

## 10. Assumptions (documented, reversible)

1. Single-answer MCQs only in v1; partial credit and multi-select are future work.
2. Each user has a personal workspace; "multi-user workspaces" beyond groups are not built (the `workspaceId` column is reserved/nullable).
3. Email verification is enforced in production, optional in dev.
4. Default language of UI is English; output language of generations is chosen per request.
5. Groups: a user may be in many groups; default capacity 50, configurable ≤ 500.
6. Leaderboards show group display names, not emails.
7. Deleted accounts are hard-purged after a 7-day grace period (configurable); group exam results are anonymized ("Deleted user") rather than removed so group stats stay consistent.
8. Retention: conversations/documents until user deletes; audit events 12 months; usage records 24 months.
9. Python sidecar (OCR) is optional and built only after the TS pipeline is complete; it is not required for the Definition of Done unless you decide scanned PDFs are mandatory.

---

## 11. Open Questions for You (answers change cost/security/irreversible actions)

1. **Git identity:** global Git is `Ebratul <ebratulshaharier@gmail.com>`, but your account email is `gazimohammadsayem@gmail.com`. Which name/email should commits use (must match an email verified on your GitHub account)? Until you confirm, I will not commit.
2. **Remote/hosting:** Do you want me to create a GitHub repo / push / connect Vercel? (I will not without explicit approval.) Do you already have a Neon project, or may I create one via the Neon tools (this creates billable/quota-bound resources)?
3. **Auth library:** OK with Better Auth (self-hosted, Prisma)? Alternative is a hosted provider (Clerk etc.), which adds a vendor and cost.
4. **Embeddings:** Which provider will you use for embeddings (OpenAI is the simplest)? Groq cannot do embeddings.
5. **Scanned-PDF OCR and video transcription:** required for v1, or acceptable as "documented unavailable unless configured"?
6. **Python service:** confirm TypeScript-only for v1 (recommended, D2) — or do you specifically want FastAPI included from the start?
7. **Branding:** any logo/colour preference? Default will be a restrained indigo/slate palette with light & dark themes.

Defaults if you don't reply: Better Auth, OpenAI embeddings, TS-only, OCR/video optional, Docker Compose local DB (no Neon resources created), no commits until identity confirmed.

---

## 12. Execution Order — First Concrete Steps (Phase 1 kickoff)

1. `git init` locally (no commit) → scaffold monorepo → add `.gitignore` first.
2. Compose stack up (Postgres+pgvector, MinIO, Redis, Mailpit) → verify healthy.
3. Prisma schema v1 + migration + RLS SQL → run against **local** DB only.
4. Auth end-to-end (register→verify→login→logout→reset) with tests.
5. App shell + design tokens + i18n.
6. CI workflow + first green run (locally via `act`-free checks: typecheck, lint, test, build).

---

## 13. Progress Checklist (kept in sync with `CHECKLIST.md`)

- [x] Phase 1 — Foundation (Part 1)
- [x] Phase 2 — Providers & BYOK (Part 2; never run against a live provider)
- [x] Phase 3 — Storage, RAG, Conversation (Part 2)
- [~] Phase 4 — MCQ, CQ, Question Bank (Part 3; import / CSV / "used in N exams" outstanding — see IMPLEMENTATION_STATUS)
- [x] Phase 5 — Exams & grading (Part 4; per-user analytics beyond result topics/dashboard summary deferred to Part 5)
- [x] Phase 6 — Groups & Leaderboards (Part 4)
- [ ] Phase 7 — AI Analysis, Admin, Observability
- [ ] Phase 8 — Security, QA, Docs, Release

## 14. Git & Commit Policy (from §24)

- Commits only after you confirm name + email; set as **repo-local** `user.name`/`user.email`.
- No Claude/bot co-author trailers or tool-identifying messages (the harness may suggest a trailer; per your instruction it will be omitted).
- Conventional, descriptive messages, one logical change per commit, per phase.
- No push, PR, remote change, or force operation without asking first. Never rewrite history.
- Never commit: `.env*`, keys, `.claude/`, local paths, logs, `node_modules`, build output, uploaded test files containing real data.
