# Vector storage: PostgreSQL (pgvector) and Pinecone

Status: implemented and tested with mocks and a faithful fake of Pinecone's REST API. **No live Pinecone call has ever been made by the
test suite or by this work** (see §12). The default is, and stays, `VECTOR_STORE=pgvector`.

## 1. Modes

`VECTOR_STORE` is set to the **same value** in `backend/.env` and `rag_agent/.env`.

| Mode | New vectors are written to | Semantic search is served from | Use |
|---|---|---|---|
| `pgvector` (default) | PostgreSQL | PostgreSQL | Today's behaviour, unchanged. Needs no Pinecone setting. |
| `dual` | PostgreSQL **and** Pinecone | **PostgreSQL**; Pinecone is queried in the background and compared | Observation period: build confidence without exposing users to Pinecone. |
| `pinecone` | Pinecone **and** (by default) PostgreSQL | **Pinecone** (every candidate re-validated in PostgreSQL) | Cut-over. |

In all modes PostgreSQL stays the system of record for chunk **text**, pages/sections, ownership, authorisation, document status and
`processingVersion`. Pinecone holds vectors, ids and five small metadata fields; never text.

`PINECONE_KEEP_POSTGRES_VECTORS` (rag_agent, default `true`): in `pinecone` mode keep also writing each vector to PostgreSQL. Retrieval
does not read it; it is what makes **rollback a one-line change**. Setting it `false` stops storing every vector twice, at the price that
documents ingested afterwards have no local vector and would need re-embedding to go back to `pgvector`.

## 2. Data flow

```
 ingest ─► extract ─► chunk ─► embed (provider, key = the user's)
                                  │ verify every vector has EXACTLY the configured length (never pad/truncate)
                                  ▼
            [dual|pinecone] upsert to Pinecone ─► wait (bounded) until the vectors are fetchable
                                  ▼
            PostgreSQL transaction: lock Document, replace this identity's chunk rows, delete older versions' rows,
                                    set processingVersion          (pineconeIndexedAt set, embedding set unless opted out)
                                  ▼
            backend: READY + queue "delete-vectors" for the previous version, in ONE transaction
```

* Pinecone and PostgreSQL **cannot commit atomically**; nothing here claims they do. The order above means a crash can only leave
  *vectors without a PostgreSQL row* (never the reverse), and those can never be returned (§4).
* Any failure after the upsert (database error, stale version, client disconnect/cancellation) deletes exactly the ids this attempt wrote
  (compensation, shielded from cancellation, never raises). If that delete also fails the orphans stay, harmlessly (§7).
* Chunk ids are deterministic: `sha256(documentId, version, provider, model, dimension, chunkIndex)[:32]` (same shape as the old random
  ids). Retrying the same step overwrites the same Pinecone ids and replaces the same PostgreSQL rows, so every write is idempotent.
* The Pinecone vector id is `{documentId}:{chunkId}`: a document's vectors share a listable prefix.

### Retrieval (`pinecone` mode)

1. PostgreSQL: which of the requested documents belong to the caller and are `READY`? (None → Pinecone is not even called.)
2. Pinecone: nearest `n` vectors, filtered by `ownerId`, `documentId ∈ authorised`, provider, model and the documents' current versions.
   It returns **ids and scores only**.
3. PostgreSQL, one statement: keep a candidate only if its chunk row has the same owner on chunk **and** document, an authorised
   document id, `processingVersion = Document.processingVersion`, `READY`, the same embedding identity, and the Pinecone marker. The same
   statement ranks the keyword side (`tsvector`) and returns text, page and section.
4. Reciprocal Rank Fusion (`k = 60`), exactly as in the pgvector query.

A foreign, unknown, stale, orphaned, other-identity, not-READY or unauthorised id returned by Pinecone is dropped silently. Tested with a
store that returns such ids first (`tests/test_vector_search.py`).

### Dual mode

The PostgreSQL answer is served and is never changed or delayed beyond `VECTOR_SHADOW_TIMEOUT_SECONDS` (default 5). The Pinecone path runs
afterwards and logs one structured event, `vector_shadow_compare`: counts, overlap, Jaccard, `top1_same`, `same_order`,
`max_similarity_delta` (WARNING when the result sets differ), or `vector_shadow_failed` (type/code only). **No chunk text, query text or
secret is logged.** Not comparable by design: a keyword-only hit has no Pinecone score (shown as similarity `0.0`).

## 3. Isolation

* **Namespace per user** (`PINECONE_NAMESPACE_MODE=per-user`, default): `"{PINECONE_NAMESPACE_PREFIX}-u-{ownerId}"`. Account deletion is one
  namespace delete. **Shared** mode uses one namespace and relies on the mandatory `ownerId` filter plus the PostgreSQL validation.
* Namespaces and filters are built in **one place** (`PineconeStore.namespace_for` / `query`). No caller, endpoint or job can supply a
  namespace, filter, index or host. Owner/document/chunk ids must match `[A-Za-z0-9_-]{1,200}` (checked with a full match).
* The `ownerId` filter is sent **even in per-user mode** (defence in depth), and `/v1/vectors/delete` re-checks ownership/identity from
  vector metadata in shared mode.
* The Pinecone API key exists only in rag_agent's environment, is sent only to a validated `*.pinecone.io` host, and is redacted from logs
  and errors (`pcsk_…` pattern + exact value). Redirects are not followed. The frontend and backend never see it.

## 4. Why a bad vector store cannot leak data

Step 3 of retrieval is the authorisation point, and it uses PostgreSQL rows the vector store cannot influence. Pinecone being stale,
lagging after deletes, containing orphans, or even returning another user's ids changes at most the *ranking quality*, never *what may be
shown*. This is why eventual consistency is acceptable.

## 5. Configuration

rag_agent (`rag_agent/.env.example` documents all of them; a test fails if code and example drift):

| Variable | Default | Meaning |
|---|---|---|
| `VECTOR_STORE` | `pgvector` | `pgvector` \| `dual` \| `pinecone` |
| `PINECONE_API_KEY` | – | Required for dual/pinecone. Put the real value in `.env.local` (git-ignored). |
| `PINECONE_INDEXES` | – | JSON `{"1536":{"name":"…","host":"….svc.….pinecone.io"}}`: dimension → **explicit** index name and data-plane host. Only these sizes are accepted. |
| `PINECONE_NAMESPACE_MODE` | `per-user` | `per-user` \| `shared` |
| `PINECONE_NAMESPACE_PREFIX` | – | Required for dual/pinecone; separates environments (`dev`, `prod`). |
| `PINECONE_KEEP_POSTGRES_VECTORS` | `true` | See §1. |
| `PINECONE_TIMEOUT_SECONDS` / `PINECONE_MAX_RETRIES` | `10` / `4` | Per request / retries for 429, 5xx, timeouts (exponential backoff, `Retry-After` honoured). |
| `PINECONE_VISIBILITY_TIMEOUT_SECONDS` | `30` | Bounded wait for new vectors to become fetchable (0 = don't wait). |
| `VECTOR_SHADOW_TIMEOUT_SECONDS` | `5` | Dual mode comparison budget. |

Backend: only `VECTOR_STORE` (must equal rag_agent's). Startup/connection checks detect a mismatch (`VECTOR_STORE_MISCONFIGURED`).
Invalid Pinecone settings stop rag_agent at start-up with the **field name only** (never a value).

**Supported dimensions** = the keys of `PINECONE_INDEXES`. At the time of writing the project's embedding model is
`openai/text-embedding-3-small` at **1536**, measured by a live probe when the user saved it and re-verified on every vector. The size is
a per-user setting (8–4096), so any other size is **refused with an actionable message** (`VECTOR_DIMENSION_UNSUPPORTED`) *before* any
embedding money is spent, in the connection form, at ingest and at re-index. Nothing is padded or truncated to fit. To support another
size, create another index of exactly that dimension and add it to `PINECONE_INDEXES`.

## 6. Schema (migration `20261027090000_pinecone_vector_store`)

Additive; **not applied to any persistent database by this work**. Review the SQL first.

* `DocumentChunk.pineconeIndexedAt TIMESTAMP(3) NULL`: set only after rag_agent saw the vectors in Pinecone.
* `DocumentChunk.embeddingDimension` was `GENERATED ALWAYS AS (vector_dims("embedding"))`. With Pinecone-only chunks the vector may be
  absent, so the expression is dropped (`DROP EXPRESSION` **keeps every stored value**). A `BEFORE INSERT OR UPDATE` trigger gives code
  from *before* the migration the same result as the generated column (it derives the dimension from the vector) and rejects an explicit
  dimension that disagrees with a present vector. Rows without a local vector must state their own, verified dimension.
* The `embedding` column, all vectors, the unique key (which includes the dimension) and the owner trigger are untouched.

Compatibility: with `VECTOR_STORE=pgvector` the new code works **before and after** this migration (it never touches the new column). Old
application code also works after it. `dual`/`pinecone` refuse to run on a database without it (`VECTOR_STORE_SCHEMA_NOT_READY`).
The migration is exercised on a throwaway database on top of legacy data (`tests/test_vector_migration.py`).

## 7. Deletion, retries, reindexing, cleanup

| Event | PostgreSQL | Vector store |
|---|---|---|
| Delete document | cascade | backend queues `delete-vectors {document}` in the same transaction → rag_agent lists `{documentId}:` and deletes (≤1000 ids/request) |
| Delete account | cascade | `delete-vectors {user, documentIds}` queued in the deletion hook; per-user: one namespace delete; the job **refuses to run while the account still exists** |
| New version ingested | old rows replaced in the commit | rag_agent returns the previous version's `(document, chunk)` pairs; the backend queues `delete-vectors {chunks}` **in the same transaction as READY** |
| Re-index staging | second chunk set (other identity) | staged vectors upserted; failure/stale/cancel deletes exactly them |
| Re-index activation | old identity's rows deleted | `DELETE … RETURNING` feeds `delete-vectors {chunks}` in the activation transaction |
| Cancel / failed re-index | staged rows purged | same `RETURNING` mechanism |

* Jobs use the existing queue (attempts 8, exponential backoff capped at 5 min, `Retry-After` honoured). Retryable store errors retry; a
  permanent one (credentials rejected) fails the job visibly and is not retried.
* **Reindex activation requires** (checked by the database, not by what rag_agent reported): every READY document has a staged set of
  exactly the target length **and** (`pinecone`) the Pinecone marker / (`dual`) both the local vector and the marker.
* Leftover vectors (crash between upsert and commit; a lost delete job) are harmless but can be removed:
  `python -m app.tools.reconcile_pinecone --owner USER_ID [--apply]` (per-user namespaces; dry run by default; skips documents that are
  `QUEUED`/`PROCESSING` because their vectors may be in flight; run while no ingest is running).

## 8. Existing-data backfill

`python -m app.tools.backfill_pinecone` (run from `rag_agent/`):

* **Dry run by default**: reports chunks to copy per identity, what will be skipped and why, and never builds a Pinecone client.
* `--apply` copies. It **reuses the vectors already in PostgreSQL** (no embedding-provider call), with ids `{documentId}:{existing chunk id}`,
  per document: upload, wait for visibility, check the visible count, **then** mark `pineconeIndexedAt`. A document that cannot be fully
  seen is reported and not marked. Nothing in PostgreSQL is deleted; the only column written is `pineconeIndexedAt`.
* Only `READY` documents' **current-version** chunks are copied. Skipped and reported: provider `unknown`/`mock`, sizes with no configured
  index, rows whose recorded dimension disagrees with the vector.
* Resumable: marked chunks are not selected again; `--state FILE --resume` additionally continues after the last document; `--owner`,
  `--limit-documents N` allow a small first batch. Stops after 3 consecutive failures. Exit code 1 if anything failed or is incomplete.
* Coverage check afterwards (should return 0 rows apart from reported skips):

```sql
SELECT d."id", count(*) AS missing
FROM "DocumentChunk" c JOIN "Document" d ON d."id" = c."documentId"
WHERE d."status" = 'READY' AND c."processingVersion" = d."processingVersion"
  AND c."embedding" IS NOT NULL AND c."pineconeIndexedAt" IS NULL
GROUP BY 1;
```

## 9. Pinecone index requirements

Create (by hand, in the console or CLI; this software never creates or alters an index): **serverless, dense, metric `cosine`,
dimension exactly equal to its `PINECONE_INDEXES` key** (1536 for `text-embedding-3-small`), in a region you accept for this data.
Retrieval treats the returned score as cosine similarity (the gate is `RETRIEVAL_MIN_SIMILARITY`, default 0.30), so another metric would
silently change behaviour. Verify read-only with `python -m app.tools.pinecone_check` (checks dimension, metric, dense type).

## 10. Rollout, verification and rollback

**Prerequisites (each is a separate, approved step):** back up the database; read both migration files; apply
`20261026090000_embedding_dimensions` (if not yet) and `20261027090000_pinecone_vector_store` to **staging** first with the project's
documented procedure (`DEPLOYMENT.md` §5); create the Pinecone index; put the key in rag_agent's `.env.local`.

1. **Deploy code with `VECTOR_STORE=pgvector`** (both services). Behaviour is unchanged. Run `pinecone_check`.
2. *(Optional)* live smoke test with your own throwaway index: `RUN_LIVE_PINECONE=1 .venv/bin/python -m pytest tests/test_pinecone_live.py`
   (disposable namespace, deletes what it created).
3. **Backfill dry run**, then `--apply --limit-documents 5`, then the rest. Run the coverage SQL (§8).
4. **Switch both services to `dual`** and restart them together; avoid uploads between the two restarts. Watch `vector_shadow_compare`:
   `jaccard`, `top1_same`, `same_order`, and `vector_shadow_failed`. Divergence is expected only for keyword-only hits and for chunks not yet
   backfilled; investigate anything else. Compare over a period and traffic volume you consider representative; no threshold is built in.
5. **Isolation check with two real test users** (A must never see B's chunks in chat or generation) in `dual`, then again in `pinecone`.
6. **Switch both services to `pinecone`** (keep `PINECONE_KEEP_POSTGRES_VECTORS=true`). Keep PostgreSQL vectors through the observation period.
7. Only when satisfied and rollback is no longer wanted: `PINECONE_KEEP_POSTGRES_VECTORS=false`. Dropping the `embedding` column or the
   pgvector data is **out of scope here** and would be a separate, approved migration.

**Rollback:** set `VECTOR_STORE=pgvector` in both services and restart. No data is deleted by this and nothing needs migrating back:
every chunk still has its PostgreSQL vector (`pgvector`/`dual` always; `pinecone` while `PINECONE_KEEP_POSTGRES_VECTORS=true`).
Chunks that only ever existed in Pinecone (opt-out was used) must be re-embedded (Settings → re-embed). Pinecone data may be left in place
or removed later by an operator.

## 11. Limits and cost (verify before relying: plans change)

From Pinecone's published pages when this was written: **Starter** is free with 1 project, up to 5 serverless indexes, **100 namespaces per
index**, 2 GB storage, 2 M write units and 1 M read units per month, AWS `us-east-1` only. **Standard** has a $50/month minimum, 20
indexes, 100 000 namespaces per index. Data-plane limits used by the code: ≤1000 vectors and ≤2 MB per upsert request (batches are sized
from the dimension, ≈61 vectors at 1536), ≤1000 ids per delete/fetch, id ≤512 chars, dimension ≤20 000.

* A 1536-d vector is ≈6 KB, so 2 GB holds on the order of 10⁵ vectors before overhead.
* **Per-user namespaces cap Starter at ~100 users per index**; use `shared` mode or a paid plan beyond that.
* Reads cost read units per query (+ one fetch per upload and per verification); uploads cost write units; the backfill and every
  re-index re-write all vectors.
* Whether Starter indexes are archived/paused when idle was not confirmed from current documentation (older sources describe it).
  Confirm before relying on the free tier for anything that must stay available.

## 12. What is and is not verified

Verified by automated tests (`rag_agent`: 905 passed + 1 opt-in live test skipped, of which 214 are new; `backend`: 692 integration tests passed, of which 44 are new, and 10 new unit tests): configuration validation; the
`VectorStore` contract across the in-memory fake, `PineconeStore` over a fake REST server (per-user and shared) and real PostgreSQL;
retries, rate limits, timeouts, permanent errors; visibility wait; dimension refusal; isolation and hostile/stale/orphan results;
ingest/reindex partial failures, cancellation and idempotent retry; delete/account/reindex job wiring; backfill dry run/apply/resume; the
migration on legacy data; pgvector-mode regression; dual-mode comparison and logging.

**Not verified: any real Pinecone behaviour.** The request/response shapes were taken from Pinecone's REST reference (upsert, query, delete,
list) and are reproduced by the fake. Specifically *unconfirmed against the real service*: the `GET /vectors/fetch` response shape, that
deleting a missing id/namespace returns success or 404 (both are tolerated), `describe_index_stats` fields, the eventual-consistency
delay, and cosine score semantics. Run `pinecone_check` and the opt-in live test against your own index before step 4.

## 13. Known limitations

* Pinecone's score for a keyword-only hit does not exist; such hits rank by keyword rank with similarity `0.0` and can never pass the
  similarity gate alone (dual-mode comparison shows this as expected divergence).
* The visibility check fetches the first and last vector of an upload and assumes in-order application per namespace; it is bounded and
  retryable, not a proof that every vector is queryable.
* `shared` namespace mode: `delete_user` removes the user's documents one by one (the reconcile tool does not support it).
* Orphan removal after a crash needs the operator tool; until then orphans only cost storage.
* No ANN trade-off applies to PostgreSQL (exact scan, D-022); Pinecone's ANN may rank slightly differently, which `dual` mode surfaces.
