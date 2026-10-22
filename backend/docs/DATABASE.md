# StudyForge AI — Database (PostgreSQL 16 + pgvector + pg_trgm)

_Source of truth: `backend/prisma/schema.prisma` and the SQL in `backend/prisma/migrations/`. Last verified: end of Part 5 (`prisma migrate diff` reports no drift)._

## Migrations
| Migration | Adds |
|---|---|
| `20261022124741_init` | Part 1: identity (Better Auth tables), profile/preferences, notifications, audit, usage, rate limits |
| `20261022135056_part2_ai_documents_chat` | Part 2: provider credentials, model preferences, conversations/messages/citations, documents + chunks (pgvector), jobs |
| `20261022173147_part3_questions` | Part 3: generation runs, question bank, collections (additive; drops nothing) |
| `20261023120000_part5_analysis_ops` | Part 5: `Role.SUPPORT`, `UserPreference.autoAiFeedback`, `ExamAnalysis`, `StudyPlan`, `MetricBucket`, `ServiceHeartbeat` (additive) |
| `20261023020000_part4_exams_groups` | Part 4: groups, invites, exams, immutable versions + snapshots, attempts, answers, results; `Notification.link` / `dedupeKey` (additive; drops nothing) |

Workflow: `pnpm prisma migrate dev --create-only`, **read the SQL**, then apply (`pnpm db:migrate:deploy` for any shared database). Raw SQL Prisma cannot express (partial unique indexes, CHECK constraints, owner-check triggers) is appended to the migration file by hand and is not reported as drift.

## Part 3 model overview

```
User ─┬─< GenerationRun            (draft sets; expire)
      ├─< Question ─┬─< QuestionOption      (MCQ; exactly one isCorrect)
      │             ├─< QuestionPart ──1 ModelAnswer   (CQ sub-questions and their model answers)
      │             ├─< ModelAnswer         (part-less CQ answer: partId NULL)
      │             ├─< QuestionSource      (evidence snapshots; question- or answer-level)
      │             ├─< QuestionRevision    (immutable JSON snapshot per version)
      │             └─< CollectionQuestion >─ QuestionCollection >─ User
      └─< QuestionCollection
Document ─< QuestionSource (documentId SET NULL on delete; name/page/quote survive)
GenerationRun ─< Question (generationRunId SET NULL on expiry; provider/model/generatedAt are copied onto the question)
```

| Table | Key columns / rules |
|---|---|
| `GenerationRun` | `kind`, `status` (RUNNING/SUCCEEDED/FAILED/INTERRUPTED), `settings` (validated request incl. pasted text; secrets never stored), `provider`, `model`, `result` (validated drafts, warnings, sources), token/call counts, `expiresAt` (indexed; purged lazily on list/start) |
| `Question` | `kind` MCQ/CQ, `version`, `language` (en/bn), `stem`, `stimulus`, `explanation`, `shortNote`, `difficulty`, `subject`, `topic`, `tags text[]` (GIN), `marks`, `negativeMarks`, `origin`, `sourceSupport`, `modifiedByUser`, `reviewReasons text[]`, `reviewedAt`, `contentHash`. **Unique `(ownerId, contentHash)`**; trigram GIN on `stem`; CHECKs: marks range, `negativeMarks ≤ marks`, `version ≥ 1`, non-blank stem |
| `QuestionOption` | server-issued id, `position` (unique per question), `text` (non-blank), `isCorrect`; **partial unique index: one correct option per question** |
| `QuestionPart` | CQ sub-question: `label`, `level` (KNOWLEDGE/COMPREHENSION/APPLICATION/HIGHER_ORDER), `prompt`, `marks > 0`, `position` unique per question |
| `ModelAnswer` | `text`, `basis` (SOURCE_SUPPORTED / GENERAL_REASONING / INSUFFICIENT_EVIDENCE / USER_PROVIDED); `partId` unique; **partial unique index: at most one part-less answer per question** |
| `QuestionSource` | `documentId` (nullable FK, SET NULL), `documentName`, `page`, `section`, `quote` (≤1000), `quoteVerified`, `ordinal`; `answerId` null = question-level evidence |
| `QuestionRevision` | `(questionId, version)` unique, `snapshot` JSON (full `QuestionContent`) |
| `QuestionCollection` | `title`, `titleKey` (lower-cased), **unique `(ownerId, titleKey)`** |
| `CollectionQuestion` | PK `(collectionId, questionId)`, `position`; **trigger rejects a collection and question with different owners** |

All Part 3 tables cascade from `User`, so account deletion removes them.

## Versioning strategy (for Part 4 exams)
* A question's `version` increments only when exam-visible content changes (stem, stimulus, options, correct answer, parts/marks/answers, explanation, note, marks). Tags/subject/topic/difficulty edits do not.
* Each version has one immutable `QuestionRevision`. A published exam will store `(questionId, version)` **and copy the snapshot into its own rows**; it never reads the live question again. Therefore editing or deleting a bank question cannot change a published exam.
* Exact duplicates are prevented by `contentHash` (kind + normalised stem/stimulus + sorted normalised options + correct option text + parts). Near-duplicates (pg_trgm `%` prefilter, then token-set Jaccard on stem and options) are flagged, not blocked.

## Privacy and isolation
* Every query is scoped by `ownerId`/`userId`; foreign ids behave exactly like missing ids (404 / silently ignored in bulk).
* Evidence snapshots are owner-only data; they are never included in exports with a document id.
* Daily AI usage for generation is recorded in `UsageRecord` (`llm.requests` = provider calls made, `llm.tokens` when the provider reports them).

## Part 4 model overview (exams, attempts, groups)

```
User ─┬─< Exam ─< ExamVersion ─┬─< ExamQuestionSnapshot ─┬─< ExamOptionSnapshot   (immutable published content)
      │   │ (draft JSON)       │                        └─< AttemptAnswer
      │   └─ group? ─ Group    ├─< ExamAttempt ─┬─< AttemptAnswer
      │                        │                └─1 ExamResult ─< ExamResultItem   (immutable)
      │                        └─1 ExamVersionState (mutable fan-out markers)
      ├─< ExamAttempt, ExamResult
      └─< Group ─< GroupMember (OWNER|ADMIN|MEMBER) · GroupInvite (hash only)
```

| Table | Key rules |
|---|---|
| `Exam` | author, `mode` INDIVIDUAL/GROUP, `status` DRAFT/PUBLISHED/CANCELLED, `draft` JSON (validated config), `currentVersion` |
| `ExamVersion` | **immutable** (trigger rejects `UPDATE`): duration, attempt limit, window, policies, `negativeMarkingBp`, `totalCenti`, `snapshotHash`; CHECKs on ranges and `closesAt > opensAt` |
| `ExamQuestionSnapshot` / `ExamOptionSnapshot` | **immutable** copy of stem/options/correct flag/explanation/note/topic/sources with `marksCenti`/`negativeCenti` (integers); source question referenced by plain id + version (no FK, so bank edits/deletes never touch it); partial unique index: exactly one correct option per question |
| `ExamAttempt` | server `startedAt`/`deadlineAt`; unique `(examVersionId, userId, attemptNo)`; **partial unique: one IN_PROGRESS attempt per participant and version**; trigger: `attemptNo ≤ attemptLimit`; index `(status, deadlineAt)` drives the sweeper; participant-specific `questionOrder`/`optionOrder` stored |
| `AttemptAnswer` | PK `(attemptId, examQuestionId)`, `seq` (stale autosaves are ignored); trigger: attempt must be IN_PROGRESS, question must belong to the attempt's version, option to the question |
| `ExamResult` / `ExamResultItem` | one result per attempt (unique), **immutable**; `rawScoreCenti`, clamped `scoreCenti`, `maxCenti`, `percentBp` (basis points, round half up), counts, `band`; CHECK ranges |
| `Group` / `GroupMember` | capacity CHECK 1–1000; **trigger enforces capacity per insert under an advisory lock** (concurrent joins cannot exceed it); partial unique: one OWNER per group |
| `GroupInvite` | `codeHash` (SHA-256, unique; the code is never stored), `codeHint`, `expiresAt`, `revokedAt`, `maxUses`/`useCount` (CHECK `useCount ≤ maxUses`), optional `forUserId` |
| `ExamVersionState` | mutable markers (`publishNotifiedAt`, `reminderSentAt`, `resultsNotifiedAt`) so notification fan-out is idempotent and recoverable |
| `Notification` | + `link`, + `dedupeKey` with unique `(userId, dedupeKey)` (NULLs never collide): the same event is never delivered twice to a user |

Integer money: marks are stored as centi-marks (×100) in snapshots and results; negative marking is a fraction in basis points applied once at publish. No floating point is used in grading.

## Part 5 additions (AI feedback, plans, operations)

| Table | Key rules |
|---|---|
| `ExamAnalysis` | **one row per finalized result** (`resultId` unique, cascade from the result); `status` PENDING/READY/FAILED/NOT_CONFIGURED, `content` JSON (validated AI text), provider/model/tokens, `attempts` (bounded), `errorCode`. Derived and disposable: it never feeds grading; a failed or deleted row cannot affect a result. |
| `StudyPlan` | one row per `(userId, fingerprint)` where the fingerprint hashes the verified inputs (topic statistics, result percentages, locale) → the same data never creates a second plan; `basis` JSON (counts only); newest `STUDY_PLAN_MAX_PER_USER` kept |
| `MetricBucket` | PK `(bucket hour, name, label)`; counters only (API status classes by route group, provider outcomes, rate-limit/quota blocks); no user ids or content; purged after `METRICS_RETENTION_DAYS` |
| `ServiceHeartbeat` | `name` PK; the worker writes `worker` from the ops heartbeat job (admin health shows its age) |
| `UserPreference.autoAiFeedback` | opt-out of automatic AI feedback (default on; only runs when a model/key is configured) |
| `Role` | adds `SUPPORT` (read-only operational access) |

Analytics are **computed live** from finalized, released `ExamResult`/`ExamResultItem` rows through one SQL source (`modules/analytics/stats.ts`, `sources.ts`); there are no stored aggregates to recalculate or drift.
