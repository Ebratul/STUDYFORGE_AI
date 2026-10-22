# Implementation Status

_Snapshot at the end of **Part 4** (timed exams, grading, groups, leaderboards; Part 3 content retained below). "Verified" means an automated test or a manual check listed here actually ran and passed._

## Repository & Git state
* Root contains only `frontend/`, `backend/`, `rag_agent/` (+ `.git`, `.github`, `.gitignore`).
* Parts 1–2 are in the user's own "first commit" (`Ebratul <ebratulshaharier@gmail.com>`, pushed to `origin/main` by the user). **Parts 3 and 4 are uncommitted in the working tree**; I have not committed, pushed or opened a PR. When asked to commit, use the repo's existing identity with no Claude/bot trailers.
* Ignored (never committed): `.env*` (except `*.example`), `node_modules`, `.next`, `dist`, `backend/src/generated`, `backend/storage`, `rag_agent/.venv`, caches, test output.

## Feature status
Legend: ✅ implemented & verified · 🟡 implemented, partly verified · ⛔ placeholder only (labelled in the UI) · — not started

### Part 1 (carried over; re-verified after the backend/frontend split)
Accounts, recovery, verification, sessions, RBAC/admin, profile/preferences, notifications, privacy (password change, sessions, export, deletion), security headers/CSP, rate limiting, audit, design system, responsive shell — ✅ (same E2E coverage as before, now through the proxy + Hono backend).

### Part 4 — exams, grading, groups, leaderboards
Contract: [PART4_SPEC.md](PART4_SPEC.md). Schema: [DATABASE.md](DATABASE.md).

| Area | Status | Notes |
|---|---|---|
| Exam creation wizard (details → questions from the bank → rules → server preview → publish), individual and group mode, all rule settings validated on the server | ✅ | Integration + E2E. Questions are chosen by id (the wizard offers collections client-side); there is no separate "unauthorized collection" input to reject — foreign/non-MCQ questions are rejected. |
| Immutable published snapshots, snapshot hash + integrity check, bank edits/deletes don't affect published exams | ✅ | DB triggers reject `UPDATE` on versions/snapshots/results (raw-SQL test). |
| Deterministic participant-specific order (SHA-256 counter-mode Fisher–Yates), same question set/answers for everyone | ✅ | Fixed vectors + independent reference + set-equivalence tests. |
| Timed exam UI: countdown, navigation, answered/marked, progress, autosave state, submit confirmation, expired state, keyboard, responsive | ✅ | E2E on the real stack incl. offline/reconnect, reload restore, server expiry (deadline shifted in SQL), device clock +2 h, axe, 360 px. "Saved" is shown only after the server confirms that item. |
| Server-authoritative time, grace window, stale-`seq` autosave, idempotent submit, lazy/job/sweeper finalization, attempt limits | ✅ | Integration with an injected server clock. |
| Race safety: concurrent starts, concurrent submits, submit/save/expire/sweep at the deadline, concurrent group joins vs capacity | ✅ (as tested) | Executed on real Postgres locks: 8 concurrent starts → 1 attempt; 8 concurrent submits and a 10-way mixed race → exactly one result; 12 parallel joins into 3 seats → exactly 3 members; removing the attempt row lock makes the race tests fail. Not tested: multi-process / multi-instance deployments and clock skew between instances. |
| Deterministic grading (centi-marks, basis-point negative marking, clamp at zero, half-up percentage), exact feedback bands | ✅ | Unit boundary tests (±1 bp at 9000/8000/7000/6000). |
| Results & release (IMMEDIATE / AFTER_CLOSE / AT_TIME × review NONE / CORRECTNESS / FULL), topic performance, retry info | ✅ | No-key-leak JSON scans over every pre-release payload. |
| Groups: create/edit/delete, roles (OWNER/ADMIN/MEMBER), capacity, hashed invite codes (expiry, revocation, max uses, direct invite), join/leave/remove, privacy toggle, group exam history | ✅ | Integration + E2E; brute-force rate limits tested with a lowered limit. |
| Group exams: same snapshot for all, late-join policy, author excluded, participation statuses | ✅ | |
| Leaderboard & analytics: competition ranking (1, 2, 2, 4) in SQL, best attempt, zero vs unsubmitted vs in-progress vs timed-out, privacy names, release gating, stats, 5-band distribution with Recharts, pagination | ✅ | Integration + E2E (chart + text alternative). Not load-tested with large groups. |
| Notifications (in-app only, idempotent): invitation, group exam published, reminder, submission, results available, membership changes | ✅ | Dedupe keys; duplicate jobs don't duplicate notifications. **No e-mail is sent.** |
| Dashboard summary with real released results | ✅ | |
| Background recovery (expiry job, self-rescheduling sweeper, reminder/release jobs) | 🟡 | Handlers and recovery are tested by calling the job runner directly; the long-running worker loop in a separate process and a real "worker down for hours" scenario were not exercised. |

### Part 3 — MCQ / CQ generation and the question bank
Contract: [PART3_SPEC.md](PART3_SPEC.md). Schema: [DATABASE.md](DATABASE.md).

| Area | Status | Notes |
|---|---|---|
| MCQ generation from topic, pasted text, documents (or combinations) with count, difficulty (incl. Mixed), language (en/বাংলা), option count (2–6), marks, negative marks, explanations, short notes, grounding policy, per-run model | ✅ | Backend integration (mocked rag_agent), rag_agent graph tests, E2E through the real stack with the **mock provider**. Every setting is validated on the server with env-configurable maxima. |
| Versioned question schema, stable ids, server-derived provenance (sources, source support, review flags, answer basis) | ✅ | Clients cannot submit provenance; tested. |
| Validation pipeline (structure, answer key, duplicates/near-duplicates, language script, size, evidence quotes, marks arithmetic, explanation-vs-key, evidence overlap, independent solver pass) | ✅ / 🟡 | Deterministic checks are tested on both sides (Python and TypeScript). The solver pass and "answer key plausibility" heuristics are tested with the **mock**; their usefulness with a real model is unmeasured. A flagged question is marked *Needs review*, never silently dropped or claimed correct. |
| Bounded regeneration, call/time/quota caps, clear failure reasons (`INVALID_OUTPUT`, `NO_VALID_QUESTIONS`, `INSUFFICIENT_SOURCES`) | ✅ | Tested incl. abort (Stop) and whole-run timeout. |
| Review UI: edit, delete (undo), reorder, select, regenerate one / all, save to collection, copy, export, print | ✅ | E2E + axe scans; 360 px no horizontal scroll. Print/PDF **page output** was only checked as DOM/CSS (browser print not exercised). |
| CQ: questions-only and with-answers, structures (stimulus 4-part ক/খ/গ/ঘ with the four levels, multipart, descriptive), no timer anywhere | ✅ | Tests assert there are no timer/duration fields in settings, runs or questions, and no timer text in the UI. |
| CQ answers: source-supported vs general reasoning vs **insufficient evidence** (empty text, never invented) vs user-provided | ✅ | Tested at rag_agent, backend and E2E. |
| Question bank: private collections ("question sets"), titles/descriptions/subjects, tags, difficulty/kind/language filters, trigram search, pagination, bulk actions, provenance, revisions, reuse across collections (relation, no copies) | ✅ | Integration + E2E; ownership tested for every endpoint. |
| Export: JSON (validated schema), TXT, PDF (server-side, Bangla-capable), print layout | 🟡 | Formats tested; Bengali shaping verified **visually on a rendered page** for common conjuncts/vowel signs, not exhaustively. Symbols with no glyph (emoji, math) degrade to `?`. |
| Model selection per task (`MCQ`/`CQ`), context window and structured-output capability respected | 🟡 | Context window comes from the provider's model list when reported; native vs prompt-JSON structured output is decided by the Part 2 adapter and reported as a warning. **No live provider was ever called.** |
| Usage tracking | ✅ | `llm.requests` (provider calls) and `llm.tokens` (when the provider reports them) recorded per run/regeneration. |
| "Select questions for an exam" | 🟡 | Implemented as saving into a collection (question set). Exams themselves are Part 4. |
| Import, CSV export, "used in N exams", Postgres FTS | — | Not built (see checklist). Search uses ILIKE + pg_trgm. |

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
| AI result analysis and personalized recommendations | ⛔ | Part 5. |

## Verification results (run at completion of Part 4)

| Check | Result |
|---|---|
| `backend`: `pnpm lint` · `typecheck` · `build` · `prisma migrate diff` (no drift) | pass |
| `backend`: `pnpm test` (real Postgres `studyforge_test`) | 487 passed, 3 skipped (S3 driver tests need a mock server; not re-run) |
| `rag_agent`: `uv run pytest` | 469 passed (unchanged in Part 4; last run at the end of Part 3) |
| `frontend`: `pnpm lint` · `typecheck` · `build` · `pnpm test` | pass · 145 passed |
| `frontend`: `pnpm test:e2e` (Chromium; real rag_agent + backend + production frontend; **mock provider**) | 114 passed, 0 failed, 0 skipped (79 earlier + 15 exams + 20 groups) |

Defects found by tests during Part 4 and fixed: the group view lacked the caller's own privacy setting (leaderboard toggle showed the wrong state); the UI assumed `feedback` was a string (server sends `{label, message}`); several E2E selectors/timing issues (route announcer alerts, animation-time axe sampling, sign-up rate limits per client IP).

## Verification results (run at completion of Part 3)

| Check | Result |
|---|---|
| `backend`: `pnpm lint` · `typecheck` · `build` · `prisma migrate diff` (no drift) | pass |
| `backend`: `pnpm test` (real Postgres `studyforge_test`) | 284 passed, 3 skipped (S3 driver tests need `S3_TEST_ENDPOINT`; **not re-run in Part 3** — last run: 3/3 against s3mock in Part 2) |
| `rag_agent`: `uv run pytest` (real Postgres+pgvector) | 469 passed (346 existing + 123 new) |
| `frontend`: `pnpm lint` · `typecheck` · `build` | pass |
| `frontend`: `pnpm test` | 62 passed |
| `frontend`: `pnpm test:e2e` (Chromium; real rag_agent + backend + production frontend; **mock provider**; DB `studyforge_e2e`) | 79 passed, 0 failed (55 existing + 24 new) |
| backend ⇄ rag_agent over real HTTP (manual smoke: MCQ, CQ, Bangla, error paths) | pass |

Defects found by testing during Part 3 and fixed: a `ZodError` from generation settings surfaced as HTTP 500 instead of field errors; bulk/collection operations returned DB order instead of the caller's order and checked collection ownership after the "nothing owned" early return; CQ near-duplicate detection compared the boilerplate lead-in and collapsed distinct CQs (same flaw in the mock's output diversity); unsaved-draft export sent `runQuestionId` without `runId`; the collections list asked for a page size the server refused; a flaky hydration race in an existing Part 2 documents E2E test (fixed in the test); a transient colour-contrast reading on a transitioning button.

Part 2 defects (kept for history): a Hono sub-router's `use("*")` middleware leaked auth onto sibling routes (public download links returned 401); `prisma migrate dev` generated destructive `DROP COLUMN` for the pgvector/tsvector columns (migration recreated from a corrected schema); Playwright starts web servers before `globalSetup` (database preparation moved into the config); a nested-interactive accessibility violation in the model list; the Stop button raced the server's persistence of the interrupted message (UI now refreshes until it is persisted); the mock embedder matched unrelated questions on stop-words (stop-words now ignored).

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

### Part 4 limitations
* **Time:** deadlines are absolute server timestamps; all server instances must have NTP-synchronised clocks. `EXAM_GRACE_SECONDS` (default 5 s) is a deliberate latency allowance — a save/submit that arrives within it after the deadline is accepted; the deadline shown to the user never moves.
* **Server/worker unavailable:** attempts stay IN_PROGRESS in the database and are finalized lazily (any request touching them), by the expiry job or sweeper when the worker returns, or by a leaderboard read; results are identical regardless of when finalization runs because only answers stored ≤ deadline + grace count. If the *API* is down the exam UI keeps unsaved selections locally and says so; answers made after the server deadline are discarded.
* **Author of an individual exam** sees Start enabled before the window opens (the author form of `GET /api/exams/:id` has no `canStart`); the server still refuses with `EXAM_NOT_OPEN` and the UI explains it.
* The group exam author cannot take their own group exam (they know the key); other staff can take it like members.
* Leaderboard SQL was not load-tested with very large groups; capacity is capped at 500 by default.
* Invite codes are shown once; a direct invite to an existing user also stores a user-bound single-use code in that user's notification link.
* `QUOTA_EXCEEDED` is used for the per-author exam limit.
* Ownership transfer, ADMIN-authored key visibility rules beyond the matrix, and e-mail delivery are out of scope.

### Part 3 additions
* **No live provider was ever called**, so the quality of AI-generated questions, the usefulness of the independent solver pass, native structured output on the larger Part 3 schemas, and retrieval for topic + documents with real embeddings are all **unmeasured**. AI-generated questions are never guaranteed correct; the UI says "review before use".
* "Source-quoted" only means a quote was found verbatim in your source, not that the answer is right.
* `max_llm_calls` counts +1 for an adapter-reported repair and +2 for a failed structured call; transient 429/5xx retries inside the adapter are not counted, so real provider calls can exceed the cap slightly. The 85 %-deadline partial-result path is untested (only the hard timeout is).
* Expired generation runs are purged lazily (on that user's list/start), not by a scheduled job. Runs keep the pasted text for `RUN_RETENTION_DAYS` (default 14).
* Two near-duplicate checks exist (rag_agent at generation, backend at save): equivalent rules in two languages, tested separately.
* Bengali PDF shaping was verified on a rendered page for common cases only; print output from a real browser print dialog was not exercised.
* The `mock` provider's retrieval threshold and question content are synthetic; mock-driven E2E proves the plumbing, not the pedagogy.

## Remaining work checklist

**Part 5 — AI result analysis and personalized recommendations** (reads `ExamResult`/`ExamResultItem` + snapshot topics; a model never calculates or changes a score), plus any remaining admin/observability/quotas polish from the plan.

**Part 3/4 leftovers (optional)**
- [ ] Manual end-to-end pass with a real provider key (generate → bank → exam → results) and tuning of retrieval/prompt settings.
- [ ] Question import (JSON round-trip) and CSV export; "used in N exams" indicator on bank questions (data now exists).
- [ ] Scheduled purge of expired `GenerationRun` rows; exam data retention policy.
- [ ] Load test of the leaderboard SQL and the sweeper with thousands of attempts; multi-instance clock-skew check.
- [ ] Optional ownership transfer for groups; optional e-mail channel behind explicit consent.
- [ ] `canStart` on the author form of `GET /api/exams/:id`.

**Carried over**: OCR for scanned PDFs, video transcription (unsupported), live LangSmith run, CI executed on GitHub, real S3/R2/MinIO, real SMTP, other browsers/devices, independent security review, drop the obsolete local `studyforge` database.
