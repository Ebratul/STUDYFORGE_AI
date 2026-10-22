# StudyForge AI — Security

_Status: reviewed at the end of Part 5. This is an engineering description of the controls that exist and how each was checked — **not** a claim of perfect security. The application has not had an independent audit or penetration test. See "Remaining risks" and [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)._

## 1. Trust boundaries

```
Browser ──HTTPS──► frontend (Next.js)  ──private network──► backend (Hono) ──► PostgreSQL (+pgvector)
                    │ same-origin /api proxy                    │  └──► object storage (local disk | S3-compatible)
                    └ CSP nonce, no secrets                      └──Bearer RAG_AGENT_TOKEN──► rag_agent (FastAPI) ──► provider (user's own key)
```
* Only the frontend is public. The backend trusts `X-Forwarded-For` from the frontend/load balancer and must never be exposed directly. `rag_agent` is reachable only from the backend (bearer token, constant-time compare, refuses to start without a ≥ 24-char token).
* The backend is the single authority for identity, ownership, roles, quotas, release rules, grading and rankings. `rag_agent` and the browser are untrusted for decisions.

## 2. Controls by area (and how they were verified)

| Area | Control | Verified by |
|---|---|---|
| **Sessions / auth** | Better Auth: HttpOnly, SameSite=Lax (Secure in production) cookies; session + role + status re-read from the database on every request (nothing cached); password reset and password change revoke other sessions **server-side**; suspended accounts cannot sign in and are signed out immediately; per-endpoint auth rate limits; enumeration-resistant recovery responses | `auth.test.ts`, `hardening.test.ts`, `admin.test.ts`, E2E `public-and-auth.spec.ts` |
| **CSRF** | Every mutating `/api` route outside `/api/auth` requires a same-origin `Origin`/`Sec-Fetch-Site`; all 59 mutating routes were enumerated from the live app and checked | `hardening.test.ts` |
| **Authorization** | Ownership in every query (`ownerId`/`userId` in the WHERE clause); foreign ids are indistinguishable from missing ids (404); RBAC catalogue in `auth/permissions.ts` (USER / SUPPORT read-only / ADMIN); role checks go through one helper | `authorization.test.ts`, per-module cross-user tests (`questions`, `collections`, `generation`, `exams-*`, `groups-*`, `analysis-*`, `analytics-*`, `admin`) |
| **Input validation** | Strict Zod schemas (unknown keys rejected) on every body; size caps on bodies; centralised limits; no string-built SQL (all raw SQL is parameterised tagged templates — enforced by a source-scan test; one `Prisma.raw` over compile-time constants is allow-listed) | unit schema tests, `hardening.test.ts` |
| **Pagination / query limits** | Every list endpoint caps `pageSize` (≤ 50/100) and rejects larger values; per-user caps on documents, questions, collections, groups, invites, drafts | `hardening.test.ts` and module tests |
| **Provider keys (BYOK)** | AES-256-GCM with random IV, AAD = `userId:provider`, key ring for rotation; DB stores ciphertext only; responses/DTOs built from explicit column selects; masked `••••last4`; keys decrypted only inside the server function that calls `rag_agent`; `SecretStr` + central redaction in `rag_agent`; never in logs, errors, traces or the browser (DOM/storage scan) | `crypto.test.ts`, `credentials.test.ts`, E2E key scans, rag_agent canary-key tests |
| **Secrets in operations** | Environment validated at start with value-free messages; production refuses mock provider and non-https `APP_URL`; `.env*` ignored; secret scan (`backend/scripts/scan-secrets.sh`, CI) | `env.test.ts`, scan run in CI/locally |
| **Documents / uploads** | Extension allow-list + MIME consistency + magic bytes + size/count/quota caps; generated storage keys; private storage; signed, short-lived, user-bound download tokens (`attachment`, `nosniff`, sandbox CSP); parsers run in an isolated, time/memory-limited process; zip-bomb guards; video refused | `upload-validation.test.ts`, `documents.test.ts`, rag_agent extraction tests, E2E |
| **Retrieval isolation** | Backend sends only the caller's READY documents; every SQL path filters `ownerId`, document ids, current version, READY, embedding model; a DB trigger enforces chunk/document owner equality | `documents.test.ts`, rag_agent `test_retrieval.py` |
| **Prompt injection** | Untrusted text (documents, pasted text, exam stems/explanations) only inside a randomised delimited block in the **user** turn, neutralised; system prompts are constants with a canary and a leak filter; no tools; citations, names and scores come from the database, never the model; deterministic verification of every AI output (grounding, topics, numbers); the model cannot alter a score | rag_agent graph tests (hostile fixtures), `analysis-*` tests |
| **AI output** | Markdown rendered with `react-markdown` + `rehype-sanitize`, links `noopener noreferrer nofollow`, images never rendered | frontend unit + E2E |
| **Exams** | Answer key never in any pre-release payload (JSON scans, with positive controls); server-only grading from option ids (strict schemas reject scores); server clock for every deadline; grace window documented; row-locked idempotent finalization; immutable published versions and results (DB triggers); DB triggers also guard attempt limits and answer integrity | `exams-*.test.ts` incl. race tests on real Postgres locks |
| **Groups / invites** | 128-bit random invite codes stored only as SHA-256; generic `INVALID_INVITE`; per-user and per-IP attempt limits; group-row lock + capacity trigger; roles matrix; leaderboard only from finalized, released results of current members; anonymised names; opaque entry ids | `groups-*.test.ts` (12 parallel joins into 3 seats ⇒ exactly 3) |
| **Admin** | Least privilege (`SUPPORT` read-only; mutations ADMIN-only); 404 for non-holders; no endpoint reads other users' conversations, documents, credentials, answers or attempts (tested for an ADMIN session); no secret ever returned (allow-listed config, redacted job errors, truncated ids); all mutations audited; cannot change own role/status; last-ADMIN guard; suspension revokes sessions | `admin.test.ts`, `hardening.test.ts` |
| **Headers** | Frontend: CSP with per-request nonce, `frame-ancestors 'none'`, HSTS, `nosniff`, referrer policy, permissions policy; API: `no-store`, `nosniff`, request id on every response | E2E header checks, `hardening.test.ts`, `smoke.sh` |
| **Logging / privacy** | Structured JSON logs with request ids and error `category`; central redaction; document text, prompts, answers and keys are never logged; audit metadata allow-listed in the admin view; LangSmith off by default and, when enabled, hides inputs/outputs unless explicitly opted in | `redact.test.ts`, rag_agent tracing tests |
| **Dependencies** | `pnpm audit --prod` (backend, frontend) and `pip-audit` on the locked Python set run in CI (weekly too); last local run: no known vulnerabilities | CI `security` job |

## 3. Data handling
* **AI feedback / plans** are derived text keyed to a result; they contain no user identifiers and are generated from the caller's own data with the caller's own provider key. They can be regenerated and never change grading data.
* **Provider calls** carry only what the feature needs (see PART5_SPEC §3.2): no names, e-mail, ids, other users' data. Providers process that content under their own terms; users are told that usage is billed to their own account.
* **Metrics** are aggregate counters (no user ids, no content). **Audit** rows hold actor id, action, target type/id, hashed IP.
* **Deletion:** deleting an account cascades its rows and queues removal of stored files; deleting a group owner dissolves the group and its exams after notifying its members (see KNOWN_LIMITATIONS).
* **E-mail:** none is sent beyond Better Auth verification/recovery mail via the configured SMTP; no marketing or analytics mail exists.

## 4. Remaining risks (honest list)
1. **No independent security review or penetration test.** Everything above is developer-verified.
2. **No live provider was exercised.** Prompt-injection resistance was tested with scripted/mock models; a real model may behave differently. Deterministic output verification limits (but cannot eliminate) harmful or misleading text; the "no mastery claims" and "no invented numbers" checks are heuristics.
3. **`X-Forwarded-For` trust** — a mis-deployed backend reachable directly allows IP-spoofed rate-limit bypass. Keep it private.
4. **Rate limiting is Postgres-based** (fixed windows); adequate for modest traffic, not DDoS protection. Put a WAF/CDN in front for volumetric abuse.
5. **Parser isolation is process + rlimit + timeout, not seccomp/containers per file.** A parser zero-day could still affect the `rag_agent` process; run it with minimal privileges and a read-only filesystem where possible. The `rag_agent` DB role is not restricted in this repo (the contract documents the minimal grants).
6. **Secret scanning is heuristic and file-based** (no history scan). Use GitHub secret scanning / gitleaks on the real repository.
7. **Invite codes are bearer secrets.** Anyone with a valid code can join until it expires; direct (e-mail) invites to existing users store a single-use, user-bound code in that user's notification link.
8. **Clock dependence.** Exam deadlines depend on server clocks; multi-instance deployments need NTP.
9. **In-memory metrics** are per process and lost on crash (≤ `METRICS_FLUSH_SECONDS`).
10. **Browsers/devices:** only Chromium was automated; no real mobile devices.
11. **No break-glass admin access** exists; support cannot read user content (by design). Account recovery for lost provider keys is "re-enter the key".
12. Dev conveniences (mock provider, `ALLOW_MOCK_PROVIDER`) are refused in production by configuration validation but must still be left off.

## 5. Reporting
Security issues should be reported privately to the repository owner; do not open public issues containing exploit details or secrets.
