# rag_agent ⇄ backend contract (v1)

`rag_agent` is a **stateless-ish internal AI service** (Python 3.13, FastAPI, LangChain, LangGraph). Only the StudyForge
`backend` calls it. The browser never talks to it. The backend is the system of record: it authenticates users, owns
encrypted credentials, decides which documents a user may use, and persists conversations. `rag_agent`:

1. **Provider layer** — OpenAI / OpenRouter / Groq (+ a test-only `mock`) adapters: test credentials, list models,
   chat (stream and non-stream), structured output, embeddings, normalized errors, usage.
2. **Ingestion** — extract text → chunk → embed → write `DocumentChunk` rows (pgvector).
3. **Retrieval + grounded chat** — LangGraph workflows for the two conversation policies.

Everything here is normative. If implementation reveals a needed change, keep the contract working and report the deviation.

## 0. Ground rules

* Port **8100**, bind `127.0.0.1` by default (`HOST`, `PORT` env).
* **Auth**: every `/v1/*` request needs `Authorization: Bearer <RAG_AGENT_TOKEN>` (constant-time compare). Missing/wrong →
  `401 {"error":{"code":"SERVICE_UNAUTHORIZED",...}}`. The service refuses to start if `RAG_AGENT_TOKEN` is unset or < 24 chars.
  `GET /health` (liveness, no deps) and `GET /ready` (DB reachable) are unauthenticated and return no internals.
* **API keys arrive in request bodies** (`api_key`). They must be `pydantic.SecretStr`, never logged, never echoed in
  responses/errors/traces, redacted from every exception message and log line (central `redact`). Never send a key to any
  host other than that provider's API base URL. Never reuse a key from one request in another.
* **No cross-provider fallback. Ever.** A failure of the requested provider is reported, not retried elsewhere.
* Treat document text as **untrusted data** (prompt injection). Enforce permissions in code/SQL, not in prompts.
* Config via env (pydantic-settings), validated at start, `.env.local` loaded in dev. See §8.
* Logs are JSON, structured, redacted. Never log request bodies, prompts, document text, or keys.

### Error shape (non-stream responses)

```json
{"error": {"code": "PROVIDER_RATE_LIMITED", "message": "safe user-facing text", "retryable": true, "retry_after_seconds": 12}}
```

Codes → HTTP: `VALIDATION`→422, `SERVICE_UNAUTHORIZED`→401, `PROVIDER_AUTH_INVALID`→502, `PROVIDER_RATE_LIMITED`→429,
`PROVIDER_TIMEOUT`→504, `PROVIDER_UNAVAILABLE`→502, `MODEL_NOT_FOUND`→502, `CONTEXT_TOO_LONG`→502,
`CAPABILITY_UNSUPPORTED`→422, `CONTENT_FILTERED`→502, `QUOTA_EXCEEDED`(provider billing/quota)→502, `PROVIDER_ERROR`→502,
`EMBEDDING_DIMENSION_MISMATCH`→422, `INTERNAL`→500. `message` is always safe to show a user (no key, no upstream body dump).
In streams the same object is sent as an `error` event.

## 1. Providers

Provider ids (lowercase on the wire): `openai`, `openrouter`, `groq`, `mock`.
`mock` exists **only if** `ALLOW_MOCK_PROVIDER=1` **and** `APP_ENV != production` (otherwise treated as unknown → 422 `VALIDATION`).

All three real providers are OpenAI-compatible HTTP APIs; implement them as adapters behind one interface (see §1.4) using
LangChain (`langchain-openai` `ChatOpenAI` / `OpenAIEmbeddings` with `base_url`) and `httpx` for model listing / credential tests.
**Verify current facts yourself from the official docs (WebFetch/WebSearch) — base URLs, `/models` response shapes,
embeddings availability (OpenRouter and Groq in particular), `stream_options.include_usage`, structured-output support,
header requirements (OpenRouter `HTTP-Referer`/`X-Title`) — do not rely on memory. Record what you verified, and the date, in
`app/providers/catalogue.py` and the README.** Do not hard-code model ids as if verified: model lists come from the provider API;
the catalogue only supplies capability *rules* (patterns) and is explicit about "verified-at" and about unknowns.

### 1.1 `GET /v1/providers`
Static provider catalogue (no keys): 
```json
{"providers":[{"id":"openai","name":"OpenAI","docs_url":"https://…","key_hint":"sk-…","capabilities":{"chat":true,"embeddings":true,"streaming":true,"structured_output":"model-dependent"},"embedding_dimensions_note":"…"}, …]}
```
Include `mock` only when enabled (name "Mock (testing only)").

### 1.2 `POST /v1/providers/test`
Body `{"provider":"openai","api_key":"…"}` → **always HTTP 200** `{"ok":true,"latency_ms":123,"models_count":57}` or
`{"ok":false,"code":"PROVIDER_AUTH_INVALID","message":"…","retryable":false}`. Uses the cheapest authenticated call (list models).
Timeout ≤ 15 s. Never include upstream response bodies.

### 1.3 `POST /v1/providers/models`
Body `{"provider":"openrouter","api_key":"…"}` →
```json
{"provider":"openrouter","fetched_at":"2026-…Z","models":[
  {"id":"…","name":"…","context_length":128000,"capabilities":{"chat":true,"embeddings":false,"streaming":true,"structured_output":"yes|no|unknown","tools":"yes|no|unknown"},"capability_source":"api|catalogue|unverified"}
]}
```
* Merge the provider's `/models` payload with catalogue rules. OpenRouter returns `supported_parameters`/architecture — use it
  (`capability_source:"api"`). OpenAI/Groq return little — use catalogue rules, else `"unknown"` with source `"unverified"`.
* Separate chat vs embedding models (embedding ids are returned for providers that have them, `capabilities.embeddings=true`).
  A model whose embeddings output cannot be 1536-d must be flagged `"embedding_dimensions":"incompatible"` (we store `vector(1536)`).
* Sort by id. Cap at 500 models.

### 1.4 Adapter interface (Python)
```python
class Provider(Protocol):
    id: str
    async def test(self, api_key: SecretStr) -> TestResult: ...
    async def list_models(self, api_key: SecretStr) -> list[ModelInfo]: ...
    async def generate(self, req: ChatRequest) -> ChatResult: ...            # text (+ usage)
    def stream(self, req: ChatRequest) -> AsyncIterator[ChatChunk]: ...      # deltas, final usage
    async def generate_structured(self, req: ChatRequest, schema: type[BaseModel]) -> StructuredResult: ...
    async def embed(self, req: EmbedRequest) -> EmbedResult: ...              # list[list[float]] length 1536 each
    def normalize_error(self, exc: Exception) -> ProviderError: ...
```
* `generate_structured`: if the model's `structured_output` is `yes` use native (`with_structured_output`/`response_format`);
  otherwise ask for JSON in the prompt, parse, validate with Pydantic, **one** bounded repair attempt, then raise
  `PROVIDER_ERROR`-class `STRUCTURED_OUTPUT_FAILED` (message safe). A `no` model is still allowed via the prompt path.
* Normalize **every** upstream failure (SDK/HTTP exceptions, timeouts, 401/403, 404 model, 429 incl. `Retry-After`,
  context-length, content filter, 5xx) to the codes in §0. Retries: at most **2** retries, only for 429/5xx/timeouts, exponential
  backoff with jitter, honour `Retry-After` but cap the wait at 5 s; never retry auth/validation errors; never switch provider.
* Timeouts: connect 10 s; non-stream total `PROVIDER_TIMEOUT_SECONDS` (default 60); stream: per-chunk idle timeout 60 s.
* Usage: return `prompt_tokens`/`completion_tokens`/`total_tokens` when the provider reports them, else `null` (never invent).
  For streams request usage (`stream_options={"include_usage":true}`) where supported.
* Embeddings: batch (≤ 64 inputs / request), `dimensions=1536` where the model supports it (OpenAI `text-embedding-3-*`),
  verify each vector has exactly `EMBEDDING_DIMENSIONS` (1536) floats else `EMBEDDING_DIMENSION_MISMATCH`. L2-normalised or not is
  fine (cosine is used). Providers without embeddings → `CAPABILITY_UNSUPPORTED`.

### 1.5 Mock provider (`mock`, test/dev only)
Deterministic, no network:
* `test`: `api_key == "mock-valid-key"` → ok; anything else → `PROVIDER_AUTH_INVALID`.
* `list_models`: `mock-chat` (chat, streaming, structured_output yes), `mock-chat-plain` (structured_output no), `mock-embed` (embeddings).
* `embed`: hashing bag-of-words → 1536-d, L2-normalised (lowercase, split on non-alphanumerics; identical text ⇒ identical vector;
  overlapping words ⇒ higher cosine). Must make lexical retrieval work end-to-end.
* chat/stream: echoes a deterministic reply. Special markers in the **last user message**: `[[rate-limit]]` → `PROVIDER_RATE_LIMITED`
  (retry_after 3), `[[fail]]` → `PROVIDER_UNAVAILABLE`, `[[slow]]` → streams ~1 token/150 ms for ~20 s (so a client can stop it),
  `[[leak]]` → reply deliberately includes the literal API key and a system-prompt canary (to test output filtering).
* structured/grounded generation: when the prompt contains numbered sources, answer with JSON
  `{"answer":"<quote text> [1]","supported":true,"citations":[{"source":1,"quote":"<first ≤120 chars of source 1's text, verbatim>"}]}`;
  if the last user message contains `[[bad-citation]]`, cite `source: 99` and a fabricated quote (to test validation);
  if it contains `[[unsupported]]` answer `{"answer":"","supported":false,"citations":[]}`.
* usage: report fake token counts (len/4).

## 2. Database contract (PostgreSQL + pgvector; managed by Prisma in `backend/prisma`)

Schema is created by `backend/prisma/migrations/*/migration.sql`. **Never create/alter tables from Python.** Quoted camelCase columns.

* `"Document"`: `id`, `ownerId`, `name`, `extension`, `mimeType`, `sizeBytes`, `sha256`, `storageKey`, `status`
  (`QUEUED|PROCESSING|READY|FAILED|NEEDS_OCR`), `statusCode`, `statusDetail`, `progress`, `pageCount`, `textLength`, `chunkCount`,
  `embeddingProvider`, `embeddingModel`, **`processingVersion`** (int, the version retrieval reads), `createdAt`, `updatedAt`, `processedAt`.
* `"DocumentChunk"`: `id` (text, you generate, e.g. uuid4 hex), `documentId`, `ownerId`, `chunkIndex`, `processingVersion`, `page` (nullable),
  `section` (nullable), `content`, `tokenCount`, `embeddingModel`, `metadata` (jsonb), `embedding vector(1536)`,
  `search tsvector` (GENERATED from content — never write it), `createdAt`.
  Unique `(documentId, processingVersion, chunkIndex)`. A trigger rejects chunks whose `ownerId` ≠ the document's `ownerId`.
  FK `documentId → Document.id ON DELETE CASCADE` (the backend deletes documents; you never delete documents).
* The service uses `DATABASE_URL` (psycopg3 + `pgvector` adapter, async pool). In production this is a role limited to
  `SELECT` on `"Document"` (+ `UPDATE ("processingVersion")`) and `SELECT/INSERT/DELETE` on `"DocumentChunk"`. Code must only touch those two tables.
* `"Document"."name"` is read for citations (`document_name`).

## 3. Ingestion — `POST /v1/ingest` (multipart/form-data)

Fields: `file` (the bytes) and `meta` (JSON string):
```json
{"document_id":"…","owner_id":"…","filename":"notes.pdf","mime_type":"application/pdf","processing_version":3,
 "embedding":{"provider":"openai","api_key":"…","model":"text-embedding-3-small"}}
```
Response: `application/x-ndjson`, one JSON object per line, flushed as produced:
```
{"type":"progress","stage":"extract","progress":15}
{"type":"progress","stage":"chunk","progress":35}
{"type":"progress","stage":"embed","progress":70}
{"type":"progress","stage":"store","progress":95}
{"type":"result","status":"READY","page_count":12,"text_length":48210,"chunk_count":31,"embedding_model":"text-embedding-3-small","code":null,"message":null}
```
or `{"type":"result","status":"NEEDS_OCR"|"FAILED","code":"…","message":"safe text", ...}` for *expected* outcomes, or
`{"type":"error","code":"PROVIDER_RATE_LIMITED","message":"…","retryable":true,"retry_after_seconds":8}` for provider/infra errors.
(HTTP status is 200 once streaming starts; validation errors before streaming are normal 4xx JSON errors.)

Rules:
* Verify the `"Document"` row exists with `id=document_id AND "ownerId"=owner_id` (else `VALIDATION`). The file is **not** trusted: re-validate by
  *content* (magic bytes/structure), not just extension: PDF (`%PDF-`), DOCX (OOXML zip with `word/document.xml`), TXT (valid text; reject binary/NUL-heavy),
  MD (text). Anything else → `FAILED` code `UNSUPPORTED_FILE`. Max bytes `MAX_UPLOAD_BYTES` (default 25 MiB), pages `MAX_PAGES` (500),
  extracted chars `MAX_TEXT_CHARS` (2 000 000) → `FAILED` `FILE_TOO_LARGE` / `TOO_MANY_PAGES` / `TEXT_TOO_LONG`.
* **Hardening**: DOCX zip-bomb guard (total uncompressed ≤ 200 MiB, ratio ≤ 100, entry count cap, no path traversal, never extract to disk);
  run parsers with a wall-clock timeout (`PARSE_TIMEOUT_SECONDS`, default 60) in an isolated worker (separate process with memory limit via
  `resource.setrlimit`, or equivalent) so a hostile file cannot hang or exhaust the service; never execute/render embedded content; ignore macros/links.
* **Extraction**: PDF → text per page (keep page numbers, 1-based; `pypdf` or PyMuPDF — pick the better maintained/permissive option and justify);
  DOCX → paragraphs (+ table text), headings become `section`; MD → keep text, headings → `section`; TXT → UTF-8 (BOM-aware UTF-16 ok).
  If a PDF yields (almost) no text (e.g. < 20 chars/page average) → `status:"NEEDS_OCR"`, `code:"NEEDS_OCR"`, message
  "This PDF looks scanned (no text layer). OCR is not configured on this server.", **no chunks stored**. OCR itself is optional; if you implement it
  (e.g. `OCR_ENABLED=true` + tesseract available) it must be off by default and degrade to NEEDS_OCR when unavailable.
  Empty text (not a scan) → `FAILED` `NO_TEXT`.
* **Chunking**: target ~`CHUNK_TARGET_CHARS` (default 3200 ≈ 800 tokens) with `CHUNK_OVERLAP_CHARS` (default 400); split on paragraph → sentence
  boundaries (include Bangla `।`); never split mid-word; PDF chunks never span pages (set `page`); other formats set `section` (nearest heading).
  `tokenCount` = approximation (chars/4) is fine. Drop empty/whitespace-only chunks. Deterministic output for identical input.
* **Embedding**: batches via the embedding provider (§1.4); progress between 35 and 90; transient provider errors retried per §1.4;
  everything fails atomically. Store `embeddingModel` = the model id used.
* **Store atomically (single transaction)**: insert all chunks with `processingVersion = processing_version`; delete chunks of *other* versions for this
  document; `UPDATE "Document" SET "processingVersion" = <new>`. If anything fails, the old chunk set and version stay untouched. Re-running the same
  `(document_id, processing_version)` must be idempotent (delete-then-insert that version inside the transaction). Never leave partial chunks.
* If the client disconnects mid-stream, cancel work and roll back.
* Do not log text; log `document_id`, stage, counts, durations.

## 4. Chat — `POST /v1/chat/stream` (Server-Sent Events)

Request:
```json
{
 "request_id":"uuid",
 "user_id":"…",
 "mode":"GENERAL" | "DOCUMENT_ONLY",
 "chat":     {"provider":"groq","api_key":"…","model":"…","params":{"temperature":0.3,"top_p":null,"max_output_tokens":1024}},
 "embedding":{"provider":"openai","api_key":"…","model":"text-embedding-3-small"} | null,
 "messages": [{"role":"user"|"assistant","content":"…"}],
 "document_ids": ["…"],
 "use_documents": true,
 "retrieval": {"top_k":6,"min_similarity":0.30,"max_context_chars":12000}
}
```
`messages` is the (already trimmed) history, last item is the new user message. `document_ids` were **authorized by the backend**
(may be empty). Validate: ≤ 40 messages, total chars ≤ `MAX_CHAT_CHARS` (default 60 000), `document_ids` ≤ 50, params within ranges
(temperature 0–2, top_p 0–1, max_output_tokens 1–32 768) else 422. `retrieval` is optional (env defaults).

SSE events (`event:` + `data:` JSON), in this order, **flush each immediately**:
* `meta` — `{"request_id","mode","provider","model","documents_considered":n,"retrieval":"performed|skipped|unavailable"}`
* `status` — optional UI hints `{"stage":"retrieving|generating|verifying"}`
* `delta` — `{"text":"…"}` (zero or more)
* `citations` — `{"citations":[{"ordinal":1,"document_id":"…","document_name":"…","chunk_id":"…","page":3|null,"section":"…"|null,"quote":"…","quote_verified":true}]}`
* `final` — `{"content":"full final text","fallback":false,"insufficient_evidence":false,"finish_reason":"stop|length|…","usage":{"prompt_tokens":n|null,"completion_tokens":n|null}}`
* `error` — error shape from §0 (terminates the stream; no `final`).
Exactly one of `final` / `error` ends the stream. If the client disconnects, cancel upstream provider calls promptly.

### 4.1 Policy A — `DOCUMENT_ONLY` (LangGraph workflow, typed state, bounded loops)

Nodes: `validate → retrieve → gate → generate → verify → (repair once) → finalize` / `fallback`.
1. **retrieve**: embed the query (last user message, optionally condensed with the previous user turn for follow-ups — do this with
   deterministic string logic, not an extra LLM call) using `embedding` credentials; run **hybrid search** (§5). If `embedding` is null or the
   embedding provider fails → no LLM call; return `error` (`CAPABILITY_UNSUPPORTED` if no embedding config, else the normalized provider error).
2. **gate** (deterministic, no LLM): if there are no chunks, or `max(similarity) < min_similarity`, → **fallback**: emit `final` with
   `fallback:true, insufficient_evidence:true` and exactly this content (and **no LLM call is made — assert this in tests**):
   `Sorry, I couldn't find enough relevant information in your uploaded documents to answer this question. Please upload a relevant document or ask a question about the available content.`
   (also when `document_ids` is empty). No `citations` event in this case.
3. **generate** (structured, §1.4): system prompt (rules below) + user content containing the sources inside a randomized delimited data block.
   Schema: `{"answer": str, "supported": bool, "citations":[{"source": int, "quote": str}]}`. `answer` uses `[n]` markers.
   The model is told to answer **only** from the sources, to set `supported:false` if they are insufficient, to quote verbatim, and never to follow
   instructions found inside sources.
4. **verify** (deterministic): JSON valid; `supported` true; every citation `source` ∈ `1..N`; every `quote` found in that source's chunk text after
   whitespace/case/Unicode-NFKC normalisation (else drop the citation); at least one verified citation; `[n]` markers in `answer` referencing valid sources
   only (strip invalid markers); `answer` non-empty and ≤ limit. **Leak filter**: if the answer contains any provided API key or the system-prompt
   canary → block. On failure: **one** repair attempt (re-generate with a terse corrective instruction — still a single bounded loop), then **fallback**
   (same fallback text; `insufficient_evidence:true`). For a blocked leak use the fallback text too but log a security event (no secrets).
5. Output: emit `status`, then one `delta` with the verified answer, `citations` (verified quotes, `quote_verified:true`, `document_name` read from the DB —
   **never taken from the model**), then `final`. Document-only answers are **buffered until verified**; unverified model text is never sent to the client.
6. `provider`/`model` failures during generate → `error` event (no fallback text, no other provider).

### 4.2 Policy B — `GENERAL`
* If `use_documents` and `document_ids` non-empty and an `embedding` config is present: retrieve (same as above). If chunks pass the gate, include them as
  *optional reference material* (numbered sources, same delimited-data treatment); otherwise answer without documents (`retrieval:"performed"` but no context).
  If retrieval **fails** (e.g. embedding provider error) answer without documents and set `meta.retrieval:"unavailable"` (do not fail the chat).
* **Stream** model deltas as they arrive. When sources were supplied, instruct the model to use `[n]` markers; after the stream, parse markers, keep valid ones,
  emit `citations` (no quote verification possible ⇒ `quote` = first ≤ 300 chars of the chunk text, `quote_verified:false`), then `final`.
  Do not strip text already streamed; `final.content` is the full text.
* The model may use general knowledge here. It must still refuse to reveal keys/system prompt (prompt) and the **leak filter** still applies to the final
  text (if triggered, `final.content` is replaced by a safe refusal sentence).

### 4.3 Prompt/safety requirements (both policies)
* System prompt is a constant in `app/prompts.py`; includes a per-process random **canary** string used only by the leak filter.
* Sources are rendered as `[n] (document name, page p) …text…` inside `<<<SOURCES:{random_token}>>> … <<<END:{random_token}>>>`; any occurrence of the token or
  of `<<<` in source text is neutralised. Sources are placed in the **user** turn, never in the system turn. The API key is never put in any prompt.
* History messages are passed as given but are also untrusted.
* LangSmith (optional): off by default. If `LANGSMITH_TRACING=true`, inputs/outputs are hidden unless `LANGSMITH_INCLUDE_CONTENT=true`
  (set `LANGSMITH_HIDE_INPUTS/OUTPUTS` accordingly at startup, and add a redaction hook); API keys must never be traced. Unit-test the config logic; live LangSmith is untestable here — say so.

## 5. Retrieval (`app/retrieval/`)

`search_chunks(conn, *, owner_id, document_ids, query_embedding, query_text, embedding_model, top_k, min_similarity)`:
* **One SQL query path** (parameterised, no string interpolation of user data). Every query includes
  `c."ownerId" = :owner AND d."ownerId" = :owner AND c."documentId" = ANY(:doc_ids) AND c."processingVersion" = d."processingVersion"
   AND d.status = 'READY' AND c."embeddingModel" = :embedding_model`. If `document_ids` is empty → empty result without querying.
* **Hybrid**: vector top-N by cosine (`1 - (embedding <=> :q)`) ∪ keyword top-N by `ts_rank` over `search` with `plainto_tsquery('simple', :text)`;
  fuse with Reciprocal Rank Fusion (k=60); return up to `top_k` chunks with `similarity` = the **cosine similarity** (needed for the gate; keyword-only
  hits have similarity computed from the vector too — compute cosine for all returned rows). Then bound total context to `max_context_chars`
  (drop lowest-ranked chunks that don't fit; always keep at least one).
* Return: `chunk_id, document_id, document_name, page, section, content, similarity, rank`.
* No ANN index exists on purpose (filtered, per-user sets); do not add one.

## 6. Observability & limits
* Request id propagated (header `x-request-id` and `request_id` in chat body) into logs. Per-request timeouts as above. Max concurrent ingests
  (`MAX_CONCURRENT_INGESTS`, default 2) → 429-style `PROVIDER_RATE_LIMITED`-like `BUSY` (use code `BUSY`, HTTP 429, retryable) when exceeded.
* Optional LangSmith as above. No other external telemetry.

## 7. Tests (pytest, `pytest-asyncio`, `respx` for HTTP mocks) — all deterministic, **no paid/live calls**
Must include: adapter tests per provider with mocked HTTP (success, 401, 403, 404 model, 429 with Retry-After, 5xx, timeout, context length, malformed
body; normalized codes; keys never appear in errors/logs — assert with a canary key); model listing merge/capability rules; structured output native + prompt-fallback
+ bounded repair; embeddings dimension check; extraction (PDF/DOCX/MD/TXT fixtures generated in tests), scanned-PDF → NEEDS_OCR, encrypted/corrupt/zip-bomb/oversize/
renamed-binary files; chunker properties (determinism, no mid-word split, page respect, overlap, Bangla `।`); ingest pipeline against **real Postgres+pgvector**
(atomic version switch, idempotent re-run, rollback on embedding failure, owner mismatch rejected); **retrieval isolation** (user A never sees user B's chunks even
when B's document ids are passed with A's `owner_id`; other-version chunks hidden; non-READY hidden; embeddingModel mismatch hidden; SQL-injection-shaped inputs);
document-only graph with a scripted fake provider: **gate fallback makes zero LLM calls**, supported answer with verified quote/citation/page, fabricated quote dropped,
source index out of range dropped, no valid citation → one repair → fallback, `supported:false` → fallback, leak filter, prompt-injection fixture (hostile chunk text) —
assert hostile text is only inside the delimited user-turn block, is neutralised, never in the system turn, and that the key/canary never reach the prompt or output;
general graph streaming with and without docs, retrieval failure tolerated; SSE endpoint tests (event order, disconnect cancels, auth required, validation, error event);
LangSmith config redaction logic.
Test DB: create/use database `studyforge_rag_test` on the local Postgres (`postgresql://studyforge:studyforge_dev_only@127.0.0.1:5440/…`, overridable with `RAG_TEST_DATABASE_URL`),
and build its schema by executing `../backend/prisma/migrations/*/migration.sql` in order (drop+recreate the `public` schema at session start). Never touch other databases.

## 8. Environment (`rag_agent/.env.example` with placeholders only)
`APP_ENV` (development|test|production), `HOST`, `PORT`, `DATABASE_URL`, `RAG_AGENT_TOKEN`, `ALLOW_MOCK_PROVIDER`, `EMBEDDING_DIMENSIONS`(=1536),
`MAX_UPLOAD_BYTES`, `MAX_PAGES`, `MAX_TEXT_CHARS`, `PARSE_TIMEOUT_SECONDS`, `CHUNK_TARGET_CHARS`, `CHUNK_OVERLAP_CHARS`, `PROVIDER_TIMEOUT_SECONDS`, `MAX_CHAT_CHARS`,
`RETRIEVAL_TOP_K`, `RETRIEVAL_MIN_SIMILARITY`, `RETRIEVAL_MAX_CONTEXT_CHARS`, `MAX_CONCURRENT_INGESTS`, `OCR_ENABLED`, `LOG_LEVEL`,
`LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_INCLUDE_CONTENT`.

## 9. Generation (Part 3)

Normative description: `backend/docs/PART3_SPEC.md` §7 (request/response shapes, workflow, mock behaviours §7.1). Everything in §0 (auth, key handling,
no provider fallback, error shape, logging) applies unchanged. Implementation map: `app/api/generate.py`, `app/graphs/generation.py`,
`app/generation/{schemas,validate,sources,prompting,text}.py`, prompts in `app/prompts.py`, retrieval helper `sample_chunks` in `app/generation/sources.py`
(same isolation as §5), mock behaviours in `app/providers/mock.py`.

* New error code `GENERATION_FAILED` (generation errors surface after streaming has started, so it appears as an SSE `error` event, never as an HTTP status) with `reason` ∈
  `INVALID_OUTPUT | NO_VALID_QUESTIONS | INSUFFICIENT_SOURCES`. `AppError.to_dict()` now includes `reason` when set.
* Recorded deviations from the spec text: see "Part 3 (generation) deviations and limits" in `README.md` (extra SPEC fields, GENERAL needs a topic,
  PREFERRED with no usable material fails, call-count accounting, soft/hard deadlines, MCQ-only cross-check, marks always taken from `part_marks`).
* Tests: `tests/test_generation_{validate,graph,sources,api}.py` (+ `gen_utils.py`); all use the mock provider or scripted fakes.
