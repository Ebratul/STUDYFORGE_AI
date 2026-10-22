import type { ZodType } from "zod";
import { AppError } from "../lib/errors.js";
import { getEnv } from "../config/env.js";

export const DEFAULT_JSON_LIMIT = 64 * 1024; // 64 KiB: more than enough for foundation endpoints

/** Trusts X-Forwarded-For: the backend must only be reachable through the frontend proxy / a trusted load balancer. */
export function getClientIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return headers.get("x-real-ip");
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated route handlers: mutating requests must come from our origin.
 * (Server Actions get an equivalent check from Next.js; Better Auth validates its own endpoints.)
 */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const allowed = new URL(getEnv().APP_URL).origin;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin !== allowed) throw new AppError("BAD_ORIGIN", "Cross-site requests are not allowed.");
    return;
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new AppError("BAD_ORIGIN", "Cross-site requests are not allowed.");
  }
  if (!fetchSite) throw new AppError("BAD_ORIGIN", "Missing request origin.");
}

/** Reads a JSON body with a hard byte cap (does not trust Content-Length alone) and validates it. */
export async function readJson<T>(req: Request, schema: ZodType<T>, maxBytes = DEFAULT_JSON_LIMIT): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.");
  if (!req.body) throw new AppError("VALIDATION", "A JSON body is required.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(value);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("VALIDATION", "Request body must be valid JSON.");
  }
  return parseWith(schema, json);
}

/** Validates already-parsed input; field errors are returned as `{ fieldPath: message }` for the UI. */
export function parseWith<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[issue.path.join(".") || "_"] ??= issue.message;
    throw new AppError("VALIDATION", "Some fields are invalid.", { fields });
  }
  return parsed.data;
}
