# Implementation Status

_Snapshot at the end of **Part 2** (AI providers, conversation, documents, RAG). "Verified" means an automated test or a manual check listed here actually ran and passed._

## Repository & Git state
* Root contains only `frontend/`, `backend/`, `rag_agent/` (+ `.git`, `.github`, `.gitignore`, which tools require at the root). Project docs, Docker Compose and the Prisma schema live in `backend/`.
* `git init -b main` was run locally in Part 1; **no commits exist**, no remote is configured, nothing was pushed. The global Git identity (`~/.gitconfig`) differs from the session's account email — **I still need you to confirm which name/email to use** before committing. No Claude/bot co-author trailers will be added.
* Ignored (never committed): `.env*` (except `*.example`), `node_modules`, `.next`, `dist`, `backend/src/generated`, `backend/storage`, `rag_agent/.venv`, caches, test output.

## Feature status
Legend: ✅ implemented & verified · 🟡 implemented, partly verified · ⛔ placeholder only (labelled in the UI) · — not started

### Part 1 (carried over; re-verified after the backend/frontend split)
Accounts, recovery, verification, sessions, RBAC/admin, profile/preferences, notifications, privacy (password change, sessions, export, deletion), security headers/CSP, rate limiting, audit, design system, responsive shell — ✅ (same E2E coverage as before, now through the proxy + Hono backend).

### Part 2
| Area | Status | Notes |
|---|---|---|
| Provider layer (OpenAI, OpenRouter, Groq adapters; common interface; normalised errors; usage; timeouts; bounded retries; structured output with prompt-JSON fallback) | 🟡 | Implemented in `rag_agent`; verified with **mocked HTTP** (respx) and the mock provider. **Never run against a live provider** (no keys). |
| Model listing & capability handling | 🟡 | Models come from the provider's own `/models` API using the user's key. OpenRouter capabilities come from `supported_parameters`; OpenAI/Groq capabilities use catalogue rules and are shown as `unverified` when unknown. Tested with mocked responses. |
| BYOK credentials (AES-256-GCM, AAD, key rotation, masked display, test/rotate/delete, per-user) | ✅ | Unit + integration + E2E; ciphertext-only in DB; no key in any response, log, DOM or storage (scanned). |
| Settings UI (API keys; default + per-task models; generation limits; connection states) | ✅ | E2E with the mock provider. |
| Conversations (create/rename/search/delete, persisted history, paging, SSE streaming, Stop, retry/regenerate, copy, safe Markdown, selected model badge, document attach, citations, empty/loading/error/rate-limit/quota states) | ✅ | Backend integration + E2E (mock provider). |
| Document-only vs General policies | ✅ | Document-only: gate → structured generation → deterministic verification → fallback with **zero** model calls; answers shown only after verification. General: streams live, documents optional. Tested in `rag_agent`, backend integration and E2E. **Quality of answers with a real model is untested.** |
| Document upload & processing (PDF, DOCX, TXT, MD) | ✅ | Validation by extension + MIME + signature, quotas, dedupe, private storage, generated keys, background jobs with retry/dedupe, progress, delete (chunks + object), signed downloads. |
| Scanned PDFs / OCR | ⛔ (reported) | Detected and reported as `NEEDS_OCR` with an explicit message. **No OCR engine is wired** (`OCR_ENABLED` is accepted but does nothing). |
| Video | ⛔ (refused) | Rejected with a clear message: no transcription pipeline exists. Limits are centralised for a future implementation. |
| Retrieval (pgvector + keyword hybrid, strict owner scoping, thresholds, bounded context, version switching) | ✅ | Real Postgres tests incl. isolation (user A never sees B's chunks), stale versions, non-READY docs, embedding-model mismatch, injection-shaped inputs. |
| Prompt-injection / leak defences | 🟡 | Structural defences + leak filter + hostile-document tests with a *scripted* model. How a real model behaves under injection is untested. |
| Usage tracking & quotas | ✅ | Daily request/token caps, per-endpoint rate limits. Token usage is recorded only when the provider reports it. Embedding usage is **not** recorded. Cost estimation is **not implemented**. |
| LangGraph workflows | ✅ | `rag_agent/app/graphs` (document-only, general); typed state, bounded loops, timeouts. |
| LangSmith (optional) | 🟡 | Config + content-hiding hooks unit-tested with a fake client; **no live LangSmith run**. Off by default. |
| Storage drivers | 🟡 | `local` ✅ (tests + E2E). `s3`: integration-tested only against **adobe/s3mock** (an S3 API mock), not Cloudflare R2/MinIO/AWS. |
| Account deletion removes stored files | ✅ | Files are queued for deletion before the rows cascade (integration-tested). |
| MCQ, CQ, question bank, exams, groups | ⛔ | Placeholders labelled "Not implemented yet" (Parts 3–5). |

## Verification results (run at completion)

| Check | Result |
|---|---|
| `backend`: `pnpm lint` · `typecheck` · `build` | pass |
| `backend`: `pnpm test` (real Postgres `studyforge_test`) | 143 passed, 3 skipped (S3 driver tests need `S3_TEST_ENDPOINT`; run separately: 3/3 passed against s3mock) |
| `rag_agent`: `uv run pytest` (real Postgres+pgvector `studyforge_rag_test`; also passes with outbound HTTPS blocked) | 346 passed |
| `frontend`: `pnpm lint` · `typecheck` · `build` · `pnpm test` | pass · 29 passed |
| `frontend`: `pnpm test:e2e` (Chromium; real rag_agent + backend + production frontend; mock provider; Mailpit; DB `studyforge_e2e`) | 55 passed |
| rag_agent smoke test on :8100 (health, auth required, provider test via mock) | pass |

Defects found by testing during Part 2 and fixed: a Hono sub-router's `use("*")` middleware leaked auth onto sibling routes (public download links returned 401); `prisma migrate dev` generated destructive `DROP COLUMN` for the pgvector/tsvector columns (migration recreated from a corrected schema); Playwright starts web servers before `globalSetup` (database preparation moved into the config); a nested-interactive accessibility violation in the model list; the Stop button raced the server's persistence of the interrupted message (UI now refreshes until it is persisted); the mock embedder matched unrelated questions on stop-words (stop-words now ignored).

## Required environment variables (see the three `.env.example` files)
Backend: `DATABASE_URL`, `APP_URL`, `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes, base64), `RAG_AGENT_URL`, `RAG_AGENT_TOKEN`; optional `SMTP_URL`, `STORAGE_DRIVER`/`S3_*`, limits (`MAX_UPLOAD_BYTES`, `USER_STORAGE_QUOTA_BYTES`, `AI_DAILY_*`, `RETRIEVAL_*`…), `ALLOW_MOCK_PROVIDER` (never in production). rag_agent: `DATABASE_URL`, `RAG_AGENT_TOKEN` (same as backend) and the settings in its README. Frontend: `BACKEND_URL` (server-side only).

## Not verified / known limitations
* **No live provider was ever called.** OpenAI/OpenRouter/Groq behaviour (auth errors, rate limits, streaming usage, structured output, model-list shapes) is verified against documentation (dated 2026-10-22 in `rag_agent/app/providers/catalogue.py`) and mocked HTTP only. Items the rag_agent author flagged as **not re-verified**: `text-embedding-ada-002` dimensions (from memory), newer OpenAI model families' structured-output support (pattern is an inference), Groq `include_usage` (third-party sources only; usage degrades to `null`).
* Retrieval quality with real embeddings (threshold `RETRIEVAL_MIN_SIMILARITY=0.30` was tuned only for the mock embedder) is unmeasured; it is configurable.
* Follow-up questions are retrieved together with the previous user turn (deterministic condensation, no extra model call). An unrelated question asked right after a related one may therefore still be searched with the earlier topic; the verifier still requires every claim to be supported by a verbatim quote.
* Only text-based PDFs (no OCR), no video; embeddings must be 1536-dimensional (OpenAI `text-embedding-3-*` via the `dimensions` parameter, `ada-002`); Groq cannot be the embedding provider; one embedding model at a time (changing it requires reprocessing documents).
* Parser isolation is process + rlimit + timeout (not seccomp). The DB role for `rag_agent` is *not* restricted in this repo; the contract documents the minimal grants and they were not tested.
* Document-only answers are not token-streamed (verified before display) — by design.
* The backend and rag_agent must not be exposed publicly; the backend trusts `X-Forwarded-For` from the frontend proxy.
* Chromium only; no real mobile devices; real SMTP/Neon/Vercel/R2 untested; CI workflow written but never executed on GitHub.
* Email cannot be changed; language preference stored but the UI is English-only; legal pages are drafts.
* The old local database `studyforge` is obsolete (see DECISIONS D-027) — drop it when convenient; the app uses `studyforge_dev`.

## Next steps — Part 3 (MCQ / CQ / question bank), suggested
1. Confirm the Git identity and whether to commit Parts 1–2.
2. With a real provider key, run a manual end-to-end pass (key test → model list → upload → grounded Q&A) and tune `RETRIEVAL_MIN_SIMILARITY`; report any provider-specific surprises.
3. New LangGraph workflows in `rag_agent` (generate → deterministic validate → bounded repair) reusing `generate_structured` and retrieval; backend `questions` module + question-bank tables; frontend generators and bank UI; use the stored `MCQ`/`CQ` model preferences.
4. Decide whether OCR for scanned PDFs is required (add an engine behind the existing `NEEDS_OCR` path) and whether to build video transcription.
