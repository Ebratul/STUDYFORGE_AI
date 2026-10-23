import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { requireAuth, sameOriginGuard } from "../../http/middleware.js";
import type { AppEnv } from "../../http/context.js";
import { parseWith } from "../../http/body.js";
import { getLimits } from "./limits.js";
import { createDownloadLink, deleteDocument, getDocument, getUsage, listDocuments, openDownload, reembedDocuments, retryDocument, uploadDocuments, type UploadFile } from "./service.js";
import type { Storage } from "./storage/types.js";

const idSchema = z.string().min(1).max(64);

/** Reads the request body with a hard byte cap (never trusts Content-Length alone). */
async function readCapped(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new AppError("VALIDATION", "That upload is too large.", { maxRequestBytes: maxBytes });
  if (!req.body) throw new AppError("VALIDATION", "No files were uploaded.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError("VALIDATION", "That upload is too large.", { maxRequestBytes: maxBytes });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function documentRoutes(storage: Storage) {
  const r = new Hono<AppEnv>();

  // Signed, short-lived download links work without the session cookie (so the URL can be used by a plain <a download>),
  // but they are bound to a user+document, expire quickly, and ownership is re-verified when used.
  r.get("/download/:token", async (c) => {
    const { bytes, name, mimeType } = await openDownload(storage, c.req.param("token"));
    const safe = name.replace(/["\\\r\n]/g, "_");
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": mimeType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });

  r.use("*", requireAuth);

  r.get("/limits", async (c) => {
    const user = c.get("user");
    const [usage] = await Promise.all([getUsage(user)]);
    return c.json({ ...getLimits(), usedBytes: usage.usedBytes, documentCount: usage.count });
  });

  r.get("/", async (c) => c.json({ items: await listDocuments(c.get("user")) }));

  r.post("/", sameOriginGuard, async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `upload:${user.id}`, limit: 20, windowSec: 60 });
    const limits = getLimits();
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw new AppError("VALIDATION", "Upload files as multipart/form-data.");
    const body = await readCapped(c.req.raw, limits.maxRequestBytes);
    let form: FormData;
    try {
      form = await new Response(Buffer.from(body), { headers: { "content-type": contentType } }).formData();
    } catch {
      throw new AppError("VALIDATION", "That upload could not be read.");
    }
    const files: UploadFile[] = [];
    for (const value of form.getAll("files")) {
      if (typeof value === "string") continue;
      files.push({ name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
    }
    return c.json({ results: await uploadDocuments(storage, user, files) });
  });

  // Bulk re-embed after the embedding model changed. Registered before the `/:id` routes; owner-scoped, idempotent, bounded, rate limited.
  r.post("/reembed", sameOriginGuard, async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `doc-reembed:${user.id}`, limit: 5, windowSec: 60 });
    return c.json(await reembedDocuments(user));
  });

  r.get("/:id", async (c) => c.json({ document: await getDocument(c.get("user"), parseWith(idSchema, c.req.param("id"))) }));

  r.post("/:id/retry", sameOriginGuard, async (c) => c.json({ document: await retryDocument(c.get("user"), parseWith(idSchema, c.req.param("id"))) }));

  r.post("/:id/download-link", sameOriginGuard, async (c) => {
    const user = c.get("user");
    await enforceRateLimit({ key: `dl:${user.id}`, limit: 60, windowSec: 60 });
    return c.json(await createDownloadLink(storage, user, parseWith(idSchema, c.req.param("id"))));
  });

  r.delete("/:id", sameOriginGuard, async (c) => {
    await deleteDocument(storage, c.get("user"), parseWith(idSchema, c.req.param("id")));
    return c.json({ ok: true });
  });

  return r;
}
