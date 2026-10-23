# Known limitations

Consolidated from all five parts. "Verified" always means an automated test or a recorded manual check actually ran; see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for the evidence and [SECURITY.md](SECURITY.md) for the risk list.

## AI and content quality
* **No live AI provider was ever called** (OpenAI, OpenRouter, Groq, Gemini). All AI behaviour — chat, generation, analysis, plans — was verified with deterministic mock providers and mocked HTTP. Output quality, tone, native structured-output support on the larger schemas and prompt-injection resistance of real models are **unmeasured**. Please run a manual pass with a real key before relying on it.
* AI-generated questions and feedback are never guaranteed correct. "Source-quoted" only means a quote was found verbatim in your source. The "no invented numbers / no mastery claims" verification of feedback is a set of heuristics.
* Retrieval quality with real embeddings is unmeasured (`RETRIEVAL_MIN_SIMILARITY=0.30` was tuned with the mock embedder). One embedding model at a time; Groq cannot be the embedding provider.
* Only text-based PDFs (no OCR; scanned PDFs are reported `NEEDS_OCR`), no video. Parser isolation is process-level, not a sandbox.
* Document-only answers are verified before display, so they are not token-streamed.
* AI feedback/plan jobs spend the user's own provider quota (automatic by default once configured; switchable in settings). Costs are never estimated.
* Question generation is synchronous (SSE, ≤ 50 MCQs / 20 CQs per run), not a background batch job.

## AI connection
* The configuration form supports one connection per account (one key, one chat model, one embedding model). The provider is derived from the key (`sk-or-` → OpenRouter, the default; `gsk_` → Groq; `AIza` → Gemini; other `sk-` → OpenAI) — there is no provider selector. Groq cannot serve embeddings.
* **Embedding size:** any whole size from 8 to 4096 works if a live request shows the provider returns exactly that size (EMBEDDING_SETTINGS_SPEC). A size other than the model's own is requested only through the OpenAI-compatible `dimensions` parameter; providers that shorten vectors through other knobs (`output_dimension`, …) work at their own size only, and shortening is only sensible for models trained for it (the app cannot tell). The cap of 4096 is an application limit (pgvector stores up to 16 000). There is still no ANN index, so very large libraries rely on exact scans (D-022).
* **Re-indexing** re-embeds the stored chunk text (it does not re-parse files), one build per user, with the previous index serving meanwhile; it costs the user's provider quota for every chunk. A build waits while any document is still processing and fails with a clear message after about 8 hours of waiting. A document that finishes processing *under the old model after* the switch (its job started just before) shows as "stale" and needs the existing Re-embed button.
* Validation makes two tiny paid requests with the user's key; model support is proven only by the provider answering, so a model that is valid but temporarily unavailable fails validation until it responds.
* Saving a new embedding model (or size) starts a staged re-index: documents stay searchable with the old model until the new index is complete and verified, then switch together. The per-document Re-embed button still exists for documents that are stale for other reasons; a failed individual re-embed leaves that document FAILED (retry).
* OpenRouter's behaviour was checked against its public documentation and mocked HTTP only; no real key was used.

* **Gemini (Google AI Studio)** is reached only through its OpenAI-compatibility endpoint (`https://generativelanguage.googleapis.com/v1beta/openai`) and was verified against mocked HTTP and the public docs of 2026-10-23, never with a real key. Not documented by Google for that endpoint, so **unverified**: whether the OpenAI `dimensions` parameter shortens `gemini-embedding-*` vectors (the native size is 3072; a size the endpoint ignores is reported by the live validation as a mismatch, never saved), the `GET /models` shape (a leading `models/` is stripped), strict `json_schema` output (generation uses the prompt-JSON path), and the token-limit parameter name (`max_tokens` is sent). Only `AIza…` keys are recognised; other Google key formats fall back to OpenRouter and are rejected there.

## Exams and groups
* Deadlines depend on server clocks (NTP) and include a configurable latency grace (default 5 s) for saves/submits.
* Race-safety claims are limited to what the tests exercised on a single Postgres: concurrent starts/submits/expiry/joins. Multi-instance clock skew, a separate-process worker running for hours and large-group leaderboard load were not tested.
* Group exam authors cannot take their own group exam; deleting a group owner dissolves the group and its exams/results (the members are notified first).
* Ownership transfer is not implemented. Exams are MCQ-only (CQs are study content).
* Individual-exam authors see "Start" enabled before an exam opens (the server refuses with a clear message).
* Invite codes are bearer secrets; a direct invite to an existing user stores a single-use, user-bound code in that user's notification link.

## Platform
* Rate limiting is Postgres-based (fixed windows), not DDoS protection. The backend trusts `X-Forwarded-For` from the frontend proxy and must stay private.
* Metrics counters are in memory per process (≤ 30 s lost on crash); there is no Prometheus/OTel exporter and no external error tracker (Sentry etc.) is wired.
* Search uses ILIKE + pg_trgm, not Postgres full-text search. Question import and CSV export are not built; "used in N exams" is not shown on bank questions.
* **Pinecone (optional vector store) is verified only against a fake of its REST API and mocks**; no live request was ever made. Starter allows 100 namespaces per index (≈100 users with per-user namespaces), one fixed dimension per index (other embedding sizes are refused), and was not checked for idle-index archival. Keyword-only hits have no Pinecone score (similarity 0.0). Details: [VECTOR_STORE_SPEC.md](VECTOR_STORE_SPEC.md) §11–§13.
* No break-glass/impersonation admin access exists (by design); administrators cannot read private content.
* E-mail: only Better Auth verification/recovery; no digest or reminder e-mail (reminders are in-app only). Email address cannot be changed.
* Scheduled purge of expired generation drafts is lazy (on that user's activity).
* Cloudinary storage was tested only against a mocked SDK; no live Cloudinary request is part of the suite (opt-in `storage-cloudinary-live.test.ts`). The Free plan has historically capped raw files near 10 MB (below the 25 MiB application limit; set `CLOUDINARY_MAX_FILE_BYTES`), blocks PDF/ZIP delivery until enabled in the Console, and has its own storage/bandwidth/API-rate allowances. Whether the PDF/ZIP delivery switch also governs the signed API download used for reads is unverified. Switching `STORAGE_DRIVER` affects new uploads only: nothing is copied between local, S3 and Cloudinary, and changing `CLOUDINARY_FOLDER` strands existing objects. Remote deletion is asynchronous (retried job).
* S3 storage was exercised only against adobe/s3mock; Cloudflare R2/AWS/MinIO are untested. Real SMTP, Neon, Vercel and production TLS were not exercised.

## UI, accessibility and i18n
* English and Bangla are supported for the UI shell and the student-facing screens listed in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); untranslated strings fall back to English. Admin and some long-tail screens may remain English-only.
* Automated accessibility checks are axe (WCAG 2.0/2.1 A/AA rules) on the main pages in Chromium; no screen-reader or real-device testing. Dark mode received limited visual checking. Browser print/PDF output was not exercised.
* Only Chromium was automated.

## Process
* GitHub Actions has never run (the workflow is linted and its commands were run locally). Secret scanning is a heuristic over current files (no history scan).
* The old local database `studyforge` is obsolete; the app uses `studyforge_dev`.
