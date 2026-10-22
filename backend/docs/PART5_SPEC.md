# Part 5 — AI feedback and plans, personalized analytics, admin, hardening: normative spec

Status: **frozen contract** for rag_agent, backend and frontend. Change it in the same change set as the code and report deviations. Schema: migration `20261023120000_part5_analysis_ops` (see DATABASE.md). Earlier contracts: PART3_SPEC.md, PART4_SPEC.md, `rag_agent/CONTRACT.md`.

## 0. Principles

1. **AI never touches grading data.** Scores, ranks, bands, counts and topic statistics are computed by existing deterministic code from finalized `ExamResult`/`ExamResultItem` rows. AI output is *derived, disposable text* stored in `ExamAnalysis` / `StudyPlan`; deleting it never affects a result.
2. **Classification is deterministic and shared**: `bandFromPercentBp` (backend `modules/exams/bands.ts`) is the only classifier; the API always returns `band` (+ label/message) and the UI renders it; AI text may *explain* a band, never decide it. A failed or missing AI response always degrades to the deterministic threshold feedback — a result is never blocked on an AI provider.
3. **Only released results are analysed or shown in aggregates.** Analysis/plan/dashboard/assistant use a result only if `isReleased(version, now)` and, for item-level detail (stems, correct answers, explanations), only if the exam's `reviewPolicy` permits it (`FULL`). With `CORRECTNESS` the context contains outcomes and topics but no correct answer/explanation; with `NONE` only counts and topic accuracy.
4. **Minimal, privacy-conscious context.** No user id/name/email, no other users' data, no document text, no raw conversation. Bounded sizes (§2). Provider keys come from the caller's own BYOK credential only; no cross-user caching.
5. **Never invent.** Every number and topic in AI output must come from the supplied context (verified in code, §6); claims about "mastery", "improvement over time" or "trends" are only permitted when the *backend-computed* `dataLevel` is `BASED_ON_HISTORY`; otherwise recommendations are labelled **initial suggestions** (set by code, not by the model).
6. **Idempotent, retryable, bounded jobs**: one `ExamAnalysis` per result (unique), one `StudyPlan` per `(user, fingerprint)`; retries reuse the row; ≤ `ANALYSIS_MAX_ATTEMPTS` automatic attempts; a user may retry manually (rate limited); a failure leaves `status=FAILED` + `errorCode` and never alters results or other rows.
7. Everything is scoped to the authenticated user (or, for group views, to authorized group members under the Part 4 release/visibility rules). Foreign ids → 404.

## 1. Data levels (computed by the backend, never by the model)

`dataLevel` for a user (over released finalized results): `NONE` (0 results), `INITIAL` (1–2 results **or** fewer than 5 answered questions in every topic), `BASED_ON_HISTORY` (≥ 3 results **and** at least one topic with ≥ 5 answered questions across them). A *weak topic* needs ≥ 3 answered questions in that topic and accuracy < 70 % (`accuracyBp < 7000`); a *strong topic* needs ≥ 3 answered and ≥ 85 %. Topics with fewer answered questions are "not enough data", never labelled weak/strong. `accuracyBp = round_half_up(correct / (correct + incorrect + unanswered) × 10000)` (unanswered count as not correct). A zero score is a number; absence of results is `null`/`NO_DATA` — the API and UI keep them distinct.

## 2. Limits (env, see `.env.example`)
`AI_MONTHLY_TOKEN_LIMIT`/`AI_MONTHLY_REQUEST_LIMIT` (0 = unlimited; calendar month UTC; checked together with the daily caps before any AI call), `ANALYSIS_MAX_ATTEMPTS` (3), `ANALYSIS_MAX_OUTPUT_TOKENS` (1500), `ANALYSIS_MAX_INCORRECT_ITEMS` (15), `ANALYSIS_RETRY_PER_HOUR` (6, per user), `STUDY_PLAN_MAX_PER_USER` (20 kept; oldest deleted), `METRICS_RETENTION_DAYS` (14), `METRICS_FLUSH_SECONDS` (30). Context text caps: stem ≤ 300 chars, option/explanation/note ≤ 400, topic ≤ 60, total context ≤ 12 000 chars.

## 3. Workflow A — post-exam result analysis

### 3.1 Backend (`modules/analysis`)
* **Trigger:** (a) automatically when a result becomes visible — in `afterFinalized` if `isReleased` (IMMEDIATE), and in the `exam.release` job / sweeper for AFTER_CLOSE / AT_TIME — **only if** `UserPreference.autoAiFeedback` and the user has an ANALYSIS (else DEFAULT) model + key; (b) on demand `POST /api/analysis/attempts/:attemptId`.
* **Job `exam.analysis`** `{ resultId }`, `dedupeKey exam-analysis:<resultId>`, `maxAttempts = ANALYSIS_MAX_ATTEMPTS`, exponential backoff via `RetryableJobError`; handler:
  1. load the result **by id with `userId` from the row**, check release + ownership again (defence in depth), 2. `assertWithinQuota` (daily+monthly) — quota exhaustion ⇒ `status=FAILED`, `errorCode=QUOTA_EXCEEDED` (no retry storm), 3. resolve model/key (`NOT_CONFIGURED` ⇒ `status=NOT_CONFIGURED`, no retry), 4. build the context (§3.2), 5. call rag_agent `POST /v1/analyze/result`, 6. re-validate the output with the backend Zod schema (topics ⊆ context topics, enums, sizes), 7. upsert `ExamAnalysis` (`READY`, content, provider/model, tokens, `generatedAt`), `recordUsage(task: "ANALYSIS")`. Transient provider errors (`PROVIDER_RATE_LIMITED`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `UPSTREAM_UNAVAILABLE`) ⇒ `RetryableJobError`; auth/model/validation errors ⇒ permanent `FAILED` with the normalised code (credential marked invalid on `PROVIDER_AUTH_INVALID`). A failed job NEVER modifies the result and a re-run never creates a second row.
* **API** (owner only; not-released ⇒ `409 CONFLICT` with `details.released=false`):
  * `GET /api/analysis/attempts/:attemptId` → `{ analysis: AnalysisView }`
  * `POST /api/analysis/attempts/:attemptId` → `202 { analysis: AnalysisView }`: creates/re-queues. Rules: `READY` ⇒ returns it unchanged (no new AI call) unless body `{ regenerate: true }`; `PENDING` ⇒ returns it; `FAILED`/`NOT_CONFIGURED` ⇒ re-queue (attempts reset). Rate limit `ANALYSIS_RETRY_PER_HOUR`/user. Audit `analysis.requested`.
```ts
type AnalysisView = {
  attemptId: string; status: "PENDING" | "READY" | "FAILED" | "NOT_CONFIGURED" | "NONE";   // NONE = never requested
  deterministic: { band: FeedbackBand; label: string; message: string; percentBp: number };   // ALWAYS present (also when AI failed)
  content: AnalysisContent | null; generatedAt: string | null; provider: string | null; model: string | null;
  errorCode: string | null; canRetry: boolean; dataLevel: "NONE" | "INITIAL" | "BASED_ON_HISTORY";
  disclaimer: "AI-generated from your verified results. It does not change your score.";
};
type AnalysisContent = {
  summary: string;                                         // 1–3 sentences, supportive, specific, refers only to supplied facts
  strengths: { topic: string; detail: string }[];          // ≤ 4, topics from the data and "strong" by §1 rules
  weaknesses: { topic: string; detail: string; evidence: string }[];   // ≤ 4; evidence quotes the supplied counts, e.g. "2 of 5 correct"
  nextSteps: { type: StepType; topic: string | null; text: string }[]; // 2–5 practical actions
  caveats: string[];                                       // ≤ 3; e.g. small samples; the single-exam limitation
};
type StepType = "REVIEW_NOTES" | "REVISIT_QUESTIONS" | "PRACTICE_MCQ" | "PRACTICE_CQ" | "COMPARE_ATTEMPTS" | "ASK_ASSISTANT" | "READ_DOCUMENT";
```
### 3.2 Context sent to rag_agent (built only by the backend)
```jsonc
{ "language": "en" | "bn",                       // user's locale preference
  "exam": { "title": "…", "question_count": 20, "percent_bp": 7250, "band": "NEEDS_IMPROVEMENT", "correct": 14, "incorrect": 4, "unanswered": 2 },
  "topics": [ { "topic": "Cells", "questions": 8, "correct": 6, "incorrect": 2, "unanswered": 0, "accuracy_bp": 7500 } ],
  "incorrect_items": [ { "topic": "Cells", "stem": "…≤300", "selected_text": "…", "correct_text": "…|null", "explanation": "…|null", "note": "…|null" } ],  // ≤ ANALYSIS_MAX_INCORRECT_ITEMS; correct_text/explanation/note only if reviewPolicy FULL
  "history": { "data_level": "INITIAL|BASED_ON_HISTORY", "results_total": 4, "previous_same_exam": [ { "percent_bp": 6000 } ], "topic_history": [ { "topic": "Cells", "answered": 15, "accuracy_bp": 6800 } ] } }
```
No ids, names, e-mail, document text. `topic = null` is sent as "General".

## 4. Workflow B — personalized improvement plan

* **Deterministic part (always available, no AI):** `GET /api/analysis/plan` returns `dataLevel`, `weakTopics`, `strongTopics`, `notEnoughData` topics and **suggested actions** built by code from the data: for each weak topic (max 5): `REVIEW_NOTES` (link `/question-bank?topic=…`), `REVISIT_QUESTIONS` (link to a retry of that topic's questions in the bank), `PRACTICE_MCQ` (`/mcq?topic=<topic>&grounding=GENERAL` prefill), `ASK_ASSISTANT`; plus `COMPARE_ATTEMPTS` when ≥ 2 results exist for one exam. With `dataLevel=NONE` it returns an empty list and an explanatory empty state.
* **AI part:** `POST /api/analysis/plan` → `202 { plan: PlanView }` creates/reuses the `StudyPlan` for `fingerprint = sha256(sorted topic stats + result percent list + locale)`; same data ⇒ same row (no duplicate); changed data ⇒ new row; job `study-plan` `{ planId }` mirrors §3.1 (bounded retries, `NOT_CONFIGURED`, quota, failure codes). Keep the newest `STUDY_PLAN_MAX_PER_USER`. `GET /api/analysis/plan` returns the deterministic part plus the latest plan (`status`, `content`, `stale: boolean` when the fingerprint no longer matches current data).
```ts
type PlanView = { id: string; status: AnalysisView["status"]; label: "INITIAL_SUGGESTIONS" | "BASED_ON_HISTORY";   // label set by code from dataLevel
  content: { headline: string; focus: { topic: string; reason: string }[]; steps: { type: StepType; topic: string | null; text: string; minutes: number | null }[]; caveats: string[] } | null;
  basis: { results: number; topics: number; answered: number }; generatedAt: string | null; errorCode: string | null; stale: boolean; canRetry: boolean };
```
Allowed claims: a single exam can't "prove mastery" — the plan caveats must say so when `dataLevel ≠ BASED_ON_HISTORY`.

## 5. Workflow C — study assistant (`modules/assistant`)
`POST /api/assistant/sessions` `{ kind, attemptId?, questionId?, topic?, documentIds?, policy? }` → `201 { conversationId, prompt, href }` or `{ href }` (no conversation) per kind. The assistant **reuses the Part 2 conversation engine and policies** (document-only vs general, authorization, quotas, injection defences); the backend only creates the conversation and builds a first prompt from data the caller is already authorized to see:
| kind | behaviour |
|---|---|
| `EXPLAIN_INCORRECT` | needs `attemptId`+`questionId`; the caller's own released result with `reviewPolicy=FULL` and outcome INCORRECT/UNANSWERED (else `NOT_ELIGIBLE`/409); prompt contains the snapshot stem, options, the caller's choice, the correct option and the stored explanation; conversation mode GENERAL (explanations may use general knowledge) |
| `TOPIC_SUMMARY` | needs `topic` + `documentIds` (caller's READY docs; uses the same document checks as chat); conversation mode DOCUMENT_ONLY — the Part 2 fallback message applies when documents don't cover it |
| `REVISION_PLAN` | prompt built from the deterministic plan data (weak topics + counts); GENERAL |
| `PRACTICE_QUESTIONS` | no AI call here: returns `href` `/mcq?topic=…` (prefill, user confirms generation) |
| `RELATED_CQ` | returns `href` `/cq?topic=…` |
The first `prompt` is returned to the client which sends it through the existing `POST /api/conversations/:id/messages` stream (so usage, citations and Stop work as usual). Rate limit 20/hour/user.

## 6. rag_agent (new endpoints; Python; LangGraph; JSON, not SSE)
Contract section **§10 "Analysis (Part 5)"** in `rag_agent/CONTRACT.md`. Both endpoints are bearer-protected, take the same `chat` credentials block as chat (`SecretStr` key, redaction, no cross-provider fallback), validate their `context` strictly (sizes above) and respond with `{ result: {...}, usage: { prompt_tokens, completion_tokens, llm_calls }, warnings: [] }` or the standard error shape (`GENERATION_FAILED` with `reason` ∈ `INVALID_OUTPUT|UNGROUNDED_OUTPUT`).
* `POST /v1/analyze/result` — body `{ request_id, user_id?, chat: {provider, api_key, model, params}, context: §3.2 }`; result = `AnalysisContent` (snake_case → backend maps to camelCase).
* `POST /v1/analyze/plan` — body `{ request_id, chat, context: { language, data_level, results: [{percent_bp}], topics: [{topic, questions, correct, incorrect, unanswered, accuracy_bp}] } }`; result = plan content (`headline`, `focus`, `steps`, `caveats`; **no `label`** — set by the backend from `data_level`).
**LangGraph (bounded, typed state, keys only in closures):** `validate → prepare → generate (structured) → verify → [repair once] → finalize`, else error. **Deterministic verification** (code): schema; every `topic` ∈ context topics (or null where allowed); `strengths`/`weaknesses` topics respect the §1 rules supplied in the context (`strong_topics`, `weak_topics` lists are computed by the backend and passed; the model may only choose among them); every numeric token (digits, incl. Bangla digits normalised) in any text field must be derivable from the context (allowed set = counts, percentages rounded to integer and one decimal, `a of b` forms); with `data_level ≠ BASED_ON_HISTORY` the output must not contain mastery/trend phrases (small multilingual banned-phrase list) and must include a caveat; length caps; language script check (bn ⇒ mostly Bengali script, technical terms allowed); leak filter (key/canary); no URLs/markdown links; at most 5 steps. One repair attempt with the rejection reasons; then error `UNGROUNDED_OUTPUT`/`INVALID_OUTPUT`. Prompts: system constants with canary; context only in the delimited **user** turn; stems/explanations are untrusted data (injection defences as in Part 3 `render_sources` neutralisation). Mock provider (`ALLOW_MOCK_PROVIDER=1`, tests only) produces deterministic, *grounded* output from the context and supports markers in the exam title or a topic: `[[fail]]`, `[[rate-limit]]`, `[[bad-json-once]]`, `[[bad-json-always]]`, `[[ungrounded]]` (invents a number → must be rejected), `[[slow]]`.

## 7. Analytics API (`modules/analytics`, all caller-scoped, released results only)
* `GET /api/analytics/me` → `{ dataLevel, totals: { completed, average|null, highest|null, lowest|null, correct, incorrect, unanswered }, bandCounts, trend: [{ attemptId, examId, examTitle, finalizedAt, percentBp, band }] (chronological, last 50), topics: [{ topic, questions, correct, incorrect, unanswered, accuracyBp }] (weakest first; includes a `sufficient` flag per §1), weakTopics, strongTopics, recentFeedback: [{ attemptId, examTitle, status, summary|null, generatedAt|null }] (last 5), suggestions: [{ type, topic|null, label, href, reason }] (deterministic, ≤ 6), saved: { collections, mcqQuestions, cqQuestions, questionsWithNotes, recentCollections: [{id,title,questionCount}] }, groups: [{ id, title, role, nextExam: {examId,title,opensAt|closesAt}|null }], unreadNotifications }` (percent values in basis points; `null` = no data).
* `GET /api/analytics/me/results?page&pageSize≤50` → paginated released results `{ items: [{ attemptId, examId, examTitle, finalizedAt, scoreCenti, maxCenti, percentBp, band, correct, incorrect, unanswered }], total, page, pageSize }`. Totals/trend/leaderboard share the same SQL source of truth: **a finalized result has the same score everywhere** (tested).
* `GET /api/exams/:id/topics` (group exams; members under the Part 4 release/visibility rules; staff after release) → `{ released, topics: [{ topic, questions, participants, accuracyBp }], completion: { eligible, submitted, timedOut, inProgress, notStarted, missed } }` — aggregates only, no per-user rows, `participants` ≥ 3 else the topic is omitted (small-group privacy).

## 8. Usage and cost controls
* `GET /api/ai/usage` (existing, extended) → `{ daily: {tokens, requests, tokenLimit, requestLimit, resetsAt}, monthly: {tokens, requests, tokenLimit, requestLimit, resetsAt}, byTask: [{ task, requests, tokens }] (last 30 days; UsageRecord metadata.task), note }` with the note: *"Tokens are what your provider reports. StudyForge does not know your provider's prices and shows no cost estimate."*
* `assertWithinQuota` checks daily **and** monthly caps; every AI path (chat, generation, regeneration, analysis, plan, assistant via chat) calls it before spending the user's key; exhaustion ⇒ `QUOTA_EXCEEDED` with `details.resetsAt` and which window.
* All AI paths have timeouts, bounded retries and cancellation (Part 2/3/this part). No cross-user caching of private content anywhere (the only cache is the per-credential model list).

## 9. Admin (`modules/admin`)
Roles: `USER`, `SUPPORT` (read-only), `ADMIN`. Permissions (catalogue in `auth/permissions.ts`): `admin:users:view` (ADMIN, SUPPORT), `admin:users:manage` (ADMIN), `admin:audit:view`, `admin:metrics:view`, `admin:jobs:view`, `admin:health:view` (ADMIN, SUPPORT), `admin:jobs:manage`, `admin:config:view` (ADMIN). Non-holders get **404** (the surface does not advertise itself). Every mutation is audited with actor, target and a non-sensitive summary.
* `GET /api/admin/overview` (existing path; moves into this module) — users, verified, new (7 d), active sessions, suspended, documents (by status, bytes), jobs summary, last 10 audit events.
* `GET /api/admin/users?q&status&role&page&pageSize≤50` → `{ items: [{ id, name, email, role, status, emailVerified, createdAt, lastSessionAt|null, documents, storageBytes, tokens30d }], total }` (SUPPORT sees e-mail masked `a***@d***.com`; ADMIN sees full). **Never** conversations, documents' names/content, keys, answers or attempts.
* `PATCH /api/admin/users/:id` `{ status?: "ACTIVE"|"SUSPENDED"; role?: "USER"|"SUPPORT"|"ADMIN"; reason? }` (ADMIN): cannot change own status/role; cannot remove the last ADMIN; suspending **revokes all of the user's sessions** immediately; audit `admin.user_status_changed` / `admin.user_role_changed`. `POST /api/admin/users/:id/revoke-sessions` (ADMIN).
* `GET /api/admin/usage` → storage and processing: documents by status, bytes total, top 10 users by bytes (id + name + bytes only), ingestion jobs by status, average processing time; AI tokens/requests by task for the last 7/30 days (aggregate).
* `GET /api/admin/metrics?hours=24` → hourly series from `MetricBucket`: API requests by status class (2xx/3xx/4xx/5xx) and route group, p-less counts only (no latency claims), provider calls by provider/task/outcome and error code, rate-limit blocks by limiter prefix, quota blocks. Collection: in-memory counters flushed every `METRICS_FLUSH_SECONDS` (and on shutdown) by `lib/metrics.ts`; retention `METRICS_RETENTION_DAYS` purged by the sweeper; labels never contain user ids, paths with ids, or content.
* `GET /api/admin/jobs` → counts by type × status, oldest pending age, recent failures `{ id, type, attempts, lastError (redacted, ≤200 chars), updatedAt }`; `POST /api/admin/jobs/:id/retry` (ADMIN; FAILED only; audit).
* `GET /api/admin/health` → `{ database, ragAgent, worker: {lastBeatAt, ageSeconds, status}, queue: {pending, running, failed, oldestPendingSeconds}, storage: {driver, writable}, versions: {...} }` — no secrets, no URLs with credentials.
* `GET /api/admin/audit?action&actor&from&to&page&pageSize≤100` → events (action, targetType, targetId (truncated), actor id prefix, ip hash prefix, createdAt, **metadata allow-listed keys only**).
* `GET /api/admin/config` (ADMIN) → effective **non-secret** configuration (limits, flags, provider list, storage driver, mock-provider status); secret env values are never returned or echoed.
* The worker writes `ServiceHeartbeat('worker')` from the sweeper tick. **Not provided on purpose:** any endpoint exposing another user's conversations, documents, credentials, exam answers; there is no "impersonate" or "break-glass" access in this release (documented as a limitation; adding one requires an explicit, scoped, audited design).

## 10. Frontend (summary)
Dashboard (`/dashboard`): totals (with "no data" vs 0), trend line, topic accuracy bars, correct/incorrect breakdown, recent results (paged), AI feedback cards, weak-topic recommendations & suggested practice, saved collections/CQ/notes, groups, notifications, "continue learning" actions — Recharts with text alternatives, skeletons, empty states. Result page: deterministic feedback + AI feedback card (status, retry, disclaimer) + "Ask the study assistant". Study plan page (`/study-plan`). Settings: auto-AI-feedback toggle (`PUT /api/preferences` gains `autoAiFeedback`), usage card (§8). Admin UI (`/admin/*`): overview, users, usage, metrics, jobs, health, audit, config — role-aware (SUPPORT sees no mutation controls). i18n: cookie-based locale (`en`/`bn`), message catalogs, `Intl` formatting; AI text rendered as safe Markdown only.
