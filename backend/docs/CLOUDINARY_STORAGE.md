# Cloudinary storage

`STORAGE_DRIVER=cloudinary` stores **new** uploads in Cloudinary. `local` (default) and `s3` still work, and documents that already exist keep working.

## How it works

| Topic | Behaviour |
| --- | --- |
| Object type | Every file is uploaded as `resource_type: raw`, `type: authenticated`. The upload result is checked; an object that did not land as raw + authenticated is deleted and the upload fails. |
| Storage key | The database stores `cld/<userId>/<random>` in `Document.storageKey` (never a URL). The Cloudinary public id is `<CLOUDINARY_FOLDER>/<userId>/<random>`. The original file name stays in `Document.name`. |
| Routing | The key prefix selects the backend: `u/...` → local (or S3 when `STORAGE_DRIVER=s3`), `cld/...` → Cloudinary. No migration or data rewrite; switching drivers only changes where **new** files go. |
| Reads | The backend asks the Cloudinary API for a signed download (2-minute expiry, raw/authenticated) and fetches it server-side. The URL is never stored, logged or sent to a client. |
| Downloads | Unchanged: `POST /api/documents/:id/download-link` (session + ownership) returns a 60-second in-app token URL; `GET /api/documents/download/:token` re-checks ownership and streams the bytes with `attachment`. Users never see Cloudinary URLs. |
| Ingestion | The `ingest` job reads through the storage abstraction. Cloudinary rate limits/timeouts/5xx re-queue the job with backoff; a missing object fails the document with "upload it again". |
| Deletion | Unchanged and asynchronous: deleting a document removes the row immediately and queues a `delete-object` job. For Cloudinary it destroys the object and invalidates the CDN; "not found" counts as success, any other result throws so the job retries (up to 6 attempts, then the job is marked FAILED). |
| Failed uploads | If saving the row fails after the upload, the object is deleted; if that delete also fails (or the upload timed out), a `delete-object` job is queued. |
| Limits | Unchanged and enforced from the database *before* any Cloudinary call: 25 MiB per file (`MAX_UPLOAD_BYTES`), 10 files per request, 500 MiB per user (`USER_STORAGE_QUOTA_BYTES`). `CLOUDINARY_MAX_FILE_BYTES` adds an optional provider cap. |
| Errors | Provider failures are mapped to sanitized messages (rate limit, capacity, too large for the plan, unavailable). Provider text, URLs and keys are never returned or logged. |
| Health | `/admin/health` pings the Cloudinary Admin API (no upload per check). |

## 1. Create the account and credentials

1. Sign up at <https://cloudinary.com/users/register_free>.
2. Open **Console → Settings → API Keys** (or the Dashboard "Product Environment Credentials"). Copy the **Cloud name**, **API Key** and **API Secret**.
3. **Console → Settings → Security → "PDF and ZIP files delivery"**: enable it. Free accounts block PDF/ZIP delivery by default. See *Verifying private delivery* below for whether this is required for authenticated assets on your account.
4. Check your plan's file-size limit (Console → Settings → Account / Upload limits). The Free plan has historically allowed about **10 MB per raw file**; StudyForge's limit is 25 MiB. Set `CLOUDINARY_MAX_FILE_BYTES` to your plan's cap so users get a clear message instead of a provider error.
5. Do **not** enable paid add-ons for this; nothing here needs them. Consider an alert in **Settings → Account → Usage** before you reach your plan's limits.

## 2. Configure

In `backend/.env` (never in the frontend, git or logs):

```env
STORAGE_DRIVER="cloudinary"
CLOUDINARY_CLOUD_NAME="<cloud name>"
CLOUDINARY_API_KEY="<api key>"
CLOUDINARY_API_SECRET="<api secret>"
CLOUDINARY_FOLDER="studyforge/documents"      # optional
CLOUDINARY_MAX_FILE_BYTES="10485760"          # optional; your plan's per-file cap
LOCAL_STORAGE_DIR="./storage"                 # keep: existing local documents are still read from here
```

`STORAGE_DRIVER` must appear **once**. A duplicate line makes the file's meaning depend on parser order. With `cloudinary` selected and any credential missing, the backend refuses to start; it never falls back to local disk.

## 3. Switching drivers

* **local → cloudinary:** set the variables above and restart. Existing documents stay on disk and keep working (download, re-ingest, delete). New uploads go to Cloudinary. Keep `LOCAL_STORAGE_DIR` pointing at the same directory.
* **cloudinary → local:** set `STORAGE_DRIVER="local"` and **keep the three credentials** so existing `cld/...` documents remain readable and deletable. If the credentials are removed, those documents fail with "file storage service is not available" (no silent fallback).
* **s3 → cloudinary:** old `u/...` keys are then looked up in local storage, not S3; move the files first or keep `STORAGE_DRIVER=s3`. There is no automatic bucket-to-Cloudinary copy.
* **Do not change `CLOUDINARY_FOLDER`** while documents exist under the old one; the public id is derived from it, so they would no longer be found.

## 4. Manual test (≈5 minutes)

1. Start the backend and sign in. In the log, `backend.listening` shows `storage: "cloudinary"`.
2. Upload a small PDF in the UI. In **Cloudinary → Media Library** it appears under your folder as a *raw* asset with delivery type *authenticated*.
3. Configure an embedding model (Settings → AI connection) and watch the document reach READY: that proves the ingest job read the file back.
4. Download it from the document list: the file opens and the URL you saw started with `/api/documents/download/`.
5. Delete the document, then wait for the job (seconds): the asset disappears from the Media Library.
6. As another user, `POST /api/documents/<id>/download-link` for that document returns 404.

## Verifying private delivery (opt-in, uses your credentials)

Automated tests are fully mocked. To check your real account, run the one live test; it uploads ~100 bytes, reads them back, confirms that **unsigned** `raw/upload`, `raw/authenticated` and `raw/private` delivery URLs are refused, and deletes the object:

```bash
LIVE_CLOUDINARY_CLOUD_NAME=... LIVE_CLOUDINARY_API_KEY=... LIVE_CLOUDINARY_API_SECRET=... \
  DATABASE_URL=postgresql://studyforge:studyforge_dev_only@127.0.0.1:5440/studyforge_test DIRECT_URL= \
  pnpm vitest run --project integration tests/integration/storage-cloudinary-live.test.ts
```

Reads use the signed `…/raw/download` API endpoint. Whether the "PDF and ZIP files delivery" setting also governs that endpoint for authenticated assets is not stated in Cloudinary's documentation; if the live test or an ingest fails with a *storage service is not available* error (HTTP 401/403), enable that setting and retry.

## Privacy and limits

* Signed URLs are bearer links, and anyone holding one can use it until it expires. StudyForge keeps them server-side and short-lived and never shows them to users.
* Documents live on a third party's infrastructure under Cloudinary's terms; account-level access (Console users, API key holders) can read every file. Rotate the API secret in the Console if it leaks, then update `.env`.
* Free-plan allowances (storage, bandwidth, transformation credits, Admin API ~500 calls/hour, per-file size) are Cloudinary's and can change; StudyForge does not promise unlimited storage or downloads. Each ingest and download is a bandwidth read. When Cloudinary reports its limits exhausted, users see "The file storage service has reached its capacity" and nothing is saved.
* Per-user quotas are StudyForge's own (database `sizeBytes`), not Cloudinary's account totals.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Backend won't start: `CLOUDINARY_…: required when STORAGE_DRIVER=cloudinary` | Missing credential. Fix `.env`; there is deliberately no fallback. |
| `STORAGE_DRIVER: Invalid option` | Old `.env` copied from an earlier example: use exactly `local`, `s3` or `cloudinary`, once. |
| Upload says the file is larger than the storage plan allows | `CLOUDINARY_MAX_FILE_BYTES` exceeded, or Cloudinary rejected the size. Use a smaller file or a larger plan. |
| Upload/ingest: "file storage service is not available right now" | Credentials rejected (401) or delivery blocked (403). Re-check the three values and the *PDF and ZIP files delivery* setting. |
| "file storage service is busy" | Cloudinary rate limit (HTTP 420/429); the app retries ingestion and deletions automatically. |
| "has reached its capacity" | Plan storage/credits exhausted. Free space (delete documents) or upgrade the plan yourself. |
| Document FAILED with "upload it again" | The object is missing remotely (deleted in the Console, or `CLOUDINARY_FOLDER` changed). |
| Objects remain after deleting documents | The `delete-object` job is retrying or FAILED; see `/admin/health` queue counts. |
