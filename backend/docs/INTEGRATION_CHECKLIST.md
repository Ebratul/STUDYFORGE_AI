# Integration checklist (Parts 1–5)

Maps every required capability to where it lives and which automated test exercises it. ✅ = implemented and covered by a test that ran; 🟡 = implemented, partly covered (see note); ⛔ = not implemented. File names are relative to `backend/tests/{unit,integration}`, `rag_agent/tests`, `frontend/tests/{unit,e2e}`.

| # | Capability | Implementation | Tests | Status |
|---|---|---|---|---|
| **Part 1 — foundation** | | | | |
| 1 | Register / login / recovery / verification / sessions | `auth/auth.ts`, `modules/account/*`, frontend `(auth)` | `auth.test`, `account.test`, e2e `public-and-auth` | ✅ |
| 2 | RBAC (USER/SUPPORT/ADMIN), ownership primitives | `auth/permissions.ts`, `auth/authorize.ts` | `permissions.test`, `authorize.test`, `authorization.test` | ✅ |
| 3 | Security headers, CSP nonce, CSRF origin guard, rate limits | `frontend/src/proxy.ts`, `next.config.ts`, `http/middleware.ts`, `lib/rate-limit.ts` | `hardening.test`, `rate-limit.test`, e2e headers | ✅ |
| 4 | Profile, preferences, privacy (export, deletion, sessions) | `modules/account/*` | `account.test`, `account-deletion.test`, e2e | ✅ |
| **Part 2 — AI, documents, RAG, chat** | | | | |
| 5 | Provider adapters (OpenAI/OpenRouter/Groq) | `rag_agent/app/providers/*` | `test_provider_adapters`, `test_models_and_credentials` (mocked HTTP) | 🟡 never run live |
| 6 | BYOK encryption, masking, rotation | `lib/crypto.ts`, `modules/ai/credentials.ts` | `crypto.test`, `credentials.test`, e2e `ai` | ✅ |
| 7 | Document upload/validation/storage/jobs | `modules/documents/*`, `modules/jobs/*` | `upload-validation.test`, `documents.test`, `jobs.test`, `storage-s3.test`, rag `test_extract/ingest_pipeline` | ✅ (S3 only vs mock) |
| 8 | Retrieval isolation (owner/version/READY) | `rag_agent/app/retrieval`, DB trigger | `documents.test`, rag `test_retrieval` | ✅ |
| 9 | Document-only vs general chat, verification, fallback | `rag_agent/app/graphs/{document_only,general}`, `modules/conversations/*` | rag `test_graph_*`, `conversations.test`, e2e `ai` | ✅ |
| 10 | Prompt-injection / leak defences | `rag_agent/app/prompts.py`, `citations.py` | rag graph tests (hostile fixtures), e2e | 🟡 scripted models only |
| 11 | Usage tracking, daily + monthly quotas | `modules/ai/usage.ts` | `usage-quota.test`, `conversations.test` | ✅ |
| **Part 3 — generation and bank** | | | | |
| 12 | MCQ/CQ generation (bounded LangGraph, validation) | `rag_agent/app/graphs/generation.py`, `modules/questions/generation.ts` | rag `test_generation_*`, `generation.test`, e2e `questions` | 🟡 mock provider |
| 13 | Question schema, provenance, editing, revisions | `modules/questions/*` | `question-schemas.test`, `questions.test` | ✅ |
| 14 | Collections, search, bulk, export (JSON/TXT/PDF) | `modules/questions/{collections,export}` | `collections.test`, `export.test`, `export-*.test` | ✅ |
| **Part 4 — exams and groups** | | | | |
| 15 | Exam drafts, publication, immutable snapshots | `modules/exams/{service,snapshot}.ts`, DB triggers | `exams-drafts.test` (raw-SQL UPDATE rejected) | ✅ |
| 16 | Server-authoritative attempts, autosave, idempotent finalization, jobs | `modules/exams/{attempts,jobs}.ts` | `exams-attempts.test` (race tests on real locks), e2e `exams` | ✅ (single Postgres) |
| 17 | Deterministic grading, exact bands | `modules/exams/{grading,bands}.ts` | `exam-grading.test`, `analytics-me.test` (boundaries via API) | ✅ |
| 18 | Results, release/review policies, no key leakage | `modules/exams/results.ts` | `exams-results.test` (JSON leak scans) | ✅ |
| 19 | Groups, roles, hashed invites, capacity, rate limits | `modules/groups/*`, DB triggers | `groups-core/invites.test`, `group-invites.test`, e2e `groups` | ✅ |
| 20 | Leaderboard (1,2,2,4), distribution, privacy | `modules/groups/leaderboard.ts` | `groups-leaderboard.test`, e2e | ✅ |
| 21 | In-app notifications, idempotent | `modules/account/notifications.ts` (`notifyUsers`) | module tests (dedupe) | ✅ |
| **Part 5 — AI agents, analytics, ops** | | | | |
| 22 | Workflow A: post-exam analysis (LangGraph, verified, retryable, never alters results) | `rag_agent/app/graphs/analysis.py`, `modules/analysis/*` | rag `test_analysis_*`, `analysis-core.test`, `analysis-verify.test`, e2e `dashboard` | 🟡 mock provider |
| 23 | Workflow B: improvement plan (data levels, labels, fingerprint) | `modules/analysis/plan.ts`, `modules/analytics/stats.ts` | `analysis-plan.test`, `analytics-stats.test` | 🟡 mock provider |
| 24 | Workflow C: study assistant (reuses Part 2 policies) | `modules/assistant/*` | `assistant.test`, e2e | ✅ gating; 🟡 live answers |
| 25 | Student dashboard from real data; null vs zero | `modules/analytics/*`, frontend `dashboard` | `analytics-me.test`, `dashboard-ui.test`, e2e `dashboard` | ✅ |
| 26 | Group analytics consistency & privacy | `modules/groups/topics.ts` | `analytics-group-topics.test` (consistency test across dashboard/results/leaderboard) | ✅ |
| 27 | Background jobs: retries, status, idempotency, failure isolation | `modules/jobs/*`, `analysis/jobs.ts`, `exams/jobs.ts`, `admin/jobs.ts` | `jobs.test`, `analysis-core.test`, `exams-attempts.test` | ✅ |
| 28 | Admin console (least privilege, audit, no private content) | `modules/admin/*`, frontend `/admin` | `admin.test`, `admin-metrics.test`, `hardening.test`, e2e `admin` | ✅ |
| 29 | Usage limits and cost controls | env limits, `ai/usage.ts` | `usage-quota.test`, module limit tests | ✅ (no cost estimates by design) |
| 30 | Metrics, health, correlation ids, structured logs | `lib/metrics.ts`, `admin/service.ts`, `http/middleware.ts` | `admin-metrics.test`, `hardening.test` | ✅ |
| 31 | i18n (en/bn), locale formatting | frontend `lib/i18n` | `i18n` unit tests, e2e `i18n` | see IMPLEMENTATION_STATUS (coverage listed there) |
| 32 | CI, Docker, scans, smoke, env-docs | `.github/workflows/ci.yml`, Dockerfiles, `backend/scripts/*` | `env-docs` tests; local runs recorded in CI_NOTES | 🟡 GitHub Actions never executed |
| 33 | Full user journey (register → … → recovery) | — | e2e `journey` | see IMPLEMENTATION_STATUS |

## Defects found by the Part 5 audit and fixed (not hidden in the UI)
* Duplicate band tables in the frontend (`exams.ts`, `leaderboard.ts`) → one `lib/bands.ts`; backend duplicates of the five thresholds (leaderboard distribution SQL, test fixture, dashboard band counting from a stored column) → single classifier `bandFromPercentBp` / `DISTRIBUTION`.
* Password change only revoked other sessions if the client asked → server-side hook.
* Dashboard exam figures were computed separately from analytics → one query source (`analytics/sources.ts`), consistency test.
* Deleting a group owner silently removed members' group exams → members are now notified first.
* Admin surface was a single overview page with a role check scattered in code → permission catalogue, SUPPORT role, audited mutations, tests that an admin cannot reach user content.
* CI never validated migrations, audits or secrets and used a stale install command → rewritten (see CI_NOTES).
* `.env.example` drift (`NODE_ENV`, `RAG_AGENT_TIMEOUT_MS`, `VIDEO_UPLOADS_ENABLED`) → documented and guarded by tests.
