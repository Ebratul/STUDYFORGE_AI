# Known limitations

Consolidated from all five parts. "Verified" always means an automated test or a recorded manual check actually ran; see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for the evidence and [SECURITY.md](SECURITY.md) for the risk list.

## AI and content quality
* **No live AI provider was ever called** (OpenAI, OpenRouter, Groq). All AI behaviour — chat, generation, analysis, plans — was verified with deterministic mock providers and mocked HTTP. Output quality, tone, native structured-output support on the larger schemas and prompt-injection resistance of real models are **unmeasured**. Please run a manual pass with a real key before relying on it.
* AI-generated questions and feedback are never guaranteed correct. "Source-quoted" only means a quote was found verbatim in your source. The "no invented numbers / no mastery claims" verification of feedback is a set of heuristics.
* Retrieval quality with real embeddings is unmeasured (`RETRIEVAL_MIN_SIMILARITY=0.30` was tuned with the mock embedder). One embedding model (1536-d) at a time; Groq cannot be the embedding provider.
* Only text-based PDFs (no OCR; scanned PDFs are reported `NEEDS_OCR`), no video. Parser isolation is process-level, not a sandbox.
* Document-only answers are verified before display, so they are not token-streamed.
* AI feedback/plan jobs spend the user's own provider quota (automatic by default once configured; switchable in settings). Costs are never estimated.
* Question generation is synchronous (SSE, ≤ 50 MCQs / 20 CQs per run), not a background batch job.

## AI connection
* The configuration form supports one connection per account (one key, one chat model, one embedding model). The provider is derived from the key (`sk-or-` → OpenRouter, the default; `gsk_` → Groq; other `sk-` → OpenAI) — there is no provider selector. Groq cannot serve embeddings.
* Embedding models must produce **1536-dimensional** vectors (the vector column is `vector(1536)`); other dimensions are rejected with the measured size. Changing the dimension would need a migration and a full re-index (not implemented).
* Validation makes two tiny paid requests with the user's key; model support is proven only by the provider answering, so a model that is valid but temporarily unavailable fails validation until it responds.
* Saving a new embedding model makes existing documents "stale" until re-embedded; a failed re-embed leaves that document FAILED (retry) rather than keeping it searchable under the old model.
* OpenRouter's behaviour was checked against its public documentation and mocked HTTP only; no real key was used.

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
* No break-glass/impersonation admin access exists (by design); administrators cannot read private content.
* E-mail: only Better Auth verification/recovery; no digest or reminder e-mail (reminders are in-app only). Email address cannot be changed.
* Scheduled purge of expired generation drafts is lazy (on that user's activity).
* S3 storage was exercised only against adobe/s3mock; Cloudflare R2/AWS/MinIO are untested. Real SMTP, Neon, Vercel and production TLS were not exercised.

## UI, accessibility and i18n
* English and Bangla are supported for the UI shell and the student-facing screens listed in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); untranslated strings fall back to English. Admin and some long-tail screens may remain English-only.
* Automated accessibility checks are axe (WCAG 2.0/2.1 A/AA rules) on the main pages in Chromium; no screen-reader or real-device testing. Dark mode received limited visual checking. Browser print/PDF output was not exercised.
* Only Chromium was automated.

## Process
* GitHub Actions has never run (the workflow is linted and its commands were run locally). Secret scanning is a heuristic over current files (no history scan).
* The old local database `studyforge` is obsolete; the app uses `studyforge_dev`.
