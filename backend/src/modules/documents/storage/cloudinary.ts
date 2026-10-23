import cloudinary from "cloudinary";
import { logger } from "../../../lib/logger.js";
import { CLOUDINARY_KEY_PATTERN, randomKey, StorageError, type Storage } from "./types.js";

/**
 * Private documents on Cloudinary.
 *
 * - Every object is uploaded as `resource_type: raw` + `type: authenticated`: the original is only reachable through a signed
 *   request, and never as a derived/transformed image (which is what makes `private` weaker for PDFs).
 * - The database stores the stable key `cld/<userId>/<random>`; the Cloudinary public id is `<folder>/<userId>/<random>`.
 *   No URL is ever stored or returned to a client: reads are made by this server with a short-lived signed API URL, and
 *   downloads reach users only through the existing authorized `/api/documents/download/:token` route.
 * - Credentials never leave this class; errors are mapped to sanitized StorageError values (provider messages can echo parts of
 *   the API key, so they are not logged or surfaced).
 */

type UploadResult = { public_id?: string; resource_type?: string; type?: string; bytes?: number };

/** The slice of the Cloudinary v2 SDK this adapter uses (injectable so tests never touch the network). */
export interface CloudinarySdk {
  uploader: {
    upload_stream(options: Record<string, unknown>, callback: (error: unknown, result?: UploadResult) => void): { end(data: Buffer): void };
    destroy(publicId: string, options: Record<string, unknown>): Promise<{ result?: string }>;
  };
  api: { ping(options: Record<string, unknown>): Promise<{ status?: string }> };
  utils: { private_download_url(publicId: string, format: string, options: Record<string, unknown>): string };
}

export type CloudinaryConfig = {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Cloudinary folder prefix, e.g. `studyforge/documents`. Changing it later strands objects uploaded under the old one. */
  folder: string;
  /** Optional per-file cap of the Cloudinary plan (the Free plan allows ~10 MB for raw files). Unset = let Cloudinary decide. */
  maxFileBytes?: number;
  /** Hard cap on bytes read back (defence in depth; the application-wide upload limit). */
  maxReadBytes: number;
  timeoutMs?: number;
};

const RESOURCE_TYPE = "raw";
const DELIVERY_TYPE = "authenticated";
const NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

const MESSAGES = {
  NOT_FOUND: "The stored file could not be found.",
  RATE_LIMITED: "The file storage service is busy. Please try again in a few minutes.",
  PROVIDER_QUOTA: "The file storage service has reached its capacity. Please contact the administrator.",
  FILE_TOO_LARGE: "This file is larger than the file storage service allows.",
  UNAVAILABLE: "The file storage service is temporarily unavailable. Please try again shortly.",
  NOT_CONFIGURED: "The file storage service is not available right now. Please contact the administrator.",
  REJECTED: "The file storage service could not accept this file.",
} as const;

/** Classifies SDK errors ({message, http_code}), fetch failures and HTTP statuses without keeping any provider text. */
export function toStorageError(err: unknown, httpStatus?: number): StorageError {
  if (err instanceof StorageError) return err;
  const e = (err ?? {}) as { http_code?: number; message?: unknown; code?: unknown; name?: unknown; cause?: { code?: unknown } };
  const status = httpStatus ?? (typeof e.http_code === "number" ? e.http_code : undefined);
  const text = typeof e.message === "string" ? e.message : "";
  const netCode = typeof e.code === "string" ? e.code : typeof e.cause?.code === "string" ? e.cause.code : "";
  const make = (code: keyof typeof MESSAGES) => new StorageError(code, MESSAGES[code]);

  if (status === 404) return make("NOT_FOUND");
  if (status === 420 || status === 429) return make("RATE_LIMITED");
  if (status === 401) return make("NOT_CONFIGURED");
  if (status !== undefined && status >= 500) return make("UNAVAILABLE");
  if (status === 499 || e.name === "TimeoutError" || e.name === "AbortError" || NETWORK_CODES.has(netCode)) return make("UNAVAILABLE");
  if (/file size too large|maximum is \d+|exceeds? the maximum/i.test(text)) return make("FILE_TOO_LARGE");
  if (/quota|usage limit|storage limit|plan limit|out of credits|credits? (limit|exceeded)/i.test(text)) return make("PROVIDER_QUOTA");
  // 403 includes "blocked for delivery" (PDF/ZIP delivery disabled on Free accounts) and ACL errors: an account-setup problem.
  if (status === 403) return make("NOT_CONFIGURED");
  if (status === undefined && !text) return make("UNAVAILABLE");
  return make("REJECTED");
}

export class CloudinaryStorage implements Storage {
  readonly driver = "cloudinary" as const;
  private sdk: CloudinarySdk;
  private fetchFn: typeof fetch;
  private folder: string;
  private timeoutMs: number;

  constructor(
    private cfg: CloudinaryConfig,
    deps: { sdk?: CloudinarySdk; fetch?: typeof fetch } = {},
  ) {
    this.sdk = deps.sdk ?? (cloudinary.v2 as unknown as CloudinarySdk);
    this.fetchFn = deps.fetch ?? fetch;
    this.folder = cfg.folder.replace(/^\/+|\/+$/g, "");
    this.timeoutMs = cfg.timeoutMs ?? 120_000;
    if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) throw new StorageError("NOT_CONFIGURED", "Cloudinary credentials are not configured.");
  }

  /** Per-call credentials: the SDK's global config is never touched, so nothing else in the process can read or change it. */
  private auth() {
    return { cloud_name: this.cfg.cloudName, api_key: this.cfg.apiKey, api_secret: this.cfg.apiSecret, secure: true };
  }

  newKey(userId: string) {
    return randomKey("cld", userId);
  }

  private publicId(key: string): string {
    if (!CLOUDINARY_KEY_PATTERN.test(key)) throw new Error("invalid storage key");
    const [, userId, id] = key.split("/");
    return `${this.folder}/${userId}/${id}`;
  }

  async put(key: string, data: Uint8Array, _contentType: string) {
    const publicId = this.publicId(key);
    if (this.cfg.maxFileBytes && data.byteLength > this.cfg.maxFileBytes) throw new StorageError("FILE_TOO_LARGE", MESSAGES.FILE_TOO_LARGE);

    let result: UploadResult;
    try {
      result = await new Promise<UploadResult>((resolve, reject) => {
        const stream = this.sdk.uploader.upload_stream(
          { ...this.auth(), public_id: publicId, resource_type: RESOURCE_TYPE, type: DELIVERY_TYPE, overwrite: false, unique_filename: false, use_filename: false, timeout: this.timeoutMs },
          (error, res) => (error || !res ? reject(error ?? new Error("empty response")) : resolve(res)),
        );
        stream.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      });
    } catch (err) {
      const mapped = toStorageError(err);
      logger.warn("storage.cloudinary.put_failed", { code: mapped.code, httpCode: (err as { http_code?: number })?.http_code });
      throw mapped;
    }

    // Never trust that the object landed private: a mismatch means it could be reachable some other way, so remove it.
    if (result.public_id !== publicId || result.resource_type !== RESOURCE_TYPE || result.type !== DELIVERY_TYPE || result.bytes !== data.byteLength) {
      logger.error("storage.cloudinary.unexpected_upload_result", { resourceType: result.resource_type, type: result.type });
      await this.sdk.uploader
        .destroy(publicId, { ...this.auth(), resource_type: result.resource_type ?? RESOURCE_TYPE, type: result.type ?? DELIVERY_TYPE, invalidate: true })
        .catch(() => undefined);
      throw new StorageError("REJECTED", MESSAGES.REJECTED);
    }
  }

  async get(key: string) {
    const publicId = this.publicId(key);
    // Signed, 2-minute API download URL for the authenticated raw asset. It is used here and never stored, logged or returned.
    const url = this.sdk.utils.private_download_url(publicId, "", {
      ...this.auth(),
      resource_type: RESOURCE_TYPE,
      type: DELIVERY_TYPE,
      expires_at: Math.floor(Date.now() / 1000) + 120,
    });

    let res: Response;
    try {
      res = await this.fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw toStorageError(err);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const mapped = toStorageError(undefined, res.status);
      logger.warn("storage.cloudinary.get_failed", { code: mapped.code, httpStatus: res.status });
      throw mapped;
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > this.cfg.maxReadBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new StorageError("REJECTED", MESSAGES.REJECTED);
    }
    try {
      if (!res.body) return new Uint8Array(0);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.cfg.maxReadBytes) {
          await reader.cancel();
          throw new StorageError("REJECTED", MESSAGES.REJECTED);
        }
        chunks.push(value);
      }
      return new Uint8Array(Buffer.concat(chunks));
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async delete(key: string) {
    const publicId = this.publicId(key);
    let res: { result?: string };
    try {
      res = await this.sdk.uploader.destroy(publicId, { ...this.auth(), resource_type: RESOURCE_TYPE, type: DELIVERY_TYPE, invalidate: true, timeout: this.timeoutMs });
    } catch (err) {
      const mapped = toStorageError(err);
      if (mapped.code === "NOT_FOUND") return; // already gone: retries are safe
      logger.warn("storage.cloudinary.delete_failed", { code: mapped.code, httpCode: (err as { http_code?: number })?.http_code });
      throw mapped;
    }
    // "ok" = deleted, "not found" = already absent. Anything else means we cannot claim the object is gone, so the job retries.
    if (res.result === "ok" || res.result === "not found") return;
    logger.warn("storage.cloudinary.delete_unexpected_result", { result: String(res.result) });
    throw new StorageError("UNAVAILABLE", MESSAGES.UNAVAILABLE);
  }

  /** Clients never receive Cloudinary URLs: downloads are streamed through the authorized backend route. */
  async signedDownloadUrl() {
    return null;
  }

  async ping() {
    try {
      const res = await this.sdk.api.ping({ ...this.auth(), timeout: 15_000 });
      if (res.status !== "OK") throw new StorageError("UNAVAILABLE", MESSAGES.UNAVAILABLE);
    } catch (err) {
      throw toStorageError(err);
    }
  }
}
