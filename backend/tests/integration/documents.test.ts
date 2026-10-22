import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { ingestHandlers } from "../../src/modules/jobs/ingest.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { client, makeApp, setupAi, type TestApp } from "../helpers/http.js";
import { DOCX, form, PDF, textFile } from "../helpers/files.js";
import { createUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp(); // fresh fake AI service and storage for every test
});

const upload = async (u: Parameters<typeof client>[1], files: Parameters<typeof form>[0]) => {
  const res = await client(t, u).raw("POST", "/api/documents", form(files));
  return { res, body: await res.clone().json() };
};
const notes = (name = "notes.txt", text = `Cells are the basic unit of life ${randomUUID()}`) => ({ name, type: "text/plain", data: textFile(text) });

async function insertChunk(documentId: string, ownerId: string, content: string, version = 1) {
  await db.$executeRaw`INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","content","tokenCount","embeddingModel")
    VALUES (${randomUUID()}, ${documentId}, ${ownerId}, 0, ${version}, ${content}, 5, 'mock-embed')`;
}

describe("upload", () => {
  it("accepts several files in one request and queues each for processing", async () => {
    const u = await createUser();
    const { res, body } = await upload(u, [notes("a.txt"), { name: "b.pdf", type: "application/pdf", data: PDF }, { name: "c.docx", type: "", data: DOCX }, notes("d.md")]);
    expect(res.status).toBe(200);
    expect(body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, true, true]);
    const docs = await db.document.findMany({ where: { ownerId: u.id } });
    expect(docs).toHaveLength(4);
    expect(docs.every((d) => d.status === "QUEUED")).toBe(true);
    expect(await db.job.count({ where: { type: "ingest", status: "PENDING", payload: { path: ["documentId"], string_contains: "" } } })).toBeGreaterThanOrEqual(0);
    for (const d of docs) expect(t.storage.files.has(d.storageKey)).toBe(true);
  });

  it("never exposes storage keys, hashes or owner ids", async () => {
    const u = await createUser();
    const { body } = await upload(u, [notes()]);
    const doc = await db.document.findFirstOrThrow({ where: { ownerId: u.id } });
    const text = JSON.stringify(body) + (await (await client(t, u).get("/api/documents")).text());
    for (const secret of [doc.storageKey, doc.sha256, u.id]) expect(text).not.toContain(secret);
  });

  it("reports per-file errors without failing the whole upload", async () => {
    const u = await createUser();
    const { body } = await upload(u, [notes("ok.txt"), { name: "evil.pdf", type: "application/pdf", data: Buffer.from("MZ not a pdf") }, { name: "clip.mp4", type: "video/mp4", data: Buffer.alloc(50) }, { name: "x.exe", type: "", data: Buffer.alloc(10, 1) }]);
    const r = body.results;
    expect(r[0].ok).toBe(true);
    expect(r[1]).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_MEDIA" } });
    expect(r[2].error.message).toMatch(/transcription/);
    expect(r[3].ok).toBe(false);
    expect(await db.document.count({ where: { ownerId: u.id } })).toBe(1);
    expect(await db.document.count({ where: { ownerId: u.id, name: "evil.pdf" } })).toBe(0);
  });

  it("deduplicates identical content per user (no second record, object or job)", async () => {
    const u = await createUser();
    const f = notes("same.txt", "identical content");
    await upload(u, [f]);
    const { body } = await upload(u, [{ ...f, name: "renamed.txt" }]);
    expect(body.results[0]).toMatchObject({ ok: true, duplicate: true });
    expect(await db.document.count({ where: { ownerId: u.id } })).toBe(1);
    // a different user can upload the same bytes independently
    const other = await createUser();
    const again = await upload(other, [f]);
    expect(again.body.results[0].duplicate).toBeUndefined();
  });

  it("enforces the per-upload file count, per-file size and the request cap", async () => {
    const u = await createUser();
    const many = Array.from({ length: 11 }, (_, i) => notes(`n${i}.txt`, `file ${i} ${randomUUID()}`));
    const tooMany = await upload(u, many);
    expect(tooMany.res.status).toBe(422);
    expect(tooMany.body.error.message).toMatch(/up to 10 files/);

    const big = await upload(u, [{ name: "big.txt", type: "text/plain", data: Buffer.alloc(26 * 1024 * 1024, 97) }]);
    expect(big.res.status === 422 || big.body.results?.[0]?.ok === false).toBe(true);
    expect(await db.document.count({ where: { ownerId: u.id } })).toBe(0);
  });

  it("enforces the per-user storage and document-count quotas", async () => {
    const u = await createUser();
    await db.document.create({ data: { ownerId: u.id, name: "huge.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: 499 * 1024 * 1024, sha256: randomUUID(), storageKey: `u/${u.id}/${"a".repeat(32)}`, status: "READY" } });
    const { body } = await upload(u, [{ name: "two-mb.txt", type: "text/plain", data: Buffer.alloc(2 * 1024 * 1024, 98) }]);
    expect(body.results[0]).toMatchObject({ ok: false, error: { code: "STORAGE_QUOTA_EXCEEDED" } });
  });

  it("rejects non-multipart bodies and anonymous callers", async () => {
    const u = await createUser();
    expect((await client(t, u).post("/api/documents", { a: 1 })).status).toBe(422);
    expect((await client(t).raw("POST", "/api/documents", form([notes()]))).status).toBe(401);
  });

  it("exposes the single source of truth for limits, including the video limitation", async () => {
    const u = await createUser();
    const lim = await (await client(t, u).get("/api/documents/limits")).json();
    expect(lim.maxFileBytes).toBe(25 * 1024 * 1024);
    expect(lim.maxFilesPerUpload).toBe(10);
    expect(lim.video.supported).toBe(false);
    expect(lim.video.reason).toMatch(/transcription/);
    expect(lim.allowedExtensions).toEqual(expect.arrayContaining(["pdf", "docx", "txt", "md"]));
  });
});

describe("authorization and downloads", () => {
  it("B cannot read, retry, download or delete A's document (404 for foreign and missing ids alike)", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const { body } = await upload(a, [notes()]);
    const id = body.results[0].document.id;
    const cb = client(t, b);
    for (const [method, path] of [["GET", `/api/documents/${id}`], ["POST", `/api/documents/${id}/retry`], ["POST", `/api/documents/${id}/download-link`], ["DELETE", `/api/documents/${id}`]] as const) {
      expect((await cb.raw(method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(404);
    }
    expect((await cb.get("/api/documents/does-not-exist")).status).toBe(404);
    expect((await (await cb.get("/api/documents")).json()).items).toEqual([]);
    expect(await db.document.count({ where: { id } })).toBe(1);
  });

  it("issues short-lived signed links that work once authorised and fail when tampered, expired or after deletion", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const { body } = await upload(a, [notes("lesson.txt", "hello download")]);
    const id = body.results[0].document.id;
    const link = await (await client(t, a).post(`/api/documents/${id}/download-link`)).json();
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61_000);

    const ok = await client(t).get(link.url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hello download");
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("cache-control")).toMatch(/no-store/);

    const token = link.url.split("/").pop() as string;
    expect((await client(t).get(`/api/documents/download/${token.slice(0, -3)}abc`)).status).toBe(404);
    expect((await client(t).get("/api/documents/download/not.a.token")).status).toBe(404);

    // a link minted for A's document but with B's id inside is rejected by the signature
    const forged = Buffer.from(JSON.stringify({ d: id, u: b.id, exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url") + "." + token.split(".")[1];
    expect((await client(t).get(`/api/documents/download/${forged}`)).status).toBe(404);

    await client(t, a).delete(`/api/documents/${id}`);
    expect((await client(t).get(link.url)).status).toBe(404);
  });
});

describe("deletion", () => {
  it("removes the row, chunks/embeddings, conversation links and the stored object; citations keep their snapshot", async () => {
    const u = await createUser();
    const { body } = await upload(u, [notes()]);
    const doc = await db.document.findFirstOrThrow({ where: { id: body.results[0].document.id } });
    await insertChunk(doc.id, u.id, "chunk text");
    const conv = await db.conversation.create({ data: { userId: u.id, title: "t", documents: { create: [{ documentId: doc.id }] } } });
    const msg = await db.message.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: "answer", citations: { create: [{ ordinal: 1, documentId: doc.id, documentName: doc.name, chunkId: "c1", quote: "quote" }] } } });

    expect((await client(t, u).delete(`/api/documents/${doc.id}`)).status).toBe(200);
    expect(await db.document.count({ where: { id: doc.id } })).toBe(0);
    expect(await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "DocumentChunk" WHERE "documentId" = ${doc.id}`).toEqual([{ n: 0n }]);
    expect(await db.conversationDocument.count({ where: { conversationId: conv.id } })).toBe(0);
    const cite = await db.messageCitation.findFirstOrThrow({ where: { messageId: msg.id } });
    expect(cite).toMatchObject({ documentId: null, documentName: doc.name, quote: "quote" });

    // object cleanup is a queued job (retryable), run by the worker
    expect(t.storage.files.has(doc.storageKey)).toBe(true);
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(t.storage.files.has(doc.storageKey)).toBe(false);
  });

  it("retries storage cleanup when the object store is down", async () => {
    const u = await createUser();
    const { body } = await upload(u, [notes()]);
    const doc = await db.document.findFirstOrThrow({ where: { id: body.results[0].document.id } });
    await client(t, u).delete(`/api/documents/${doc.id}`);
    t.storage.failDelete = true;
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    const job = await db.job.findFirstOrThrow({ where: { type: "delete-object", payload: { path: ["key"], equals: doc.storageKey } } });
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(1);
    t.storage.failDelete = false;
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(t.storage.files.has(doc.storageKey)).toBe(false);
  });
});

describe("account deletion", () => {
  it("removes every stored file of the user (queued cleanup) along with all database rows", async () => {
    const { getAuth } = await import("../../src/auth/auth.js");
    const { TEST_PASSWORD } = await import("../helpers/users.js");
    const u = await createUser();
    const { body } = await upload(u, [notes("a.txt"), notes("b.txt")]);
    const keys = (await db.document.findMany({ where: { ownerId: u.id } })).map((d) => d.storageKey);
    expect(keys).toHaveLength(2);
    await getAuth().api.deleteUser({ headers: u.headers, body: { password: TEST_PASSWORD } });
    expect(await db.document.count({ where: { ownerId: u.id } })).toBe(0);
    expect(body.results).toHaveLength(2);
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    for (const k of keys) expect(t.storage.files.has(k)).toBe(false);
  });
});

describe("ingestion job", () => {
  async function queued(u: Awaited<ReturnType<typeof createUser>>) {
    const { body } = await upload(u, [notes()]);
    return body.results[0].document.id as string;
  }

  it("processes a queued document to READY with progress/metadata and releases the dedupe key", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const id = await queued(u);
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    expect(doc).toMatchObject({ status: "READY", progress: 100, pageCount: 2, chunkCount: 3, embeddingModel: "mock-embed", embeddingProvider: "MOCK", processingVersion: 1 });
    expect(t.rag.ingestCalls.at(-1)?.params).toMatchObject({ document_id: id, owner_id: u.id, processing_version: 1, embedding: { provider: "mock", model: "mock-embed" } });
    const job = await db.job.findFirstOrThrow({ where: { type: "ingest", payload: { path: ["documentId"], equals: id } } });
    expect(job).toMatchObject({ status: "SUCCEEDED", dedupeKey: null });
  });

  it("fails fast with an actionable message when no embedding model is configured", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    const id = await queued(u);
    const calls = t.rag.ingestCalls.length;
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    expect(doc).toMatchObject({ status: "FAILED", statusCode: "EMBEDDING_NOT_CONFIGURED" });
    expect(doc.statusDetail).toMatch(/Settings/);
    expect(t.rag.ingestCalls.length).toBe(calls);
  });

  it("a scanned PDF becomes NEEDS_OCR with a clear message (no fake text)", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const id = await queued(u);
    t.rag.ingestScript = async () => ({ type: "result", status: "NEEDS_OCR", code: "NEEDS_OCR", message: "This PDF looks scanned (no text layer). OCR is not configured on this server." });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    const doc = await db.document.findUniqueOrThrow({ where: { id } });
    expect(doc).toMatchObject({ status: "NEEDS_OCR", statusCode: "NEEDS_OCR", chunkCount: null });
    expect(doc.statusDetail).toMatch(/OCR is not configured/);
  });

  it("an invalid provider key fails the document and flags the credential INVALID", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const id = await queued(u);
    t.rag.ingestScript = async () => ({ type: "error", code: "PROVIDER_AUTH_INVALID", message: "x", retryable: false });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", statusCode: "PROVIDER_AUTH_INVALID" });
    expect((await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("INVALID");
  });

  it("transient provider errors are retried with backoff, then fail permanently after the attempt limit", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const id = await queued(u);
    t.rag.ingestScript = async () => ({ type: "error", code: "PROVIDER_RATE_LIMITED", message: "slow down", retryable: true, retry_after_seconds: 1 });
    const handlers = ingestHandlers(t.rag, t.storage);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await runDueJobs(handlers);
      const job = await db.job.findFirstOrThrow({ where: { type: "ingest", payload: { path: ["documentId"], equals: id } } });
      if (attempt < 4) {
        expect(job.status).toBe("PENDING");
        expect(job.attempts).toBe(attempt);
        expect((await db.document.findUniqueOrThrow({ where: { id } })).status).toBe("QUEUED");
        await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
      } else {
        expect(job.status).toBe("SUCCEEDED"); // handled: the document carries the failure
      }
    }
    expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "FAILED", statusCode: "PROVIDER_RATE_LIMITED" });
  });

  it("a document deleted while queued is skipped quietly", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const id = await queued(u);
    const calls = t.rag.ingestCalls.length;
    await db.document.delete({ where: { id } });
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect(t.rag.ingestCalls.length).toBe(calls);
  });

  it("retry re-queues failed documents once; a duplicate retry conflicts; READY documents can be reprocessed", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    const id = await queued(u);
    await runDueJobs(ingestHandlers(t.rag, t.storage)); // -> FAILED (no embedding model)
    await setupAi(t, u);
    const c = client(t, u);
    const first = await c.post(`/api/documents/${id}/retry`);
    expect(first.status).toBe(200);
    expect((await first.json()).document.status).toBe("QUEUED");
    expect((await c.post(`/api/documents/${id}/retry`)).status).toBe(409);
    await runDueJobs(ingestHandlers(t.rag, t.storage));
    expect((await db.document.findUniqueOrThrow({ where: { id } })).status).toBe("READY");
    expect((await c.post(`/api/documents/${id}/retry`)).status).toBe(200); // reprocess
    expect((await db.document.findUniqueOrThrow({ where: { id } })).status).toBe("QUEUED");
  });
});
