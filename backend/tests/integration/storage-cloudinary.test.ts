import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { db } from "../../src/lib/db.js";
import { CloudinaryStorage } from "../../src/modules/documents/storage/cloudinary.js";
import { RoutedStorage } from "../../src/modules/documents/storage/router.js";
import { ingestHandlers } from "../../src/modules/jobs/ingest.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { CLOUDINARY_TEST_SECRET, FakeCloudinary, fakeConfig } from "../helpers/fake-cloudinary.js";
import { FakeRag } from "../helpers/fake-rag.js";
import { DOCX, form, PDF, textFile } from "../helpers/files.js";
import { client, setupAi, type TestApp } from "../helpers/http.js";
import { MemoryStorage } from "../helpers/memory-storage.js";
import { createUser } from "../helpers/users.js";
import { withEnv } from "../helpers/with-env.js";

/** The real app with STORAGE_DRIVER=cloudinary semantics: new uploads -> (fake) Cloudinary, `u/...` keys -> the old local store. */
function makeCloudApp(cfg: Parameters<typeof fakeConfig>[0] = {}) {
  const fake = new FakeCloudinary();
  const legacy = new MemoryStorage();
  const cld = new CloudinaryStorage(fakeConfig(cfg), { sdk: fake.sdk, fetch: fake.fetch });
  const storage = new RoutedStorage(cld, { u: legacy, cld });
  const rag = new FakeRag();
  return { app: createApp({ rag, storage }), rag, storage, fake, legacy } as unknown as TestApp & { fake: FakeCloudinary; legacy: MemoryStorage };
}

let t: ReturnType<typeof makeCloudApp>;
beforeEach(() => {
  t = makeCloudApp();
});

const upload = async (u: Parameters<typeof client>[1], files: Parameters<typeof form>[0]) => {
  const res = await client(t, u).raw("POST", "/api/documents", form(files));
  return { res, body: await res.clone().json() };
};
const pdf = (name = "paper.pdf", extra = randomUUID()) => ({ name, type: "application/pdf", data: Buffer.concat([PDF, Buffer.from(`\n% ${extra}`)]) });
const handlers = () => ingestHandlers(t.rag, t.storage);
const runNow = async () => {
  await db.job.updateMany({ where: { status: "PENDING" }, data: { runAt: new Date() } });
  await runDueJobs(handlers());
};

describe("uploads with the Cloudinary driver", () => {
  it("stores PDFs as private (raw + authenticated) objects under a cld/ key, with the original name kept in the database", async () => {
    const u = await createUser();
    const file = pdf("My Lecture Notes.pdf");
    const { res, body } = await upload(u, [file]);
    expect(res.status).toBe(200);
    expect(body.results[0]).toMatchObject({ ok: true });
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    expect(doc.storageKey).toMatch(/^cld\/[A-Za-z0-9_-]+\/[a-f0-9]{32}$/);
    expect(doc.name).toBe("My Lecture Notes.pdf");
    expect(doc.storageKey).not.toMatch(/^https?:/); // a stable key, never a URL

    expect(t.fake.store.size).toBe(1);
    const [publicId, stored] = [...t.fake.store][0]!;
    expect(publicId).toBe(`studyforge/documents/${u.id}/${doc.storageKey.split("/")[2]}`);
    expect(stored).toMatchObject({ resourceType: "raw", type: "authenticated" });
    expect(stored.data.equals(file.data)).toBe(true);
    expect(t.legacy.files.size).toBe(0);
    expect(await db.job.count({ where: { type: "ingest", payload: { path: ["documentId"], equals: doc.id } } })).toBe(1);

    const exposed = JSON.stringify(body) + (await (await client(t, u).get("/api/documents")).text());
    for (const secret of [doc.storageKey, publicId, CLOUDINARY_TEST_SECRET, "cloudinary"]) expect(exposed.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  it("also stores DOCX/TXT as raw authenticated objects", async () => {
    const u = await createUser();
    await upload(u, [{ name: "a.docx", type: "", data: DOCX }, { name: "b.txt", type: "text/plain", data: textFile(`hello ${randomUUID()}`) }]);
    expect(t.fake.store.size).toBe(2);
    for (const o of t.fake.store.values()) expect(o).toMatchObject({ resourceType: "raw", type: "authenticated" });
  });

  it("accepts a PDF at exactly the 25 MiB limit and rejects one byte more before contacting Cloudinary", async () => {
    const u = await createUser();
    const exact = Buffer.concat([PDF, Buffer.alloc(25 * 1024 * 1024 - PDF.length, 0x20)]);
    const over = Buffer.concat([exact, Buffer.from(" ")]);
    const a = await upload(u, [{ name: "exact.pdf", type: "application/pdf", data: exact }]);
    expect(a.body.results[0].ok).toBe(true);
    const calls = t.fake.calls.filter((c) => c.op === "upload").length;
    const b = await upload(u, [{ name: "over.pdf", type: "application/pdf", data: over }]);
    expect(b.body.results[0]).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(t.fake.calls.filter((c) => c.op === "upload")).toHaveLength(calls);
  });

  it("keeps the 10-files-per-request and per-user quota limits, enforced from the database before any Cloudinary call", async () => {
    const u = await createUser();
    const many = Array.from({ length: 11 }, (_, i) => pdf(`f${i}.pdf`));
    const tooMany = await upload(u, many);
    expect(tooMany.res.status).toBe(422);
    expect(tooMany.body.error.message).toMatch(/up to 10 files/);
    expect(t.fake.calls).toHaveLength(0);

    await db.document.create({ data: { ownerId: u.id, name: "huge.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: 499 * 1024 * 1024, sha256: randomUUID(), storageKey: `cld/${u.id}/${"b".repeat(32)}`, status: "READY" } });
    const { body } = await upload(u, [{ name: "two-mb.txt", type: "text/plain", data: Buffer.alloc(2 * 1024 * 1024, 98) }]);
    expect(body.results[0]).toMatchObject({ ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED" } });
    expect(t.fake.calls).toHaveLength(0);
  });

  it("honours the optional provider cap (CLOUDINARY_MAX_FILE_BYTES) with a clear message and no document", async () => {
    t = makeCloudApp({ maxFileBytes: 1024 });
    const u = await createUser();
    const { body } = await upload(u, [{ name: "big.pdf", type: "application/pdf", data: Buffer.concat([PDF, Buffer.alloc(4096, 0x20)]) }]);
    expect(body.results[0]).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(body.results[0].error.message).toMatch(/storage plan allows/);
    expect(await db.document.count({ where: { ownerId: u.id } })).toBe(0);
    expect(t.fake.store.size).toBe(0);
  });

  it.each([
    ["rate limit", { http_code: 420, message: "Rate Limit Exceeded. Limit 500 remaining 0" }],
    ["plan quota exhausted", { http_code: 400, message: "Storage quota exceeded for account demo-cloud" }],
    ["bad credentials", { http_code: 401, message: `Invalid api_key 123456789012345 ${CLOUDINARY_TEST_SECRET}` }],
  ])("returns a sanitized error and creates no document on provider %s", async (_n, fault) => {
    const u = await createUser();
    t.fake.fail("upload", fault);
    const { res, body } = await upload(u, [pdf()]);
    expect(res.status).toBe(200);
    expect(body.results[0]).toMatchObject({ ok: false, error: { code: "STORAGE_UNAVAILABLE" } });
    const text = JSON.stringify(body);
    for (const leak of ["Rate Limit Exceeded", "demo-cloud", "api_key", "123456789012345", CLOUDINARY_TEST_SECRET]) expect(text).not.toContain(leak);
    expect(await db.document.count({ where: { ownerId: u.id } })).toBe(0);
  });

  it("queues a cleanup job when an upload times out (the object may exist remotely)", async () => {
    const u = await createUser();
    t.fake.fail("upload", { http_code: 499, name: "TimeoutError", message: "Request Timeout" });
    const { body } = await upload(u, [pdf()]);
    expect(body.results[0].ok).toBe(false);
    const job = await db.job.findFirstOrThrow({ where: { type: "delete-object", payload: { path: ["key"], string_starts_with: `cld/${u.id}/` } } });
    expect(job.status).toBe("PENDING");
    await runNow(); // not-found at the provider is success: the retry is harmless
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUCCEEDED");
  });

  it("removes the freshly uploaded object when the database write fails", async () => {
    const u = await createUser();
    const file = pdf();
    // Same content already stored by a concurrent request => unique violation after the upload.
    const { createHash } = await import("node:crypto");
    const orig = db.document.findUnique;
    let first = true;
    (db.document as { findUnique: unknown }).findUnique = (...args: Parameters<typeof orig>) => {
      if (first) {
        first = false;
        return Promise.resolve(null); // the duplicate pre-check misses
      }
      return orig.apply(db.document, args);
    };
    try {
      await db.document.create({ data: { ownerId: u.id, name: "winner.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"), storageKey: `cld/${u.id}/${"c".repeat(32)}`, status: "READY" } });
      const { body } = await upload(u, [file]);
      expect(body.results[0]).toMatchObject({ ok: true, duplicate: true });
    } finally {
      (db.document as { findUnique: unknown }).findUnique = orig;
    }
    expect(t.fake.store.size).toBe(0); // the losing upload was cleaned up
  });
});

describe("authorized downloads", () => {
  it("serves bytes only through the backend, via a short-lived app token, never a Cloudinary URL", async () => {
    const u = await createUser();
    const file = pdf();
    await upload(u, [file]);
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    const res = await client(t, u).post(`/api/documents/${doc.id}/download-link`);
    expect(res.status).toBe(200);
    const link = await res.json();
    expect(link.url).toMatch(/^\/api\/documents\/download\/[^/]+$/);
    expect(link.url.toLowerCase()).not.toContain("cloudinary");
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000 + 1000);

    const file2 = await client(t).get(link.url); // the token, not a cookie, authorizes this request
    expect(file2.status).toBe(200);
    expect(Buffer.from(await file2.arrayBuffer()).equals(file.data)).toBe(true);
    expect(file2.headers.get("content-disposition")).toContain("attachment");
    expect(file2.headers.get("cache-control")).toBe("private, no-store");
    const allHeaders: string[] = [];
    file2.headers.forEach((v, k) => allHeaders.push(k, v));
    expect(allHeaders.join(" ")).not.toContain(CLOUDINARY_TEST_SECRET);
  });

  it("refuses other users, anonymous callers, forged tokens and tokens for deleted documents", async () => {
    const [owner, intruder] = [await createUser(), await createUser()];
    await upload(owner, [pdf()]);
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: owner.id } });
    expect((await client(t, intruder).post(`/api/documents/${doc.id}/download-link`)).status).toBe(404);
    expect((await client(t, intruder).get(`/api/documents/${doc.id}`)).status).toBe(404);
    expect((await client(t, intruder).delete(`/api/documents/${doc.id}`)).status).toBe(404);
    expect((await client(t).post(`/api/documents/${doc.id}/download-link`)).status).toBe(401);
    expect((await client(t).get("/api/documents/download/not-a-real-token")).status).toBe(404);
    expect(t.fake.calls.filter((c) => c.op === "download")).toHaveLength(0); // nothing was ever fetched from Cloudinary for them

    const link = await (await client(t, owner).post(`/api/documents/${doc.id}/download-link`)).json();
    expect((await client(t, owner).delete(`/api/documents/${doc.id}`)).status).toBe(200);
    expect((await client(t).get(link.url)).status).toBe(404);
  });

  it("reports provider trouble as a sanitized error, not the provider's response", async () => {
    const u = await createUser();
    await upload(u, [pdf()]);
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    const link = await (await client(t, u).post(`/api/documents/${doc.id}/download-link`)).json();
    t.fake.downloadStatus = 503;
    const res = await client(t).get(link.url);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.text()).not.toContain("error body that must never be surfaced");
  });
});

describe("ingestion reads through the storage abstraction", () => {
  it("fetches the PDF back from Cloudinary and hands the exact bytes to rag_agent", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const file = pdf();
    await upload(u, [file]);
    await runDueJobs(handlers());
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    expect(doc.status).toBe("READY");
    expect(t.rag.ingestCalls).toHaveLength(1);
    expect(t.rag.ingestCalls[0]!.bytes).toBe(file.data.length);
    expect(t.rag.ingestCalls[0]!.params).toMatchObject({ document_id: doc.id, owner_id: u.id, filename: "paper.pdf", mime_type: "application/pdf" });
    expect(t.fake.calls.some((c) => c.op === "download")).toBe(true);
  });

  it("retries transient Cloudinary read failures instead of failing the document", async () => {
    const u = await createUser();
    await setupAi(t, u);
    await upload(u, [pdf()]);
    t.fake.downloadStatus = 429;
    await runDueJobs(handlers());
    let doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    expect(doc.status).toBe("QUEUED");
    const job = await db.job.findFirstOrThrow({ where: { type: "ingest", payload: { path: ["documentId"], equals: doc.id } } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(t.rag.ingestCalls).toHaveLength(0);

    t.fake.downloadStatus = null;
    await runNow();
    doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    expect(doc.status).toBe("READY");
  });

  it("fails the document with a clear message when the remote object is gone", async () => {
    const u = await createUser();
    await setupAi(t, u);
    await upload(u, [pdf()]);
    t.fake.store.clear();
    await runDueJobs(handlers());
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    expect(doc).toMatchObject({ status: "FAILED", statusCode: "STORAGE_ERROR" });
    expect(doc.statusDetail).toMatch(/upload it again/);
  });
});

describe("deletion", () => {
  it("deletes the remote object through the delete-object job", async () => {
    const u = await createUser();
    await upload(u, [pdf()]);
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    expect((await client(t, u).delete(`/api/documents/${doc.id}`)).status).toBe(200);
    expect(t.fake.store.size).toBe(1); // asynchronous by design: the job removes it
    await runDueJobs(handlers());
    expect(t.fake.store.size).toBe(0);
    expect((await db.job.findFirstOrThrow({ where: { type: "delete-object", payload: { path: ["key"], equals: doc.storageKey } } })).status).toBe("SUCCEEDED");
    expect(t.fake.calls.find((c) => c.op === "destroy")!.options).toMatchObject({ resource_type: "raw", type: "authenticated" });
  });

  it("keeps the job pending (and the object) while Cloudinary is rate-limiting, then succeeds on retry", async () => {
    const u = await createUser();
    await upload(u, [pdf()]);
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    await client(t, u).delete(`/api/documents/${doc.id}`);
    t.fake.fail("destroy", { http_code: 420, message: "Rate Limit Exceeded" });
    await runDueJobs(handlers());
    const job = await db.job.findFirstOrThrow({ where: { type: "delete-object", payload: { path: ["key"], equals: doc.storageKey } } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(t.fake.store.size).toBe(1);
    await runNow();
    expect(t.fake.store.size).toBe(0);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("SUCCEEDED");
  });

  it("treats an already-missing remote object as deleted (retries are safe)", async () => {
    const u = await createUser();
    await upload(u, [pdf()]);
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    t.fake.store.clear();
    await client(t, u).delete(`/api/documents/${doc.id}`);
    await runDueJobs(handlers());
    expect((await db.job.findFirstOrThrow({ where: { type: "delete-object", payload: { path: ["key"], equals: doc.storageKey } } })).status).toBe("SUCCEEDED");
  });

  it("queues cleanup of every Cloudinary object when the account is deleted", async () => {
    const { getAuth } = await import("../../src/auth/auth.js");
    const { TEST_PASSWORD } = await import("../helpers/users.js");
    const u = await createUser();
    await upload(u, [pdf("a.pdf"), pdf("b.pdf")]);
    expect(t.fake.store.size).toBe(2);
    await getAuth().api.deleteUser({ headers: u.headers, body: { password: TEST_PASSWORD } });
    await runDueJobs(handlers());
    expect(t.fake.store.size).toBe(0);
  });
});

describe("existing local documents keep working after Cloudinary is enabled", () => {
  async function legacyDoc(ownerId: string, content = "%PDF-1.4 legacy local content") {
    const key = `u/${ownerId}/${randomUUID().replaceAll("-", "")}`;
    const data = Buffer.from(content);
    await t.legacy.put(key, data);
    return db.document.create({ data: { ownerId, name: "old.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: data.length, sha256: randomUUID(), storageKey: key, status: "READY" } });
  }

  it("downloads, re-ingests and deletes a u/ document without touching Cloudinary, and never rewrites its record", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const old = await legacyDoc(u.id);

    const link = await (await client(t, u).post(`/api/documents/${old.id}/download-link`)).json();
    const dl = await client(t).get(link.url);
    expect(await dl.text()).toBe("%PDF-1.4 legacy local content");

    expect((await client(t, u).post(`/api/documents/${old.id}/retry`)).status).toBe(200);
    await runDueJobs(handlers());
    expect(t.rag.ingestCalls).toHaveLength(1);
    expect((await db.document.findUniqueOrThrow({ where: { id: old.id } })).storageKey).toBe(old.storageKey);

    await client(t, u).delete(`/api/documents/${old.id}`);
    await runDueJobs(handlers());
    expect(t.legacy.files.has(old.storageKey)).toBe(false);
    expect(t.fake.calls).toHaveLength(0);
  });

  it("serves old local and new Cloudinary documents side by side", async () => {
    const u = await createUser();
    const old = await legacyDoc(u.id);
    await upload(u, [pdf()]);
    const docs = await db.document.findMany({ where: { ownerId: u.id } });
    expect(docs.map((d) => d.storageKey.split("/")[0]).sort()).toEqual(["cld", "u"]);
    for (const d of docs) expect((await client(t, u).post(`/api/documents/${d.id}/download-link`)).status).toBe(200);
    expect(old.storageKey.startsWith("u/")).toBe(true);
  });
});

describe("limits endpoint is unchanged by the storage driver", () => {
  it("still reports the application-wide 25 MiB / 10 files / 500 MiB limits", async () => {
    const u = await createUser();
    const lim = await (await client(t, u).get("/api/documents/limits")).json();
    expect(lim).toMatchObject({ maxFileBytes: 25 * 1024 * 1024, maxFilesPerUpload: 10, storageQuotaBytes: 500 * 1024 * 1024 });
    await withEnv({ USER_STORAGE_QUOTA_BYTES: "2048" }, async () => {
      expect((await (await client(t, u).get("/api/documents/limits")).json()).storageQuotaBytes).toBe(2048);
    });
  });
});
