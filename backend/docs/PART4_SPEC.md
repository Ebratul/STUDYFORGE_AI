# Part 4 — exams, attempts, grading, groups, leaderboards: normative spec

Status: **frozen contract** for backend, frontend and tests. If implementation shows a change is needed, keep the system working, change this file in the same change set, and report the deviation. Schema: `backend/prisma/schema.prisma` (migration `20261023020000_part4_exams_groups`), described in [DATABASE.md](DATABASE.md).

Reuses: question bank (Part 3: `Question`, `QuestionOption`, `QuestionCollection`), auth/ownership primitives, the Postgres job queue and worker (Part 2), notifications (Part 1), `AppError` envelope, rate limiter. Nothing here calls an AI provider: **grading is deterministic code**; AI analysis/recommendations are Part 5.

## 0. Principles

1. **The server is the only authority** on time, eligibility, answers' validity, scores, ranks and who may see what. The browser clock is a display aid only (§5.5).
2. **No answer key on the wire before release.** Exam-taking payloads contain no `isCorrect`, explanation, note or source. Release is evaluated per request from server time (§8).
3. **Immutable after publish.** A published `ExamVersion`, its question/option snapshots and finalized `ExamResult`/items are never updated (DB triggers reject `UPDATE`); bank edits can't change them.
4. **Idempotent and race-safe finalization.** One result per attempt (`ExamResult.attemptId` unique), serialized by a row lock; manual submit, expiry job, sweeper and lazy finalization all call the same function.
5. **Integer math.** Marks are stored/computed in *centi-marks* (marks × 100, integers). Negative-marking fraction is in basis points. No floating-point accumulation anywhere in grading.
6. Foreign ids behave like missing ids (404); no existence oracle for exams, attempts, groups, invites.
7. In-app notifications only; **no e-mail is sent** (no provider/consent flow exists).

## 1. Domain model (summary; see schema)

`Exam` (draft + status) → `ExamVersion` (immutable published snapshot header) → `ExamQuestionSnapshot` → `ExamOptionSnapshot`.
`ExamAttempt` (server `startedAt`/`deadlineAt`, participant-specific `questionOrder`/`optionOrder`) → `AttemptAnswer`; `ExamResult` (1:1 with attempt) → `ExamResultItem`.
`Group` → `GroupMember(role OWNER|ADMIN|MEMBER)`, `GroupInvite(codeHash, expiresAt, revokedAt, maxUses/useCount, forUserId?)`; group exams are `Exam`s with `mode=GROUP, groupId`.
`ExamVersionState` records one-time fan-out markers (reminder sent, publish notified, results-available notified). `Notification` gained `link` and a per-user idempotency `dedupeKey`.

Only **MCQ** questions can be in an exam (CQ is study content). Individual exams are taken by their author (self-assessment, repeatable up to the attempt limit). Group exams are taken by group members.

## 2. Limits (env; exposed by `GET /api/exams/limits`)

| Env | Default | |
|---|---|---|
| `EXAM_MAX_QUESTIONS` | 200 | questions per exam |
| `EXAM_MAX_DURATION_MINUTES` | 360 | duration cap |
| `EXAM_MAX_ATTEMPT_LIMIT` | 10 | attempts per participant |
| `EXAM_MAX_DRAFTS_PER_USER` | 100 | draft+published exams authored |
| `EXAM_GRACE_SECONDS` | 5 | latency allowance for saves/submits at the deadline (§5.3) |
| `EXAM_SWEEP_INTERVAL_SECONDS` | 60 | sweeper cadence |
| `GROUP_MAX_OWNED_PER_USER` / `GROUP_MAX_MEMBERSHIPS_PER_USER` | 20 / 50 | |
| `GROUP_MAX_CAPACITY` / `GROUP_DEFAULT_CAPACITY` | 500 / 30 | capacity includes the owner |
| `INVITE_DEFAULT_TTL_HOURS` / `INVITE_MAX_TTL_HOURS` | 168 / 720 | |
| `INVITE_MAX_USES` / `INVITE_MAX_ACTIVE_PER_GROUP` | 500 / 20 | |
| `INVITE_ATTEMPTS_PER_HOUR_USER` / `_IP` | 20 / 60 | code-guess rate limits |

Field limits: title 1–120, description ≤ 1000, group title 1–80, group description ≤ 500, per-question marks 0.25–100 (2 decimals), `negativeMarking.fraction` 0–1 (≤ 4 decimals), `reminderMinutes` 1–10080.
Frontend constants come from the limits endpoint, never hard-coded.

## 3. Exam configuration (draft) — `ExamDraftInput`

```ts
type ExamDraftInput = {
  title: string; description?: string | null;
  questionIds: string[];                      // ordered; each an MCQ owned by the author; unique; ≤ EXAM_MAX_QUESTIONS
  marks: { perQuestion: number; overrides?: Record<string /*questionId*/, number> };   // default 1; overrides must reference selected questions
  negativeMarking: { fraction: number };      // 0 = off; 0.25 = lose a quarter of the question's marks for a wrong answer
  durationMinutes: number;                    // 1..EXAM_MAX_DURATION_MINUTES
  attemptLimit: number;                       // 1..EXAM_MAX_ATTEMPT_LIMIT (per participant)
  window: { opensAt?: string | null; closesAt?: string | null };   // ISO-8601 UTC
  lateStart: "CAP_AT_CLOSE" | "FULL_TIME_ONLY";
  lateJoinGroup: boolean;                     // group exams: may members who joined after publication take it?
  shuffleQuestions: boolean; shuffleOptions: boolean;
  reviewPolicy: "NONE" | "CORRECTNESS" | "FULL";
  release: { mode: "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME"; at?: string | null };
  leaderboardVisible: boolean;                // group exams only
  reminderMinutes?: number | null;            // group/individual with opensAt: in-app reminder this long before opensAt
};
```
`POST /api/exams` creates a draft `{ title, description?, mode, groupId? }` (mode/group are immutable afterwards). Saving a draft (`PUT /api/exams/:id/draft`) validates structure and ranges immediately (strict: unknown keys rejected, strings NFC-trimmed) and that selected questions are the author's own MCQs; it permits an incomplete draft (e.g. no questions yet). **Publishing** applies the full rule set (§4).

Semantics:
* **Marks:** question marks = `overrides[qid] ?? perQuestion`, converted to centi-marks. `totalCenti = Σ marksCenti`.
* **Negative marking:** `negativeCenti = round_half_up(marksCenti × fraction)` computed once at publish and stored per snapshot question (`negativeMarkingBp = round(fraction × 10000)` stored on the version). A wrong answer awards `−negativeCenti`; unanswered awards 0.
* **Window:** `opensAt` = earliest start; `closesAt` = no attempt may run past it. Without `closesAt` an exam is open until cancelled.
* **`lateStart`** (only meaningful with `closesAt`): `CAP_AT_CLOSE` — a late starter may start any time before `closesAt` but `deadlineAt = min(start + duration, closesAt)` (less time); `FULL_TIME_ONLY` — starting is refused once `start + duration > closesAt` (everyone who can start gets the full duration).
* **Release** (§8): `IMMEDIATE` (each participant on finalization), `AFTER_CLOSE` (needs `closesAt`; released at `closesAt + grace`), `AT_TIME` (needs `at`; if `closesAt` is set `at` must be ≥ `closesAt`).
* **`reviewPolicy`:** `NONE` = score only; `CORRECTNESS` = per-question right/wrong + the participant's own choice, no correct option/explanation/note/sources; `FULL` = also correct option, explanation, short note, sources.

## 4. Publication (`POST /api/exams/:id/publish`)

One transaction (`SELECT … FOR UPDATE` on the exam row; second publish → `CONFLICT`):
1. Caller must be the exam's author; for group exams the caller must currently be **OWNER or ADMIN** of the group (`NOT_ELIGIBLE`/404 otherwise).
2. Full validation, field errors as `details.fields` with dotted paths: ≥ 1 question; every question exists, is the caller's, is an MCQ, has 2–6 non-blank options, **exactly one correct option** (re-checked from the stored rows, not trusted from earlier validation), unique texts; `questionCount ≤ max`; marks > 0 and ≤ 100; `fraction` ∈ [0,1]; `durationMinutes` ≤ max; `attemptLimit` ≤ max; if both window ends: `closesAt > opensAt`; `closesAt` must be in the future; `FULL_TIME_ONLY` requires `closesAt − max(now, opensAt) ≥ duration` (else the exam could never be started); release rules (§3); `reminderMinutes` requires `opensAt` in the future; `leaderboardVisible`/`lateJoinGroup` meaningful only for GROUP (ignored/false for INDIVIDUAL).
3. Create `ExamVersion` (version 1) + `ExamQuestionSnapshot`/`ExamOptionSnapshot` rows copied from the *current* bank rows (stem, options + correct flag, explanation, short note, topic, subject, difficulty, language, source evidence **without document ids**, `sourceQuestionId`, `sourceQuestionVersion`). `snapshotHash` = SHA-256 of the canonical JSON of the full snapshot (questions + options + marks + grading rules + window/policies); stored and re-verifiable (`GET /api/exams/:id` for the author reports `snapshotIntegrity: "OK"` by recomputing).
4. Exam → `PUBLISHED`, `currentVersion = 1`, `publishedAt`. Insert `ExamVersionState`. Audit `exam.published`.
5. After commit (idempotent): group exam → notify all current members except the author `exam.group_published` (`link: /exams/:id`, dedupe `exam-published:<versionId>`; `lateJoinGroup=false` ⇒ only members present at publication are eligible *and* notified); schedule jobs (§5.7).
Published exams cannot be edited; the author may **cancel** (`CANCELLED`: no new attempts; in-progress attempts finish normally) or **duplicate** (copies the draft config + question ids into a new draft). Drafts may be deleted. A published exam with attempts can't be deleted (cancel instead).

## 5. Attempts, timing, autosave, finalization

### 5.1 Eligibility and start — `POST /api/exams/:id/attempts` (idempotent)
Allowed iff all hold (else the listed error): exam is `PUBLISHED` (`EXAM_CLOSED`); INDIVIDUAL → caller is the author, GROUP → caller is a **current member**, **not the author** (`NOT_ELIGIBLE`; the author knows the key), and joined at or before `publishedAt` unless `lateJoinGroup`; `now ≥ opensAt` (`EXAM_NOT_OPEN`, details `opensAt`); `now < closesAt` (`EXAM_CLOSED`); `lateStart=FULL_TIME_ONLY` ⇒ `now + duration ≤ closesAt` (`EXAM_CLOSED`); attempts used `< attemptLimit` (`ATTEMPT_LIMIT`).
Inside one transaction guarded by `pg_advisory_xact_lock(hashtextextended('attempt:'||versionId||':'||userId,0))`: if an `IN_PROGRESS` attempt exists and is **not expired** → return it (resume, `200`, `resumed:true`); if it is expired → finalize it (§5.4) and continue; else create attempt `attemptNo = used+1` with `startedAt = now()`, `deadlineAt = min(startedAt + duration, closesAt ?? ∞)`, `questionOrder`/`optionOrder` (§6). Unique constraints + triggers make duplicate/over-limit attempts impossible even if the application guard were bypassed. Enqueue the expiry job (§5.7). Rate limit 20/min/user. Audit `attempt.started`.

### 5.2 Reading — `GET /api/attempts/:id`
Owner only. Returns the participant's view (§9 `AttemptView`): questions in the participant's order with option ids in the participant's option order, saved selections, review marks, `serverNow`, `deadlineAt`, `remainingMs = max(0, deadlineAt − serverNow)` computed **server-side at response time**. **Contains no `isCorrect`, explanation, note, source or score.** If the attempt is `IN_PROGRESS` but `now > deadlineAt + grace` it is finalized lazily first and the response is the finalized state (`status: "TIMED_OUT"`, `result` link).

### 5.3 Autosave — `PUT /api/attempts/:id/answers`
Body `{ answers: [{ questionId, optionId: string|null, marked?: boolean, seq: number }] }` (1–50 items; `optionId:null` clears). Per attempt, one transaction with `SELECT … FOR UPDATE` on the attempt row:
* attempt not `IN_PROGRESS` → `ATTEMPT_EXPIRED` (409) with `details.finalized:true`;
* `now > deadlineAt + EXAM_GRACE_SECONDS` → finalize the attempt (reason timeout) **using only answers already stored**, then `ATTEMPT_EXPIRED` (409). Saves received within the grace window are accepted; the deadline shown to the user never moves;
* each item: `questionId` must belong to the attempt's version and `optionId` to that question, else `VALIDATION` with `fields["answers.N.optionId"]`; an item whose `seq` ≤ stored `seq` is **stale**: ignored, reported `stale:true` (a delayed older request can't overwrite a newer answer);
* response `{ saved: [{ questionId, seq, savedAt, stale }], serverNow, deadlineAt, remainingMs }`. **The UI may show "Saved" only for items confirmed in this response.** No correctness feedback is ever returned. Rate limit 240/min/attempt.
Clients submit identifiers only; any `score`, `correct`, `percentage` field is rejected by the strict schema.

### 5.4 Finalization — one function, `finalizeAttempt(attemptId, reason)`
Transaction: `SELECT … FOR UPDATE` the attempt; if status ≠ `IN_PROGRESS` → return the existing result unchanged (idempotent). Else read the stored answers, grade (§7), insert `ExamResult` + items, set `status` (`SUBMITTED` for manual, `TIMED_OUT` for expiry), `submittedAt` (manual only), `finalizedAt = now()`. After commit (idempotent): notify `exam.submitted` ("Submission received", dedupe `attempt-submitted:<attemptId>`) and, if the release policy already allows, `exam.results_available` (dedupe `results:<versionId>`).
Callers: manual submit, expiry job, sweeper, lazy finalization on read/write, leaderboard/analytics reads (bounded by version).
**Manual submit** — `POST /api/attempts/:id/submit`, body `{ answers?: [...same items as autosave...] }`: inside the same lock, if `now ≤ deadlineAt + grace` it applies the optional final answers (same rules) and finalizes as `SUBMITTED`; if later, it finalizes as `TIMED_OUT` from stored answers and returns that result (not an error: the participant learns the outcome). A second submit returns the same finalized result (`alreadyFinalized:true`, HTTP 200) and changes nothing.
**Race handling:** the row lock serializes submit vs expiry vs autosave; whichever acquires it first wins deterministically by the rule above (decided by server time at lock acquisition, not request arrival).

### 5.5 Time is server time
`startedAt`, `deadlineAt`, every comparison and `remainingMs` use `lib/clock.ts` (server). The client derives its countdown from the **`remainingMs` it just received plus elapsed monotonic time** (`performance.now()`), re-syncs on every autosave/poll response, and treats the server's `ATTEMPT_EXPIRED` as final. Changing the device clock or JS state cannot extend an exam. (Multi-instance deployments must keep server clocks NTP-synchronised; deadlines are stored absolute.)

### 5.6 Server or worker unavailable (documented behaviour)
* Deadlines are absolute timestamps in Postgres; nothing depends on a timer running.
* If the worker is down, attempts simply stay `IN_PROGRESS` past the deadline. They are finalized **by whichever happens first**: any API call touching the attempt (lazy), the leaderboard/analytics read for that version, the expiry job when the worker returns, or the sweeper. Grading uses only answers stored at or before `deadlineAt + grace` (later saves are rejected), so the result is **identical regardless of when finalization runs**.
* If the API is unavailable, the client keeps unsaved selections locally, shows a visible "Not saved — reconnecting" state, retries with backoff, and after reconnect re-reads `GET /api/attempts/:id` and re-sends only items the server hasn't confirmed; selections after the server deadline are dropped by the server (the UI says so).

### 5.7 Jobs (Postgres queue; handlers in `modules/exams/jobs.ts`; all idempotent)
* `exam.expire` `{attemptId}` — `runAt = deadlineAt + grace + 1 s`, `dedupeKey exam-expire:<attemptId>`; calls `finalizeAttempt(…, timeout)` (no-op if already finalized).
* `exam.sweep` — recurring (`ensureSweeperScheduled()` at server start creates it, dedupe `exam-sweep`; the handler re-enqueues itself `EXAM_SWEEP_INTERVAL_SECONDS` later in a `finally`): finalizes up to 200 attempts with `status=IN_PROGRESS AND deadlineAt + grace < now` (index `status, deadlineAt`), sends due reminders and due results-available notices (below) that the one-shot jobs missed.
* `exam.reminder` `{versionId}` — `runAt = opensAt − reminderMinutes`; notifies eligible participants who haven't started (`exam.reminder`, dedupe `exam-reminder:<versionId>`), sets `ExamVersionState.reminderSentAt`.
* `exam.release` `{versionId}` — `runAt = effective release time`; notifies every participant with a finalized result `exam.results_available` (dedupe `results:<versionId>`), sets `resultsNotifiedAt`.
Notification fan-out uses `notifyUsers` with dedupe keys, so duplicate jobs/retries never duplicate notifications.

## 6. Deterministic randomization
`questionOrder` = array of snapshot-question ids; `optionOrder` = `{ [questionId]: optionId[] }`; both are computed **once at attempt creation** and stored. If `shuffleQuestions`/`shuffleOptions` is off the snapshot `position` order is used. Otherwise: `seed = SHA-256("sf-exam-order-v1|" + examVersionId + "|" + userId + "|" + attemptNo)` (options additionally `"|" + questionId`), a counter-mode SHA-256 byte stream drives an unbiased Fisher–Yates shuffle (rejection sampling, no modulo bias). Same inputs ⇒ same order; different participants/attempts ⇒ (almost surely) different orders; the **set** of questions/options and the correct answers are identical for everyone. Test vectors are fixed in the unit tests.

## 7. Grading (pure function `gradeAttempt(snapshot, answers)`; integer math)
For each snapshot question: unanswered (`selectedOptionId` null/absent) → `UNANSWERED`, 0; selected option is the correct one → `CORRECT`, `+marksCenti`; otherwise `INCORRECT`, `−negativeCenti`.
`rawScoreCenti = Σ awarded`; **`scoreCenti = max(0, rawScoreCenti)`** (a total is never negative); `maxCenti = totalCenti` of the version.
**Percentage:** `percentBp = floor((scoreCenti × 10000 × 2 + maxCenti) / (2 × maxCenti))` (round half up to 2 decimals, in 1/100 %). Displayed as `percentBp/100` with two decimals.
**Feedback band** is computed from `percentBp` (the displayed percentage), so what the user sees and the band always agree:
`≥ 9000` EXCELLENT ("Excellent") · `≥ 8000` GOOD ("Good") · `≥ 7000` NEEDS_IMPROVEMENT ("Not Good — needs improvement") · `≥ 6000` BAD ("Bad") · else VERY_BAD ("Very Bad"). Boundaries are exact and non-overlapping (90.00 is Excellent; 89.99 is Good; 59.99 is Very Bad). Feedback copy is constructive and never blames.
Counts: `correct + incorrect + unanswered = questionCount`. The client can't influence any of this: it only sends option ids.

## 8. Results and release
`GET /api/attempts/:id/result` (owner only). Always returns `{ status, submittedAt, finalizedAt, release: { released: boolean, mode, releasesAt: string|null } }`. When **not released**: nothing else (no score, no counts, no review). When released, additionally: `score { scoreCenti, maxCenti, percentBp, correct, incorrect, unanswered, band, feedback }`, `topics: [{ topic, questions, correct, incorrect, unanswered, percentBp }]` (from the snapshot topics; `null` topic grouped as "General"), and — by `reviewPolicy` — `review: [ { position, questionId, stem, options:[{id,text}], selectedOptionId, outcome, awardedCenti, correctOptionId?, explanation?, shortNote?, sources? } ]` in the participant's own order (`correctOptionId/explanation/shortNote/sources` only for `FULL`; none of the review for `NONE`).
`released(now)`: `IMMEDIATE` → the attempt is finalized; `AFTER_CLOSE` → `now ≥ closesAt + grace`; `AT_TIME` → `now ≥ releaseAt`. (Evaluated per request from server time; no cached flag can leak early.) Release is per exam version, so all participants of a group exam see results at the same moment for AFTER_CLOSE/AT_TIME.
Retry link: if the attempt limit allows and the exam is open, the result includes `retry: { allowed, attemptsLeft }`; revision link: `/question-bank` filtered by the question topics is a UI affordance only.

## 9. REST API (all under `/api`, session-authenticated, same-origin guarded)

Errors use the existing envelope. New codes: `NOT_ELIGIBLE` 403, `EXAM_NOT_OPEN`/`EXAM_CLOSED`/`ATTEMPT_LIMIT`/`ATTEMPT_EXPIRED`/`GROUP_FULL` 409, `INVALID_INVITE` 404 (generic "invalid or expired code" for unknown/expired/revoked/used-up/not-for-you — never says which).

### Exams
* `GET /api/exams/limits` → `{ limits, models? no }` limits camel-cased from env names (`examMaxQuestions`, `examMaxDurationMinutes`, `examMaxAttemptLimit`, `examGraceSeconds`, `groupMaxCapacity`, `groupDefaultCapacity`, `inviteDefaultTtlHours`, `inviteMaxTtlHours`, `inviteMaxUses` …) + `fields`.
* `POST /api/exams` `{ title, description?, mode, groupId? }` → 201 `{ exam: ExamSummary }`
* `GET /api/exams?scope=mine|available|history&status=&page&pageSize` → `{ items: ExamSummary[], total, page, pageSize }`; `mine` = authored (any status); `available` = published exams the caller may start/continue now or later (own individual exams + group exams of groups they belong to, not authored by them); `history` = exams the caller has ≥1 attempt on.
* `GET /api/exams/:id` → author: `{ exam: ExamManageView }` (draft config, selected questions **with keys** while drafting/for the author, versions, `snapshotIntegrity`); eligible participant (group member/individual author): `{ exam: ExamTakeView }` (title, description, durationMinutes, questionCount, totalMarks, window, policies in plain words, **no questions, no keys**, my attempts summary, `canStart: {allowed, reason?, code?}`); anyone else 404.
* `PUT /api/exams/:id/draft` `ExamDraftInput` → `{ exam }` (draft only; `CONFLICT` otherwise)
* `GET /api/exams/:id/preview` (author, draft) → `{ preview: { issues: {path,message,severity:"error"|"warning"}[], totals:{questionCount,totalMarks,negativePerWrongRange}, questions: [{position, stem, options, correctOptionId, marks, negativeMarks, topic}], sampleOrder?: … } }` — warnings include "IMMEDIATE release in a group exam shows answers while others are still testing", "window shorter than N×duration", etc.
* `POST /api/exams/:id/publish` → `{ exam }` (§4) · `POST /api/exams/:id/cancel` · `POST /api/exams/:id/duplicate` → 201 `{ exam }` · `DELETE /api/exams/:id` (drafts / unattempted)
* `POST /api/exams/:id/attempts` → `{ attempt: AttemptView, resumed: boolean }` (§5.1)
* `GET /api/exams/:id/attempts` → the caller's own attempts for this exam `{ items: AttemptSummary[] }`
* `GET /api/exams/:id/leaderboard?page&pageSize` → §10 (group exams only; others 404)
* `GET /api/exams/:id/participants` (group exam staff: author/OWNER/ADMIN) → participation statuses only (no scores/answers before release; after release also scores)

### Attempts
* `GET /api/attempts?status=&page&pageSize` → caller's attempts `{ items: AttemptSummary[] }`; `GET /api/attempts/:id` §5.2; `PUT /api/attempts/:id/answers` §5.3; `POST /api/attempts/:id/submit` §5.4; `GET /api/attempts/:id/result` §8.

```ts
type ExamSummary = { id: string; title: string; description: string | null; mode: "INDIVIDUAL"|"GROUP"; status: "DRAFT"|"PUBLISHED"|"CANCELLED"; group: {id: string; title: string} | null;
  questionCount: number; totalMarks: number | null; durationMinutes: number | null; opensAt: string|null; closesAt: string|null; publishedAt: string|null; updatedAt: string;
  myAttempts?: { used: number; limit: number; inProgressAttemptId: string|null; bestPercentBp: number|null } };
type AttemptView = { id: string; examId: string; examTitle: string; status: "IN_PROGRESS"|"SUBMITTED"|"TIMED_OUT"; attemptNo: number;
  startedAt: string; deadlineAt: string; serverNow: string; remainingMs: number; totalMarks: number; negativeMarking: boolean;
  questions: { id: string; position: number /* in the participant's order, 1-based */; stem: string; options: { id: string; text: string }[]; marks: number }[];
  answers: Record<string /*questionId*/, { optionId: string|null; marked: boolean; seq: number; savedAt: string }>; };
type AttemptSummary = { id: string; examId: string; examTitle: string; attemptNo: number; status: AttemptView["status"]; startedAt: string; finalizedAt: string|null;
  result: { released: boolean; scoreCenti?: number; maxCenti?: number; percentBp?: number; band?: FeedbackBand } };
```
`marks` shown per question is the question's value (needed for the UI); never the correct option.

## 10. Leaderboard and analytics (group exams)
`GET /api/exams/:id/leaderboard?page=1&pageSize=25` (members of the group and exam staff; others 404). Computed **in SQL from finalized `ExamResult` rows** (never from frontend order), over **current members** of the group (removed members drop off; their data is not shown to others).
* **Participant score** = the member's **best** finalized attempt (highest `scoreCenti`; ties → earliest `finalizedAt`).
* **Competition ranking ("1224")**: `rank = 1 + number of ranked participants with a strictly higher score`; equal scores share a rank; the next rank skips (1, 2, 2, 4). Order within a rank: earliest submission first, then display name — ordering only, never rank.
* **Statuses** (`status`): `SUBMITTED` (finalized by the participant), `TIMED_OUT` (finalized by expiry; counted and ranked, flagged), `IN_PROGRESS` (attempt running; unranked), `NOT_STARTED` (eligible member, no attempt; unranked), `MISSED` (window closed, no attempt). A finalized **zero score is ranked** (`scorePct 0`, status SUBMITTED/TIMED_OUT) and is visibly different from NOT_STARTED/IN_PROGRESS.
* **Visibility:** before release (`released(now)` for the version; `leaderboardVisible=false` hides it from members entirely but staff still see it after release) the response is `{ released:false, releasesAt, participants:{total, submitted, timedOut, inProgress, notStarted} }` — no scores, no names with scores. After release: items, stats, distribution. Never any in-progress answers.
* **Display names:** `profile.displayName ?? user.name`; a member with `showNameOnLeaderboard=false` appears as **"Anonymous participant"** to everyone but themself (`isSelf:true` shows their real name). E-mail, ids of other users and any private data are never returned (items carry a per-response opaque `entryId`, not the user id).
* **Response:** `{ released: true, policy: "COMPETITION_1224_BEST_ATTEMPT", items: [{ entryId, rank|null, displayName, isSelf, status, scoreCenti|null, maxCenti, percentBp|null, band|null, submittedAt|null }], total, page, pageSize, stats: { participants, ranked, average (percentBp, 2-dec rounding), highest, lowest, median? }, distribution: [{ band: "BELOW_60"|"60_70"|"70_80"|"80_90"|"90_100", label, count }], myEntry? }` where distribution counts **ranked** participants by `percentBp` bands `<6000`, `[6000,7000)`, `[7000,8000)`, `[8000,9000)`, `[9000,10000]`. Pagination applies to `items` (ranked first by rank, then unranked by status).

## 11. Groups

Roles & permissions:
| Action | OWNER | ADMIN | MEMBER |
|---|---|---|---|
| view group, members (names per privacy), exam history | ✓ | ✓ | ✓ |
| leave | ✗ (delete the group instead) | ✓ | ✓ |
| edit title/description/capacity (capacity ≥ current members), delete group | ✓ | ✗ | ✗ |
| create / revoke / list invites | ✓ | ✓ | ✗ |
| remove a MEMBER | ✓ | ✓ | ✗ |
| remove an ADMIN, change roles (promote MEMBER↔ADMIN) | ✓ | ✗ | ✗ |
| publish a group exam | ✓ | ✓ | ✗ |
| toggle own leaderboard-name privacy | ✓ | ✓ | ✓ |
There is exactly one OWNER (DB-enforced); ownership transfer is out of scope.

* `POST /api/groups` `{ title, description?, capacity? }` → 201 (owner becomes OWNER member; ≤ `GROUP_MAX_OWNED_PER_USER`; capacity 2..`GROUP_MAX_CAPACITY`)
* `GET /api/groups` → my groups (with role, memberCount) · `GET /api/groups/:id` (members only; else 404) → group + my role + memberCount/capacity
* `PATCH /api/groups/:id` · `DELETE /api/groups/:id` (cascades exams/attempts/results; audit; requires `{ confirmTitle }` equal to the title)
* `GET /api/groups/:id/members?page&pageSize` → `{ items: { memberId, displayName, role, joinedAt, isSelf }, total }` where `memberId` is the member's user id, meaningful only inside this group's routes (no e-mail or other personal data; `displayName` is the profile name — the leaderboard-privacy toggle applies to leaderboards only)
* `PATCH /api/groups/:id/members/:memberId` `{ role }` (OWNER) · `DELETE /api/groups/:id/members/:memberId` (remove; per matrix) · `POST /api/groups/:id/leave` · `PATCH /api/groups/:id/me` `{ showNameOnLeaderboard }`
* Invites: `POST /api/groups/:id/invites` `{ expiresInHours?, maxUses?, email? }` → 201 `{ invite: {id, expiresAt, maxUses, useCount, codeHint, forEmail?: boolean}, code, link }` (**`code` is returned once**; only its SHA-256 is stored). Codes are 128-bit random (base32, 26 chars, shown grouped). With `email`, a single-use code bound to that address's account (if one exists): that user gets an in-app `group.invitation` notification containing the link; **the response never reveals whether the address has an account**. `GET /api/groups/:id/invites` (staff) → list with `status: ACTIVE|EXPIRED|REVOKED|USED_UP`, never the code; `DELETE /api/groups/:id/invites/:inviteId` → revoke (idempotent).
* Join: `GET /api/groups/join-preview?code=` → `{ group: { title, memberCount, capacity } }` or `INVALID_INVITE`; `POST /api/groups/join` `{ code }` → `{ group }`. Rate limits: per user and per IP per hour (`INVITE_ATTEMPTS_PER_HOUR_*`, failures and successes both count) → `RATE_LIMITED`. Join transaction: lookup by hash, `SELECT … FOR UPDATE` the **group row**, validate (not revoked, not expired, `useCount < maxUses`, `forUserId` matches or null, caller not already a member, caller's membership count < `GROUP_MAX_MEMBERSHIPS_PER_USER`), member count `< capacity` else `GROUP_FULL`, insert member (the DB capacity trigger is the backstop), `useCount++`. Concurrent joins cannot exceed capacity (tested with real concurrency). An already-member re-join is idempotent (`200`, no use consumed). Expired/revoked/unknown/used-up codes all return the same `INVALID_INVITE`.
* `GET /api/groups/:id/exams?page&pageSize` → group exam history (published/cancelled exams with my participation status). Draft group exams are visible only to their author.
* Notifications: `group.invitation` (direct invite), `group.exam_published`, `group.member_joined` (to OWNER/ADMIN; dedupe per member), `group.member_removed` (to the removed user), `group.member_left` (to OWNER). Idempotent via dedupe keys.
* Privacy: members never see other members' conversations, documents, keys, e-mail, sessions or non-exam data; the member list exposes display name, role and join date only.

## 12. Dashboard
`GET /api/dashboard/summary` gains `exams: { attempts, finalized, averagePercentBp|null, best, byBand: Record<band,count>, recent: [{ attemptId, examId, title, percentBp, band, finalizedAt }] (released results only), upcoming: [{examId, title, opensAt|closesAt}], groups }` computed from real data (released results only).

## 13. Frontend routes (summary)
`/exams` (my exams, available, history, "New exam"), `/exams/new` and `/exams/[id]/edit` (wizard: Details → Questions → Rules → Preview → Publish), `/exams/[id]` (detail: participants/status, actions, attempts, results link, leaderboard link for group exams), `/exams/[id]/leaderboard`, `/attempts/[id]` (focused exam UI on the mint canvas), `/attempts/[id]/result`, `/groups`, `/groups/[id]` (members, invites, exams), `/join` and `/join/[code]`. Notifications deep-link via `link`. Recharts is the chart library (score-distribution bar chart with the five bands + per-topic bars on the result page).

## 14. Test obligations (must be executed before claiming a property)
Unit: grading boundaries & negative marking & rounding & clamp; band thresholds (exact 9000/8000/7000/6000 ± 1); deterministic shuffle vectors + set-equivalence; centi-mark conversion; deadline math (`min(start+duration, closesAt)`); competition ranking function; release predicate.
Integration (real Postgres): publish validation (invalid keys, foreign/unauthorized questions & collections, excess duration, bad marks/window/release), snapshot immutability (raw `UPDATE` rejected; bank edit/delete after publish leaves snapshot, hash re-verifies), no key leakage in every pre-release payload (scan JSON for option correctness/explanations), unauthorized exam/attempt/result/leaderboard access, attempt-limit & duplicate-start (concurrent starts → one attempt), server clock enforcement (injected clock; saves after deadline+grace rejected; client-supplied timestamps ignored), autosave stale-`seq`, submit idempotency, **concurrent submit vs expiry vs autosave at the deadline** (Promise.all on real locks → exactly one result), score fields rejected, expiry job + sweeper + lazy finalization equivalence, worker-down recovery, release policies (IMMEDIATE/AFTER_CLOSE/AT_TIME, review policies), group: roles matrix, invite expiry/revocation/max-uses/direct invite, join brute-force rate limits, **concurrent joins vs capacity** (N parallel joins, capacity C ⇒ exactly C members), removal, leave, group exam same-snapshot-for-all, late-join policy, leaderboard correctness (1,2,2,4; zero vs unsubmitted vs in-progress; best attempt; removed members; privacy; pagination; distribution counts), notification idempotency.
E2E (Chromium, real stack): create exam via wizard → preview → publish → start → answer → autosave indicator → submit → result bands; timer expiry (server deadline shifted via SQL) → time-expired state; offline save warning; group create/invite/join/publish/take/leaderboard with chart; keyboard operation; axe; responsive.
