# Part 3 — MCQ / CQ generation and question bank: normative spec

Status: **frozen contract for implementation** (rag_agent, backend, frontend must all conform). If implementation reveals a needed change, keep the
contract working, change it here in the same commit, and report the deviation.

Reuses Part 2: provider adapters (`Provider.generate_structured`), BYOK, document pipeline/retrieval isolation, quotas (`UsageRecord`), SSE plumbing,
the `mock` provider (tests only). Nothing here implements exams, timers or groups (Parts 4–5).

## 0. Principles

1. **The server owns provenance.** Clients never supply `sources`, `sourceSupport`, `reviewReasons`, answer `basis` or model/provider. They are derived from the
   stored `GenerationRun` (or are fixed values for user-authored content). A client can edit *content*; it cannot forge "this was verified against your document".
2. **"Source-quoted" ≠ "correct".** `SOURCE_QUOTED` means at least one evidence quote was found verbatim in an authorised source chunk. Nothing in the UI/API may say
   an AI question is guaranteed correct. Everything AI-generated is "AI-generated — review before use".
3. **Validate on the server, always** (generation output *and* every save/edit). The same rules apply no matter who produced the content.
4. **Bounded work**: max questions per run, batch size, max LLM calls per run, max regeneration attempts per batch (2), total timeout, input/output size caps, quotas.
5. **No timer anywhere in CQ.** CQ types contain no time/duration fields; the CQ UI has no timer.
6. Questions are stored once; collections reference them (`CollectionQuestion`). Edits create immutable revisions so Part 4 exams can pin a version.

## 1. Enumerations

```ts
type QuestionKind   = "MCQ" | "CQ";
type Difficulty     = "EASY" | "MEDIUM" | "HARD";                 // a question always has one concrete difficulty
type DifficultySetting = Difficulty | "MIXED";                    // generation setting only
type Language       = "en" | "bn";
type Grounding      = "SOURCE_ONLY" | "SOURCE_PREFERRED" | "GENERAL";
type SourceSupport  = "SOURCE_QUOTED" | "MODEL_ONLY" | "NONE";   // NONE = user-authored
type Origin         = "AI_GENERATED" | "USER_AUTHORED";
type CqMode         = "QUESTIONS_ONLY" | "WITH_ANSWERS";
type CqStructure    = "stimulus_4part" | "descriptive" | "multipart";
type CqLevel        = "KNOWLEDGE" | "COMPREHENSION" | "APPLICATION" | "HIGHER_ORDER";  // জ্ঞানমূলক, অনুধাবনমূলক, প্রয়োগমূলক, উচ্চতর দক্ষতামূলক
type AnswerBasis    = "SOURCE_SUPPORTED" | "GENERAL_REASONING" | "INSUFFICIENT_EVIDENCE" | "USER_PROVIDED";
type RunKind        = "MCQ" | "CQ";
type RunStatus      = "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";
```

**Grounding policies**
* `SOURCE_ONLY` — needs ≥1 source (topic does *not* count as a source; pasted text or documents do). Every MCQ must carry ≥1 verified evidence quote or it is rejected.
  CQ answers: a part whose answer has no verified quote gets `basis:"INSUFFICIENT_EVIDENCE"` and empty text (never invented); a CQ with zero supported parts is rejected.
* `SOURCE_PREFERRED` — needs ≥1 source. Model must use sources; questions/answers without verified evidence are kept but marked `MODEL_ONLY` (CQ answers `GENERAL_REASONING`).
* `GENERAL` — topic only (no pasted text, no documents; supplying them is a VALIDATION error — never silently ignored). Everything is `MODEL_ONLY`.

**Review reason codes** (`reviewReasons: string[]`, a flag set; empty = nothing flagged):
`SOLVER_DISAGREES`, `EXPLANATION_NAMES_OTHER_OPTION`, `KEY_NOT_IN_EVIDENCE`, `NEAR_DUPLICATE`, `LANGUAGE_MISMATCH`, `PART_INSUFFICIENT_EVIDENCE`, `MARKS_ADJUSTED`, `NEAR_DUPLICATE_IN_BANK` (backend only).
`needsReview = reviewReasons.length > 0 && reviewedAt == null`. `MODEL_ONLY` alone is **not** a review reason (it is shown as an informational chip).

## 2. Limits (backend env, single source of truth; exposed at `GET /api/questions/limits`)

| Env | Default | Meaning |
|---|---|---|
| `MCQ_MAX_QUESTIONS_PER_RUN` | 50 | max `count` for MCQ |
| `CQ_MAX_QUESTIONS_PER_RUN` | 20 | max `count` for CQ |
| `GEN_TOPIC_MAX_CHARS` | 300 | topic length |
| `GEN_TEXT_MAX_CHARS` | 30000 | pasted text length |
| `GEN_MAX_DOCUMENTS` | 10 | documents per run |
| `GEN_MAX_CONTEXT_CHARS` | 14000 | source characters per LLM call |
| `GEN_BATCH_SIZE_MCQ` / `GEN_BATCH_SIZE_CQ` | 10 / 4 | questions per LLM call |
| `GEN_MAX_LLM_CALLS` | 16 | hard cap of provider calls per run (generation + regeneration + cross-check) |
| `GEN_MAX_OUTPUT_TOKENS` | 8000 | per-call output cap (min with the user's `maxTokens` preference) |
| `GEN_TIMEOUT_MS` | 240000 | whole-run timeout |
| `GEN_RATE_PER_MINUTE` | 6 | generation requests per user per minute |
| `QUESTION_MAX_PER_USER` | 5000 | saved questions |
| `COLLECTION_MAX_PER_USER` | 100 | collections |
| `COLLECTION_MAX_QUESTIONS` | 500 | questions per collection |
| `SAVE_BATCH_MAX` | 100 | questions per save request |
| `RUN_RETENTION_DAYS` | 14 | generation runs expire |

Field limits (constants): stem 2000 · option text 500 · options 2–6 (generation setting 2–6) · explanation 2000 · shortNote 600 · stimulus 3000 ·
part prompt 1000 · answer text 4000 · parts ≤ 6 · topic/subject 120 · tags ≤ 10 × 40 chars · evidence quote 1000 · title 120 · description 500 ·
`marks` 0–100 (≥0.25 for MCQ), `negativeMarks` 0..marks, both rounded to 2 decimals.

## 3. Data structures (API/DTO; camelCase)

```ts
type SourceRef = {                       // snapshot; survives document deletion
  documentName: string;                  // "Pasted text" for pasted material
  documentId: string | null;             // owner-only; null for pasted text or after deletion. NEVER exported.
  page: number | null; section: string | null;
  quote: string;                         // ≤1000 chars, verbatim from the source chunk
  quoteVerified: boolean;                // true = found verbatim (after whitespace/NFKC/case normalisation) in the chunk text
};
type AnswerObj = { text: string; basis: AnswerBasis; sources: SourceRef[] };

type QuestionContent = {                 // shared by drafts (unsaved generation output / edit state) and saved questions
  kind: QuestionKind; language: Language;
  stem: string;                          // MCQ: the question. CQ: the lead-in (e.g. "Read the stimulus and answer") or, for `descriptive`, the question itself
  stimulus: string | null;               // CQ only
  options: { id: string; text: string }[];        // MCQ only; [] for CQ. ids stable within the question: /^[A-Za-z0-9_-]{2,40}$/
  correctOptionId: string | null;                 // MCQ only; must reference options[].id
  parts: {                                        // CQ only; [] allowed (single descriptive question)
    id: string; label: string | null;             // "ক"/"a"…
    level: CqLevel | null; prompt: string; marks: number;
    answer: AnswerObj | null;                     // null in QUESTIONS_ONLY mode
  }[];
  answer: AnswerObj | null;                       // CQ with no parts: the model answer. null otherwise
  explanation: string | null; shortNote: string | null;   // MCQ (CQ: explanation unused)
  difficulty: Difficulty;
  subject: string | null; topic: string | null; tags: string[];   // tags lower-cased, trimmed, deduped
  marks: number; negativeMarks: number;           // CQ: marks = sum(parts.marks) when parts exist; negativeMarks 0
  sources: SourceRef[];                           // question-level evidence (MCQ evidence / CQ stimulus basis)
  sourceSupport: SourceSupport;
  reviewReasons: string[];
};

type QuestionDraft = QuestionContent & { id: string /* run-local, "g_<hex>" */; };

type QuestionView = QuestionContent & {          // saved question (owner view)
  id: string; schemaVersion: 1; version: number;                  // version increments on every content edit
  origin: Origin; modifiedByUser: boolean;                        // true once a user edits an AI_GENERATED question's content
  reviewedAt: string | null; needsReview: boolean;
  provenance: { provider: string; model: string; generationRunId: string | null; generatedAt: string } | null;   // null for USER_AUTHORED
  collections?: { id: string; title: string }[];                  // present on detail, absent on list rows
  createdAt: string; updatedAt: string;
};
```

### 3.1 Save/edit input (client → server). The server derives sources/sourceSupport/reviewReasons/basis itself.

```ts
type QuestionInput = {
  runQuestionId?: string;               // draft id this came from (needs top-level runId)
  kind: QuestionKind; language: Language;
  stem: string; stimulus?: string | null;
  options?: { id?: string; text: string }[]; correctOptionId?: string | null;   // new options may omit id (server assigns); correctOptionId may then be "#<index>" (0-based) — see §5
  parts?: { id?: string; label?: string | null; level?: CqLevel | null; prompt: string; marks: number; answerText?: string | null }[];
  answerText?: string | null;           // CQ without parts
  explanation?: string | null; shortNote?: string | null;
  difficulty: Difficulty; subject?: string | null; topic?: string | null; tags?: string[];
  marks?: number; negativeMarks?: number;
};
```
Answer `basis` on save: if the question came from a run and the (trimmed) answer text equals the run's → run's `basis` + sources; if it differs or no run → `USER_PROVIDED` with no sources (empty text → no answer object).

### 3.2 Collections

```ts
type CollectionView = { id: string; title: string; description: string | null; subject: string | null; questionCount: number; createdAt: string; updatedAt: string };
```

### 3.3 Generation run

```ts
type RunView = {
  id: string; kind: RunKind; status: RunStatus;
  settings: McqSettings | CqSettings;               // echo of the validated request (no secrets)
  provider: string; model: string;
  questions: QuestionDraft[];                       // result (SUCCEEDED only)
  rejectedCount: number; warnings: { code: string; message: string }[];
  usage: { promptTokens: number | null; completionTokens: number | null; llmCalls: number };
  sources: { topic: string | null; pastedTextChars: number; documents: { id: string; name: string }[] };
  errorCode: string | null;
  createdAt: string; finishedAt: string | null; expiresAt: string;
};
type RunSummary = Pick<RunView, "id" | "kind" | "status" | "provider" | "model" | "createdAt"> & { questionCount: number; topic: string | null };
```
Warning codes: `FEWER_THAN_REQUESTED`, `SOME_REJECTED`, `LANGUAGE_MISMATCH`, `NO_STRUCTURED_OUTPUT_NATIVE` (prompt-JSON fallback used), `CROSS_CHECK_SKIPPED`, `CONTEXT_TRUNCATED`, `MARKS_ADJUSTED`.

## 4. REST API (backend, all under `/api`, session-authenticated, same-origin guarded; every query scoped by the caller)

Errors use the existing envelope `{error:{code,message,details,requestId}}`. Field errors: `details.fields["questions.3.options"] = "…"` (dotted paths). New codes reuse existing:
`VALIDATION`(422), `NOT_CONFIGURED`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `CONFLICT`, `NOT_FOUND`; plus generation-specific `GENERATION_FAILED` (502, `details.reason` ∈ `INVALID_OUTPUT | NO_VALID_QUESTIONS | INSUFFICIENT_SOURCES | PROVIDER`) and normalised provider codes from Part 2 (`PROVIDER_AUTH_INVALID`, …).

### 4.1 Limits
`GET /api/questions/limits` → `{ limits: {...§2 with the env names camel-cased, e.g. genTextMaxChars, collectionMaxQuestions, saveBatchMax; plus exportMaxQuestions (500) and bulkMaxIds (200)}, fields: {...field limits}, models: { MCQ: ModelRef|null, CQ: ModelRef|null, EMBEDDING: ModelRef|null } }` (`ModelRef = {provider, modelId}` — the resolved task/default preference).

### 4.2 Generation (SSE for runs)
`POST /api/generation/mcq` body `McqSettings`; `POST /api/generation/cq` body `CqSettings`.
Validation/quota/config errors → normal JSON error *before* streaming. Then `text/event-stream` with events:
* `run` `{ runId }` — first event
* `status` `{ stage: "preparing"|"retrieving"|"generating"|"validating"|"repairing"|"checking", batch?: n, batches?: n }`
* `result` `{ run: RunView }` — terminal success
* `error` `{ code, message, retryable, details? }` — terminal failure (run persisted as FAILED/INTERRUPTED)
Client disconnect aborts the provider call (run → INTERRUPTED). One RUNNING run per user (stale after 10 min); a second request → `CONFLICT`.

```ts
type McqSettings = {
  topic?: string; pastedText?: string; documentIds?: string[];     // ≥1 source required unless grounding = GENERAL (topic required then)
  subject?: string;
  count: number;                                // 1..MCQ_MAX_QUESTIONS_PER_RUN, default 10
  difficulty: DifficultySetting;                // default MIXED
  language: Language;                           // default en
  optionCount: number;                          // 2..6, default 4
  marks: number; negativeMarks: number;         // default 1 / 0
  includeExplanations: boolean;                 // default true
  includeShortNotes: boolean;                   // default true
  grounding: Grounding;                         // default SOURCE_ONLY if sources else GENERAL (client default; server requires explicit value)
  crossCheck: boolean;                          // default true: independent answer-key check pass (extra provider calls)
  model?: { provider: string; modelId: string };// optional override; otherwise task MCQ → DEFAULT preference
};
type CqSettings = {
  topic?: string; pastedText?: string; documentIds?: string[]; subject?: string;
  mode: CqMode;                                 // QUESTIONS_ONLY (no answers generated at all) | WITH_ANSWERS
  structure: CqStructure;                       // stimulus_4part: ক/খ/গ/ঘ (a–d) with levels KNOWLEDGE, COMPREHENSION, APPLICATION, HIGHER_ORDER
  partCount?: number;                           // multipart only, 2..6
  partMarks?: number[];                         // optional explicit marks per part; else defaults: 4part = [1,2,3,4]; multipart = even split of totalMarks
  totalMarks: number;                           // default 10 (stimulus_4part must equal sum(partMarks) = 10 by default)
  stimulus: "required" | "optional" | "none";   // stimulus_4part forces "required"; descriptive default "none"
  count: number; difficulty: DifficultySetting; language: Language;
  grounding: Grounding; model?: {provider: string; modelId: string};
};
```
Server rules: trim strings; reject unknown keys; `negativeMarks ≤ marks`; `partMarks.length === partCount` and sum === `totalMarks` (stimulus_4part: length 4); `QUESTIONS_ONLY` ⇒ no `answer`/`part.answer` in output;
documents must be the caller's own `READY` documents (else `VALIDATION` with `fields.documentIds` listing why); topic+documents with retrieval requires the `EMBEDDING` model and
matching `embeddingModel` (documents without a topic are sampled for coverage and need no embedding model).

### 4.3 Runs
* `GET /api/generation/runs?kind=MCQ|CQ&limit=10` → `{ items: RunSummary[] }` (SUCCEEDED only, newest first; expired runs are purged)
* `GET /api/generation/runs/:id` → `{ run: RunView }`
* `DELETE /api/generation/runs/:id`
* `POST /api/generation/runs/:id/regenerate` body `{ questionId: string /* draft id */, avoid?: string[] /* ≤60 stems, each ≤300 chars */ }` → `{ question: QuestionDraft }` — regenerates one question with the run's settings, replaces it in the stored run (same position), same validation. JSON response (not SSE). Counts toward quota.
* Run's `questions[]` is the **model output snapshot**; client edits live client-side until saved.

### 4.4 Questions (bank)
* `POST /api/questions` body `{ runId?: string, questions: QuestionInput[1..SAVE_BATCH_MAX], collection?: { id: string } | { create: { title; description?; subject? } } }` → 201 `{ items: { index: number; status: "CREATED"|"EXISTING"; question: QuestionView }[], collection: CollectionView | null, warnings: { index: number; code: string; message: string }[] }`. **Atomic** (all or nothing). Exact duplicate of an existing question (same `contentHash`) → `EXISTING` (reused, also added to the collection). Duplicates *within* the request → 422. Near-duplicate in the bank (pg_trgm similarity ≥ 0.85 on stem, same kind) → saved, warning `NEAR_DUPLICATE_IN_BANK` and the reason flag.
* `GET /api/questions?q=&kind=&difficulty=&subject=&topic=&tag=&language=&collectionId=&needsReview=true&sort=created|updated|difficulty&page=1&pageSize=20` → `{ items: QuestionView[] /* no collections */, total, page, pageSize }` (`pageSize` ≤ 50). `q` searches stem/topic/subject/tags (case-insensitive substring, trigram-indexed).
* `GET /api/questions/facets` → `{ subjects: {value,count}[], topics: {value,count}[], tags: {value,count}[] }` (top 100 each)
* `GET /api/questions/:id` → `{ question: QuestionView /* with collections */ }`
* `PATCH /api/questions/:id` body `{ question: QuestionInput; expectedVersion?: number; markReviewed?: boolean }` → `{ question }`. Full replace of content (ids retained for kept options/parts). `expectedVersion` mismatch → `CONFLICT`. Content change ⇒ `version+1`, new revision, `modifiedByUser=true` if AI-origin. `markReviewed:true` alone sets `reviewedAt` (no version bump).
* `DELETE /api/questions/:id`
* `POST /api/questions/bulk` body `{ action: "delete"|"addToCollection"|"removeFromCollection"|"markReviewed"|"addTags"|"setDifficulty", ids: string[1..200], collectionId?, tags?, difficulty? }` → `{ affected: number }` (ids not owned → ignored, never errors with existence info; `affected` counts only owned).
* `GET /api/questions/:id/revisions` → `{ items: { version: number; createdAt: string; question: QuestionContent }[] }`

### 4.5 Collections ("question sets")
* `GET /api/collections?q=&page=&pageSize=` → `{ items: CollectionView[], total, page, pageSize }` (`pageSize` ≤ 100; the same page parameters apply to a collection's questions, whose `pageSize` is also ≤ 100)
* `POST /api/collections` `{ title, description?, subject? }` → 201 `{ collection }` (title unique per user, case-insensitive → `CONFLICT`)
* `GET /api/collections/:id` → `{ collection }` · `PATCH` `{ title?, description?, subject? }` · `DELETE` (questions are kept)
* `GET /api/collections/:id/questions?page&pageSize` → `{ items: QuestionView[] (ordered by position), total, page, pageSize }`
* `POST /api/collections/:id/questions` `{ questionIds: string[1..200] }` → `{ added: number }` (idempotent; cap `COLLECTION_MAX_QUESTIONS`)
* `DELETE /api/collections/:id/questions/:questionId`
* `PUT /api/collections/:id/order` `{ questionIds: string[] }` — exact permutation of current members else 422

### 4.6 Export (server-side; also the basis for print layouts)
`POST /api/export` body:
```ts
{ source: { questionIds: string[] } | { collectionId: string } | { runId: string } | { drafts: QuestionInput[] /* validated like a save, nothing persisted */ },
  format: "json" | "txt" | "pdf",
  include: { answers: boolean; explanations: boolean; notes: boolean; sources: boolean },
  title?: string /* ≤120 */ }
```
→ binary body with `Content-Disposition: attachment; filename*=UTF-8''<slug>-<yyyymmdd>.<ext>`, `X-Content-Type-Options: nosniff`. Max 500 questions. Rate limited.
Exports contain **no** DB ids, owner data, provider/model, run ids, document ids, timestamps of other users, or credentials: questions get export-local ids `q1…`, options `a…`, parts `a…`.
JSON shape (validated by a Zod schema before sending): `{ format: "studyforge.questions", version: 1, title, exportedAt, questions: ExportQuestion[] }` where `ExportQuestion` = `QuestionContent` minus `sources[].documentId`, minus `reviewReasons` (kept: `sourceSupport`, `origin`).
TXT: plain readable (numbered questions, `A)`/`ক)` option labels, answer key section when `answers`). PDF: server-rendered, Bangla-capable (embedded Noto Sans Bengali), A4, answer key / explanations optional.

## 5. Server-side validation (backend, on save/PATCH/export-drafts and again on generation results)

1. Strict Zod parse; unknown keys rejected; strings trimmed; control chars (except `\n`, `\t`) stripped; Unicode NFC.
2. MCQ: `stem` non-empty; 2–6 options, each non-empty; option texts unique after normalisation (NFKC, lowercase, collapse whitespace, strip punctuation); exactly one `correctOptionId` referencing an option; no CQ fields. `"#<index>"` accepted for `correctOptionId` only when options lack ids.
3. CQ: `stem` non-empty; each part prompt non-empty; marks > 0; `marks` equals sum of parts if parts exist; no options.
4. Size limits (§2). `difficulty` concrete. Tags normalised.
5. Duplicates within a request: identical `contentHash`, or near-duplicate → 422 naming indexes. MCQ: stem token-Jaccard ≥ 0.8 **and** (option-set Jaccard ≥ 0.5 or the same correct answer). CQ: the stimulus (Jaccard ≥ 0.8) and the sub-question prompts (Jaccard ≥ 0.5) — the shared lead-in is ignored; part-less CQ: stem (+ stimulus).
6. `contentHash` = sha256 over canonical JSON of (kind, normalised stem, stimulus, normalised option texts sorted, correct option's normalised text, parts' normalised prompts) — unique per owner (`@@unique([ownerId, contentHash])`).
7. Source/provenance fields are never read from the client (§0.1).

## 6. Database (Prisma models; migration `…_part3_questions`)

`GenerationRun`, `Question`, `QuestionOption` (PK `(questionId,id)`, `isCorrect`, partial unique index: one correct per question), `QuestionPart` (PK `(questionId,id)`),
`ModelAnswer` (one per part, or one per question when `partId IS NULL`), `QuestionSource` (snapshots; optionally attached to a part's answer), `QuestionRevision` (immutable JSON snapshot per version),
`QuestionCollection` (`titleKey` unique per owner), `CollectionQuestion` (PK `(collectionId,questionId)`, `position`). Tags are `text[]` with a GIN index; stems have a trigram GIN index.
All owned rows cascade from `User`. `GenerationRun` → `Question.generationRunId` is `SET NULL` (runs expire; provenance provider/model/generatedAt is copied onto the question).
**Versioning strategy for published exams (Part 4):** an exam will reference `(questionId, version)` and copy the revision snapshot into its own rows when published; editing or deleting a bank question never alters a published exam.

## 7. rag_agent ⇄ backend contract additions (extends `rag_agent/CONTRACT.md`)

Auth, error shape, no-fallback and secret rules are unchanged. New endpoints, both **SSE**:
`POST /v1/generate/mcq` and `POST /v1/generate/cq`.

Request (JSON; keys are `SecretStr`):
```jsonc
{
  "request_id": "uuid", "user_id": "…",
  "chat": { "provider": "openai", "api_key": "…", "model": "…", "params": { "temperature": null, "top_p": null, "max_output_tokens": 4000 } },
  "embedding": { "provider": "…", "api_key": "…", "model": "…" } | null,   // needed only for topic + documents (retrieval)
  "context_tokens": 128000 | null,                                       // model context window when known (from the cached /models list)
  "grounding": "SOURCE_ONLY" | "SOURCE_PREFERRED" | "GENERAL",
  "sources": { "topic": "…" | null, "pasted_text": "…" | null, "document_ids": ["…"] },   // document ids authorised by the backend
  "spec": { /* MCQ */ "count": 10, "difficulty": "MIXED", "language": "en", "option_count": 4, "include_explanations": true, "include_short_notes": true,
            "marks": 1, "negative_marks": 0, "subject": null }
        | { /* CQ */   "count": 3, "mode": "WITH_ANSWERS", "structure": "stimulus_4part", "part_marks": [1,2,3,4], "total_marks": 10, "stimulus": "required",
            "difficulty": "MEDIUM", "language": "bn", "subject": null },
  "avoid": ["stems to not repeat …"],            // ≤ 60 × ≤ 300 chars (regeneration / continuation)
  "cross_check": true,
  "limits": { "batch_size": 10, "max_llm_calls": 16, "max_context_chars": 14000, "timeout_seconds": 240, "max_regen_per_batch": 2 }
}
```
Validation → 422 `VALIDATION`: `count` 1..100 (backend enforces the real cap), `document_ids` ≤ 50, `SOURCE_ONLY`/`SOURCE_PREFERRED` with no topic-independent source (no pasted text and no documents) → 422, `GENERAL` with sources → 422, `avoid` bounds.

SSE events: `meta` `{request_id, provider, model, kind}` · `status` `{stage, batch?, batches?}` ·
`result` `{ questions: Q[], rejected: n, warnings: [{code,message}], usage: {prompt_tokens, completion_tokens, llm_calls}, sources_used: [{document_id|null, document_name}] }` (terminal) · `error` (terminal; same error shape as chat, plus codes `GENERATION_FAILED` with `reason` ∈ `INVALID_OUTPUT|NO_VALID_QUESTIONS|INSUFFICIENT_SOURCES`).

`Q` (snake_case, already validated; ids generated by rag_agent):
```jsonc
{ "id": "g_9f2c…", "kind": "MCQ", "language": "en", "stem": "…", "stimulus": null,
  "options": [{"id":"a1b2c3","text":"…"}, …], "correct_option_id": "a1b2c3",
  "parts": [], "answer": null,
  "explanation": "…", "short_note": "…", "difficulty": "MEDIUM", "subject": null, "topic": "…", "tags": ["…"],
  "marks": 1, "negative_marks": 0,
  "sources": [{ "document_id": "…"|null, "document_name": "…", "chunk_id": "…"|null, "page": 3|null, "section": null, "quote": "…", "quote_verified": true }],
  "source_support": "SOURCE_QUOTED" | "MODEL_ONLY", "review_reasons": ["SOLVER_DISAGREES"] }
```
CQ `Q`: `parts: [{id,label,level,prompt,marks,answer:{text,basis,sources[]}|null}]`, `stimulus`, `answer` (only when `parts` is empty and mode WITH_ANSWERS), `options: []`, `correct_option_id: null`.

Workflow (LangGraph, bounded; typed state; keys only in context closures): `prepare` (pool: pasted text → pseudo-chunks `paste:<n>`; documents → retrieval for topic *or* deterministic coverage sampling; context budget = min(`max_context_chars`, 0.6·`context_tokens`·3 chars − reserved output)) → `gate` (SOURCE_ONLY with empty pool → `GENERATION_FAILED/INSUFFICIENT_SOURCES`) →
per batch: `generate` (structured output, prompt carries a machine-readable SPEC block + untrusted delimited SOURCES block, same injection defences as chat) → `validate` (deterministic: schema, option/answer integrity, duplicates incl. across batches and `avoid`, language script check, size caps, evidence quote verification, policy filter, marks arithmetic, explanation/answer-letter consistency, evidence-overlap heuristic) →
if short and attempts < `max_regen_per_batch` and calls < `max_llm_calls`: `regenerate` for the shortfall (with the rejection reasons, ≤2 per batch) → `cross_check` (one extra structured call per batch: an independent solver answers the questions *without* the key; mismatch ⇒ `SOLVER_DISAGREES`; never auto-deletes) → `finalize` (trim to `count`, warnings, usage). If after bounded attempts **zero** valid questions → error `GENERATION_FAILED/NO_VALID_QUESTIONS` (or `INVALID_OUTPUT` when the provider never produced parseable output). Partial results (≥1 valid but fewer than requested) succeed with warning `FEWER_THAN_REQUESTED`.
Never saves anything; never reads/writes tables except `Document`/`DocumentChunk` (read-only via the same isolation rules as `search_chunks`, plus a new `sample_chunks` with identical owner/doc/version/READY scoping).

### 7.1 Mock-provider behaviours (tests; `ALLOW_MOCK_PROVIDER=1` only)
The prompt contains `<<<SPEC:token>>>{json}<<<ENDSPEC:token>>>` (the same `spec` object plus `attempt`, `kind`, `batch_count`, `avoid`). The mock derives MCQ/CQ deterministically from the SOURCES block (or the topic) and honours `count`, `option_count`, `difficulty` (MIXED cycles EASY/MEDIUM/HARD), `language` (`bn` → Bangla stems/option labels containing Bangla script), `include_*`, `mode`, `structure`, `part_marks`. Markers found in the topic or pasted text:
`[[bad-json-once]]` (first attempt of each batch raises `STRUCTURED_OUTPUT_FAILED`) · `[[bad-json-always]]` · `[[bad-key-once]]` (first attempt has an invalid correct option on some questions) · `[[bad-key-always]]` · `[[dup]]` (duplicate stems) ·
`[[fake-evidence]]` (fabricated quotes) · `[[solver-disagree]]` (cross-check picks another option for question 1) · `[[answer-mismatch]]` (explanation names a different option) · `[[insufficient]]` (CQ answers unsupported) · `[[rate-limit]]`/`[[fail]]` (existing) · `[[slow]]` (≈20 s, so a client can Stop).

## 8. Frontend (summary; see UI spec in the task brief)
`/mcq`, `/cq`, `/question-bank` replace the placeholders; nav status `ready`. Shared `components/questions/*`. No client-side trust: the UI shows server results, sends only `QuestionInput`.
Print layout via `@media print`; copy as text; export via `POST /api/export`.
