# StudyForge AI — `rag_agent`

Internal AI service (Python 3.13, FastAPI, LangChain, LangGraph). Only the StudyForge `backend` calls it; browsers never do.
The backend authenticates users, owns encrypted credentials, decides which documents a user may use and persists conversations.
`rag_agent` provides: provider adapters (OpenAI / OpenRouter / Groq + a test-only `mock`), document ingestion into pgvector,
owner-scoped hybrid retrieval, and LangGraph workflows for the two conversation policies. The normative spec is `CONTRACT.md`.

## Setup, run, test

```bash
export PATH=/home/ebratul/miniconda3/bin:$PATH      # where `uv` lives on this machine
cd rag_agent
uv sync                                              # creates .venv (Python 3.13) from pyproject.toml / uv.lock
cp .env.example .env.local                           # then fill in DATABASE_URL and RAG_AGENT_TOKEN (git-ignored)
uv run uvicorn app.main:app --host 127.0.0.1 --port 8100
uv run pytest                                        # full suite (needs Postgres+pgvector, see below)
```

`python -m app` is an alternative entry point that takes `HOST`/`PORT` from the environment.

Tests build the schema in the database `studyforge_rag_test` (override with `RAG_TEST_DATABASE_URL`; the default is
`postgresql://studyforge:studyforge_dev_only@127.0.0.1:5440/studyforge_rag_test`) by dropping/recreating the `public` schema and executing
`../backend/prisma/migrations/*/migration.sql` in order (these create `vector` and `pg_trgm`). The fixture refuses any database whose name does
not end in `_rag_test`. Never run `prisma migrate` for this service: the schema belongs to the backend.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `APP_ENV` | `development` | `development` / `test` / `production`. `.env.local` is read only outside production. |
| `HOST`, `PORT` | `127.0.0.1`, `8100` | Used by `python -m app` (the uvicorn CLI takes its own flags). |
| `DATABASE_URL` | — | psycopg3 URL. Production role: `SELECT` (+`UPDATE ("processingVersion")`) on `"Document"`, `SELECT/INSERT/DELETE` on `"DocumentChunk"`. |
| `RAG_AGENT_TOKEN` | — | Bearer token for `/v1/*`. Service refuses to start if unset or < 24 chars (the error never prints the value). |
| `ALLOW_MOCK_PROVIDER` | `0` | `1` enables provider `mock`; ignored (provider unknown) when `APP_ENV=production`. |
| `EMBEDDING_DIMENSIONS` | `1536` | Must be 1536 (`vector(1536)`). |
| `MAX_UPLOAD_BYTES` / `MAX_PAGES` / `MAX_TEXT_CHARS` | 25 MiB / 500 / 2 000 000 | Ingestion limits. |
| `PARSE_TIMEOUT_SECONDS` / `PARSE_MEMORY_MB` | 60 / 1024 | Wall clock and address-space limit of the parser worker. |
| `CHUNK_TARGET_CHARS` / `CHUNK_OVERLAP_CHARS` | 3200 / 400 | Chunking. |
| `PROVIDER_TIMEOUT_SECONDS` / `STREAM_IDLE_TIMEOUT_SECONDS` | 60 / 60 | Non-stream total timeout / per-chunk idle timeout. Connect timeout is fixed at 10 s. |
| `MAX_CHAT_CHARS` | 60000 | Total characters across `messages`. |
| `RETRIEVAL_TOP_K` / `RETRIEVAL_MIN_SIMILARITY` / `RETRIEVAL_MAX_CONTEXT_CHARS` | 6 / 0.30 / 12000 | Defaults; overridable per request. |
| `MAX_CONCURRENT_INGESTS` | 2 | Above this, `/v1/ingest` answers 429 `BUSY`. |
| `OCR_ENABLED` | `false` | Accepted, but **no OCR engine is wired**: scanned PDFs always return `NEEDS_OCR` (a warning is logged at start). |
| `LOG_LEVEL` | `INFO` | JSON logs on stderr. |
| `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` / `LANGSMITH_INCLUDE_CONTENT` | off | See "LangSmith". |

## API (all `/v1/*` need `Authorization: Bearer $RAG_AGENT_TOKEN`)

* `GET /health`, `GET /ready` (unauthenticated, no internals).
* `GET /v1/providers`; `POST /v1/providers/test` (always HTTP 200); `POST /v1/providers/models`.
* `POST /v1/ingest` (multipart `file` + `meta`; response `application/x-ndjson`).
* `POST /v1/chat/stream` (SSE: `meta`, `status`, `delta`, `citations`, `final` | `error`).

Errors use `{"error":{"code","message","retryable","retry_after_seconds?"}}`; messages are fixed safe strings (no upstream bodies, no keys).

## Architecture

```
app/main.py            factory, middleware (request id, body-size cap), exception handlers
app/config.py          pydantic-settings; app/security.py bearer check (constant time)
app/redact.py          central redaction (bound request secrets + key patterns); app/logging.py JSON logs
app/errors.py          codes, HTTP mapping, safe messages
app/providers/         base (types/Protocol), openai_compat (LangChain ChatOpenAI/OpenAIEmbeddings + httpx),
                       openai / openrouter / groq / mock, catalogue (facts + capability rules), errors (normalisation), retry, registry
app/ingest/            extract (pure parsers), worker+sandbox (isolated subprocess), chunk, pipeline (embed + atomic store)
app/retrieval/search.py  ONE parameterised hybrid SQL (vector + ts_rank, RRF k=60), owner/doc/version/READY/model scoped
app/graphs/            state, document_only (LangGraph), general (LangGraph), runner (SSE events, cancellation)
app/prompts.py         constant system prompts + canary, delimiter/neutralisation; app/citations.py deterministic verification
app/streaming.py       disconnect-aware streaming; app/tracing.py LangSmith policy
```

Policy A (`DOCUMENT_ONLY`): `validate → retrieve → gate → generate → verify → (repair once) → finalize | fallback`. Gate, verification and
fallback are plain code; the fallback makes **zero** LLM calls. Unverified model text is never sent. Policy B (`GENERAL`): optional retrieval
(failures tolerated, `meta.retrieval:"unavailable"`), streamed deltas, `[n]` citations with `quote_verified:false`.

Ingestion: content sniffing (extension must agree with magic bytes/structure) → parse in a **separate process** (`python -I worker.py`; applies
`RLIMIT_AS/CPU/FSIZE/NOFILE` to itself, empty environment, killed on wall-clock timeout, bounded stdout) → chunk → embed (batches ≤ 64) →
one transaction: lock document row, delete same version, insert, delete other versions, set `processingVersion`.

### PDF library choice: `pypdf`
BSD-licensed, pure Python (no native code in the process that parses hostile input), actively maintained, enough for text-layer extraction with
per-page text. PyMuPDF is faster and renders pages, but is AGPL/commercial licensed and a large native attack surface; this service never renders.

### Pin: `openai>=2,<3`
`openai` 3.x switched its HTTP stack to `httpx2`, which `respx` (the mandated HTTP mock) cannot intercept. `langchain-openai` supports both; 2.x keeps
every provider path testable with real mocked HTTP. Revisit when respx supports httpx2.

## Security notes

* API keys are `SecretStr`; they are bound per request to a contextvar so `scrub()` removes the exact values (plus key-shaped patterns) from every
  log line, error and trace payload. Tests use a canary key across success, error, validation, log and SSE paths.
* A key is only ever sent to that provider's fixed base URL (not configurable per request); redirects are not followed; no cross-provider fallback.
* Document text is untrusted: sources live only in the **user** turn, inside `<<<SOURCES:{random}>>>…<<<END:{random}>>>`; `<<<`/`>>>`, the token and
  fake `[n] (` source headers inside text are neutralised; document names are sanitised. Permissions are enforced in SQL, not in prompts.
* Output leak filter (both policies): any bound API key or the per-process canary blocks the answer. In GENERAL streaming the last
  `len(longest secret)-1` characters are held back so a secret split across deltas is never sent.
* Retrieval SQL is parameterised, always owner-scoped on chunk **and** document, plus `processingVersion`, `READY`, `embeddingModel`. No ANN index (by design).
* Logs never contain request bodies, prompts, document text or exception messages (only exception type). uvicorn's own loggers are routed through the same redaction.

## LangSmith
Off by default (and forced off in the process environment, so an ambient `LANGSMITH_TRACING=true` cannot enable it). When `LANGSMITH_TRACING=true` and a
key is set, one explicit tracer is attached whose client hides all inputs/outputs unless `LANGSMITH_INCLUDE_CONTENT=true`, in which case payloads are
scrubbed. API keys are kept out of graph state entirely (they live in per-request closures). **Not tested live** (no account/key here): only the
configuration logic and hook wiring are unit-tested, with the network client replaced by a fake. Scrubbing inside the tracer thread is pattern-based
(the per-request exact-match secrets are a contextvar and are not visible to LangSmith's background thread).

## Verified provider facts (checked against official docs on 2026-10-22; details in `app/providers/catalogue.py`)

| | OpenAI | OpenRouter | Groq |
|---|---|---|---|
| Base URL | `https://api.openai.com/v1` | `https://openrouter.ai/api/v1` | `https://api.groq.com/openai/v1` |
| `GET /models` | `{data:[{id,object,created,owned_by,shutdown_date?}]}` — no context length, no capabilities | `{data:[{id,name,context_length,architecture{input/output_modalities},supported_parameters,pricing,…}]}`; **public** (does not validate a key) | `{data:[{id,object,created,owned_by,active,context_window,public_apps}]}` |
| Credential check | `GET /models` | `GET /key` (authenticated; 401 on bad key), then `/models` for the count | `GET /models` |
| Embeddings | yes: `POST /embeddings`, `dimensions` for `text-embedding-3-*` (small = 1536 native, large = 3072 → request `dimensions=1536`) | yes: `POST /embeddings` (+ `GET /embeddings/models`); `dimensions` documented | **no** embeddings API (not in API reference nor models page) |
| Structured output | `json_schema` for gpt-4o-mini / gpt-4o-2024-08-06 and later | `structured_outputs` / `response_format` appear in each model's `supported_parameters` | `json_schema` documented for `openai/gpt-oss-20b`, `openai/gpt-oss-120b` (+ others named in docs); `json_object` on all |
| Stream usage | `stream_options.include_usage` | usage sent once in the final chunk (no option) | `include_usage` only confirmed by third-party sources — unverified; usage degrades to `null` |
| Headers | none | `HTTP-Referer`, `X-OpenRouter-Title`/`X-Title` **optional**; we send `X-Title` only | none |
| Errors | OpenAI error JSON | `{error:{code,message,metadata}}`; 401/402/403/408/429/502/503; `Retry-After` on 429/503 | OpenAI-style; `logprobs`/`logit_bias`/`n≠1` rejected |

Model ids are never hard-coded as verified; lists come from the provider API and the catalogue contributes only capability *rules* (patterns), tagged
`capability_source: api | catalogue | unverified`. Rules inferred rather than documented (e.g. "gpt-5*/o3 support json_schema", "o-series/gpt-5 reject
temperature") are marked as such in the catalogue.

## Deviations from CONTRACT.md and known limitations

See the final report of the implementation task; the authoritative list is kept here:

* `meta` is emitted after retrieval (so it can carry the real `retrieval` value); the optional `status:"retrieving"` hint is therefore not emitted.
  On a retrieval error in `DOCUMENT_ONLY`, `meta` (with `retrieval:"unavailable"`) is followed by `error`.
* Empty `document_ids` in `DOCUMENT_ONLY` gives the deterministic fallback before the embedding config is checked.
* Verified-quote policy is stricter than the contract: quotes shorter than 10 normalised chars (unless the chunk itself is shorter) are rejected; `[n]`
  markers for sources without a verified quote are stripped; one citation per source (ordinal = source number in the prompt).
* Extra codes: `BUSY` (429), `FILE_TOO_LARGE` (413 for bodies above `MAX_UPLOAD_BYTES`+1 MiB, otherwise a `FAILED` result line), `STRUCTURED_OUTPUT_FAILED`
  (502), ingestion result codes `ENCRYPTED_FILE`, `CORRUPT_FILE`, `UNSAFE_ARCHIVE`, `PARSE_TIMEOUT`, `PARSE_MEMORY`, `PARSE_FAILED`, `STALE_VERSION`.
  `STALE_VERSION`: an ingest whose `processing_version` is lower than the document's current one is refused (prevents a late job overwriting newer chunks).
* Native structured output that the endpoint rejects with a 400 falls back, once, to the prompt path on the same provider/model (never another provider).
* The non-stream timeout applies per attempt (a retried request can take up to 3× `PROVIDER_TIMEOUT_SECONDS`).
* Embedding usage is not reported (LangChain's embeddings client discards it). Retrieval treats the request's `user_id` as the owner.
* Request bodies without `Content-Length` are counted while read; the ASGI server itself has no body limit, so run behind the backend only (127.0.0.1).
* Parser isolation is process + rlimit based (no seccomp/namespace sandbox). DOCX is parsed with python-docx/lxml (entities are not resolved).
* Scanned PDFs are not OCR'd; encrypted PDFs are rejected rather than decrypted.
* Streaming latency: GENERAL output is delayed by up to ~30 characters by the leak-guard holdback.
