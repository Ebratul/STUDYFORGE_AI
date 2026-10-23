# Embedding settings: configurable model + dimension, staged re-indexing

Status: implemented in this increment. Extends [AI_CONNECTION_SPEC.md](AI_CONNECTION_SPEC.md) §1–§3. This file is the contract between
`backend`, `rag_agent` and `frontend`.

## 1. Vocabulary

| Term | Meaning |
| --- | --- |
| **native dimension** | The vector length a model returns when no `dimensions` parameter is sent. Always **measured**, never looked up. |
| **dimension** | The length of the vectors StudyForge stores and searches for a user. Either the native one or a shortened one (below). |
| **request dimensions** | The value of the OpenAI-compatible `dimensions` request parameter needed to get `dimension`; `null` when the native size is used and nothing is sent. When set it always equals `dimension`. |
| **identity** | `provider + model + dimension`. Two vectors are comparable only if their identities are equal (equal length does **not** make two models interchangeable). |
| **active index** | The chunk set whose identity equals the user's saved embedding configuration. The only one retrieval reads. |
| **staged index** | A second chunk set for the same document version, built under a new identity while the active index keeps serving. |

Limits: `MIN_EMBEDDING_DIMENSION = 8`, `MAX_EMBEDDING_DIMENSION = 4096` (application caps, same constants in backend, rag_agent and the
UI). pgvector itself stores up to 16 000 per vector; the DB enforces `1..16000` through the generated column.

## 2. Where the dimension comes from (precedence)

1. **Database (per user)** – `ModelPreference(task=EMBEDDING).embeddingDimension` (+ `embeddingRequestDimensions`). Written only by a
   successful validation + activation, and always equal to the **measured** length. Once a user has this, it wins: changing the
   deployment default never changes, invalidates or re-indexes an existing configuration.
2. **Environment (deployment default)** – backend `EMBEDDING_DIMENSIONS` (optional, `8..4096`). It is only used to *seed a new
   candidate configuration* whose dimension the user left blank. It is validated exactly like a typed value, so a model that cannot
   produce it fails with a message that names the deployment default.
3. **Model** – otherwise the model's measured native dimension.

Candidate resolution when the user saves/tests (field `embeddingDimension`):

| Request | Same model id as the saved one | Different / no saved model |
| --- | --- | --- |
| a number | that number (`source: request`) | that number (`source: request`) |
| `null` ("Automatic") | env default if set (`environment`), else native (`model`) | same |
| omitted | the saved value (`database`) | env default if set, else native |

Legacy rows (before this feature) recorded no dimension; the old pipeline could only store 1536, so the migration records
`embeddingDimension = 1536` explicitly for them.

`rag_agent` has **no** dimension setting any more (`EMBEDDING_DIMENSIONS` was removed there). Every request names the dimension.

## 3. Validation (before anything is activated)

`rag_agent` `POST /v1/providers/validate` now takes `embedding_dimension` (the *requested* size, optional) and does:

1. probe **without** `dimensions` → native dimension *D0* (exactly one finite, non-empty vector, or `PROVIDER_ERROR`);
2. requested absent or equal to *D0* → dimension = *D0*, `request_dimensions = null`;
3. otherwise probe **with** `dimensions=N`; the returned length must be exactly *N* → dimension = *N*, `request_dimensions = N`.
   * provider rejects the parameter (HTTP 4xx other than auth/rate/quota/model-not-found) → `EMBEDDING_DIMENSION_UNSUPPORTED`;
   * provider ignores it or returns another length → `EMBEDDING_DIMENSION_MISMATCH` (reports the returned length and *D0*).

No vector is ever padded, truncated or re-normalised. Whether a model supports a size is decided by the provider's actual answer, not by a
built-in list. Response additions on `checks.embedding`: `dimension`, `native_dimension`, `request_dimensions`.

The backend then re-checks: measured equals requested (when one was given), `8 ≤ measured ≤ 4096`, and the database column can store
that length (`DB_VECTOR_UNAVAILABLE` / `DB_DIMENSION_MISMATCH`).

Every later embedding call (ingest, re-index, query) sends `dimensions=request_dimensions` iff it is non-null, and checks that **every**
returned vector has length `dimension` (`EMBEDDING_DIMENSION_MISMATCH`, not retryable).

## 4. Storage and retrieval

* `DocumentChunk.embedding` is plain `vector` (no length). `embeddingDimension` is `GENERATED ALWAYS AS (vector_dims(embedding)) STORED`
  so it cannot disagree with the data. `embeddingProvider` (wire id) and `embeddingModel` complete the identity.
* Unique key: `(documentId, processingVersion, embeddingProvider, embeddingModel, embeddingDimension, chunkIndex)`; a document version can
  hold the active and the staged set at once.
* **Every read names one identity.** `search_chunks` filters `embeddingProvider`, `embeddingModel`, `embeddingDimension`, requires the
  query vector to have that length, and evaluates the filter before any distance operator (`MATERIALIZED` CTE), so vectors of different
  lengths are never compared. Full-document context (`generation/sources.py`) reads the identity recorded on the `Document` row.
* The backend additionally excludes documents whose recorded identity differs from the active configuration (`isCompatible`).
* No ANN index (unchanged). If one is added later it must be one expression index per dimension (`(embedding::vector(N))`).

## 5. Staged re-indexing

Saving a connection whose embedding identity differs from the active one:

* **no READY documents** (or first-time setup, or identity unchanged) → activated immediately in one transaction, as before;
* **READY documents exist** → the chat settings and credentials are saved, but `ModelPreference(EMBEDDING)` is **not** changed. An
  `EmbeddingReindex` row (`BUILDING`, target identity, at most one per user) is created and one `reindex-document` job per READY document
  is queued. The old index keeps serving chat, retrieval and generation.

`reindex-document`: `rag_agent` `POST /v1/reindex` re-embeds the document's *existing chunk texts* (same chunking, same ids order) under
the target identity into a second chunk set, verifying in the same transaction that the count equals the source count and that every
vector has exactly the target length. Nothing of the old set is touched.

`reindex-finalize` (queued after each document finishes, deduplicated): in **one transaction** (row lock on the `EmbeddingReindex`) it
re-verifies in SQL that every READY document has a staged set with the same chunk count as its active set, all vectors of the target
length, for the document's *current* `processingVersion`; no document may be QUEUED/PROCESSING. Only then it
1. points `ModelPreference(EMBEDDING)` at the target (credential, model, dimension, request dimensions),
2. updates every READY document's recorded identity,
3. deletes the old identity's chunks,
4. marks the reindex `ACTIVATED`.

If documents appear/change meanwhile they get their own `reindex-document` job and finalize waits; if documents are still processing
finalize retries later. A permanent failure (auth invalid, model gone, dimension mismatch, …) marks the reindex `FAILED` with a safe
message and deletes the staged chunks; the active index is untouched. The user can cancel (`CANCELLED`, staged chunks deleted) or retry.
Saving a different embedding configuration while one is building cancels the old build first. Saving the *active* identity again cancels
a pending build.

## 6. Backend HTTP API (all under `/api/ai`, session-authenticated)

`GET /connection` → `{ connection }`, new/changed fields:

```ts
embeddingDimension: number | null;              // ACTIVE index size (database value)
embeddingRequestDimensions: number | null;      // non-null = the model is asked for this size (shortened)
dimensionLimits: { min: number; max: number };  // 8..4096
defaultEmbeddingDimension: number | null;       // deployment default (env), null when unset
reindex: null | {
  id: string; status: "BUILDING" | "FAILED";
  provider: "openrouter" | "openai" | "groq" | "mock"; modelId: string; dimension: number;
  progress: { total: number; done: number };    // READY documents / those with a verified staged set
  errorCode: string | null; errorMessage: string | null; createdAt: string;
};
// removed: expectedDimension. configured stays true while a build is pending (credentials differing is expected then).
```

`PUT /connection` and `POST /connection/test` accept `embeddingDimension?: number | null` (§2 table), integer `8..4096` else
`VALIDATION` with `fields.embeddingDimension`.

* Test response: `{ ok, provider, checks, measuredDimension, nativeDimension, requestedDimension, dimensionSource }` where
  `dimensionSource ∈ "request" | "database" | "environment" | "model"`. (`expectedDimension` removed.)
* Save response: `{ connection, checks, embeddingChange: { status: "unchanged" | "activated" | "reindexing"; documents: number } }`
  (`reembedRequired` / `documentsAffected` removed).
* Failed save: `AI_CONFIG_INVALID` with `checks` and `fields`; dimension problems are reported on `fields.embeddingDimension`, model
  problems on `fields.embeddingModelId`. The previous configuration is never changed by a failed attempt.
* `POST /embedding-reindex/cancel` and `POST /embedding-reindex/retry` → `{ connection }`. Both are same-origin guarded and rate limited;
  `retry` only on a `FAILED` build; `cancel` on `BUILDING` or `FAILED`.

## 7. rag_agent HTTP contract changes (see also `rag_agent/CONTRACT.md`)

* Embedding credentials everywhere (`ingest` meta, `chat`, `generate`): `{ provider, api_key, model, dimension, request_dimensions? }`.
  `dimension` is **required**. `request_dimensions`, when present, must equal `dimension`.
* `POST /v1/providers/validate`: request gains `embedding_dimension?: int | null`; response `embedding_dimension` is the verified
  dimension; `checks.embedding` gains `dimension`, `native_dimension`, `request_dimensions`.
* `POST /v1/reindex` (new, JSON): see §5. Body `{ document_id, owner_id, processing_version, source: {provider, model, dimension}, target: {provider, api_key, model, dimension, request_dimensions?} }`.
  200 `{ type: "result", status: "READY" | "STALE", chunk_count, embedding_dimension }` (`STALE` = the document changed or the source set
  is missing; nothing written). Provider failures use the normal error envelope (`code`, `retryable`).
* Error codes: `EMBEDDING_DIMENSION_MISMATCH` (returned length differs from what was asked) and new `EMBEDDING_DIMENSION_UNSUPPORTED`
  (the provider rejects the `dimensions` parameter for this model).
* Mock provider (tests/e2e only) models: `mock-embed` native 1536; `mock-embed-<N>` native *N* (8..4096); `mock-embed-flex` native 1024 and
  honours `dimensions` 8..1024; `mock-embed-ignore` native 768 and silently ignores `dimensions`; `mock-embed-strict` native 1536 and
  rejects `dimensions` (HTTP 400 style); `mock-embed-nan` unchanged.

## 8. Known limits

* Only the OpenAI-compatible `dimensions` parameter is used to shorten vectors. Providers that expose other knobs (`output_dimension`, …)
  work at their native size only.
* Shortening is only as good as the model: only Matryoshka-trained models keep quality at smaller sizes. The UI says so.
* Re-indexing re-embeds stored chunk text; it does not re-parse files. Documents whose chunks are missing are reported as failed.
* One staged build per user; documents added during a build are picked up by the finalize loop.
