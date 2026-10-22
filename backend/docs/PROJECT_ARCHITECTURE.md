# StudyForge AI — Project Architecture (through Part 2)

_Keep this file in sync with the code. Last verified: end of Part 2._

## 1. Shape of the system

The repository root contains exactly three folders (plus `.git`, `.github`, `.gitignore`):

| Folder | Stack | Role |
|---|---|---|
| `frontend/` | Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui, TanStack Query | UI only. Calls the backend through a same-origin proxy. Holds **no** secrets and **no** database access. |
| `backend/` | TypeScript, Hono on Node, Prisma 7 + PostgreSQL, Better Auth | System of record: authentication, authorization, BYOK credential encryption, conversations, documents, storage, job queue, usage quotas. Also holds the Prisma schema/migrations, local Docker infra and project docs. |
| `rag_agent/` | Python 3.13, FastAPI, LangChain, LangGraph | Internal AI service: provider adapters (OpenAI / OpenRouter / Groq), credential tests, model listing, document ingestion (extract → chunk → embed → pgvector), retrieval, and the two grounded-chat workflows. |

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
                                  OpenAI / OpenRouter / Groq  (user's own API key)
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
| `modules/jobs` | Postgres-backed queue (`FOR UPDATE SKIP LOCKED`, dedupe key as lock, backoff, stale-lock reaping), worker loop, `ingest` handler |
| `clients/rag-agent.ts` | Typed HTTP client + SSE/NDJSON parsers for `rag_agent` |
| `index.ts` | Server + in-process worker + graceful shutdown |

The job worker runs inside the backend process by default (`JOB_WORKER_ENABLED`); it can be moved to its own process later because jobs live in Postgres.

## 4. Data model

Part 1 tables are unchanged (`User`, `Session`, `Account`, `Verification`, `RateLimit`, `UserProfile`, `UserPreference`, `Notification`, `AuditEvent`, `UsageRecord`, `RateLimitBucket`). Part 2 adds (migration `…_part2_ai_documents_chat`):

| Model | Notes |
|---|---|
| `ProviderCredential` | One key per `(user, provider)`. Stores `ciphertext`, `iv`, `authTag` (AES-256-GCM, AAD = `userId:provider`), `keyId` (rotation), `last4`, `status`, `lastTestedAt`, `lastErrorCode`. Never the plaintext. |
| `ModelPreference` | Per `(user, task)` where task ∈ `DEFAULT, CHAT, EMBEDDING, MCQ, CQ, ANALYSIS`; `modelId` + optional `temperature/topP/maxTokens`. Deleting a credential cascades. |
| `Conversation`, `ConversationDocument`, `Message`, `MessageCitation` | Messages carry `status` (`COMPLETE/STREAMING/INTERRUPTED/FAILED`), `provider`, `model`, `errorCode`, `insufficientEvidence`, token counts. Citations snapshot document name/page/quote so they survive document deletion. Trigram GIN indexes power case-insensitive search. |
| `Document` | `status` (`QUEUED/PROCESSING/READY/FAILED/NEEDS_OCR`), `statusCode/statusDetail`, `progress`, counts, `embeddingModel`, `processingVersion`, unique `(ownerId, sha256)` for dedupe, private `storageKey`. |
| `DocumentChunk` | `ownerId` (denormalised), `chunkIndex`, `processingVersion`, `page`, `section`, `content`, `embeddingModel`, `embedding vector(1536)`, generated `search tsvector`. A trigger rejects chunks whose owner differs from the document's. **No ANN index** (see DECISIONS D-022). |
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

## 6. Frontend layout (`frontend/src`)

`app/(marketing)`, `app/(auth)`, `app/(app)/(main)` (workspace, dashboard, chat, documents, settings, placeholders), `app/(app)/admin`, `app/api/[...path]` (proxy), `components/{ui,app-shell,auth,account,ai,documents,chat,common}`, `lib/` (`api` client, `sse` reader, `server/backend` for server components, validation schemas). Server components never import database code; there is none in this package.

Chat UI: conversation list (search, paging, rename/delete), per-conversation policy toggle (Documents only / General AI), document picker, model badge, streaming with Stop, regenerate/retry, copy, safe Markdown, citation popovers (verified-quote vs. excerpt), earlier-history paging, explicit empty/loading/error/rate-limit/quota/not-configured states.

## 7. Extension points for Parts 3–5

| Need | Plug in |
|---|---|
| MCQ/CQ generation | New LangGraph workflows in `rag_agent/app/graphs`, reusing `Provider.generate_structured` and retrieval; backend module `modules/questions`; model prefs `MCQ`/`CQ` already stored |
| Exams & analytics | New backend modules with the same ownership rules; `Notification`/`AuditEvent`/`UsageRecord` exist; mint `--exam-canvas` token reserved for the exam screen |
| Groups | `authorize.ts` primitives + new membership checks; retrieval scope would be extended in the *backend* (document id resolution), not in prompts |
| OCR / transcription | `rag_agent/app/ingest` already reports `NEEDS_OCR`; video limits are centralised in `modules/documents/limits.ts` |
| Localisation | `UserPreference.locale` stored; use cookie-based locale so routes never move |
