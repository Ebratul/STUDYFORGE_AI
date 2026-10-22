import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler, ErrorHandler, NotFoundHandler } from "hono";
import { AppError, Errors } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { recordBlock, recordRequest } from "../lib/metrics.js";
import { resolveSession } from "../auth/session.js";
import { can } from "../auth/authorize.js";
import type { Permission } from "../auth/permissions.js";
import { assertSameOrigin, getClientIp } from "./body.js";
import type { AppEnv } from "./context.js";

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("x-request-id")?.slice(0, 64) || randomUUID();
  c.set("requestId", requestId);
  c.set("clientIp", getClientIp(c.req.raw.headers));
  await next();
  recordRequest(c.req.path, c.res.status); // coarse counters only (status class + route group); no ids, no content
  c.res.headers.set("x-request-id", requestId);
  // JSON API: never cached, never sniffed, never framed.
  c.res.headers.set("x-content-type-options", "nosniff");
  if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
};

/** CSRF defence for cookie-authenticated mutations: the browser Origin (forwarded by the frontend proxy) must be ours. */
export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  assertSameOrigin(c.req.raw);
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const resolved = await resolveSession(c.req.raw.headers);
  if (!resolved) throw Errors.unauthenticated();
  c.set("user", resolved.user);
  c.set("sessionId", resolved.sessionId);
  await next();
};

export function requirePermissionMw(permission: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!can(c.get("user"), permission)) throw Errors.notFound(); // admin surface does not advertise itself
    await next();
  };
}

/** Coarse error category for structured logs and dashboards. */
export function errorCategory(code: string): "validation" | "auth" | "rate_limit" | "upstream" | "internal" {
  switch (code) {
    case "VALIDATION":
    case "PAYLOAD_TOO_LARGE":
    case "UNSUPPORTED_MEDIA":
    case "BAD_ORIGIN":
    case "CONFLICT":
    case "NOT_FOUND":
    case "NOT_CONFIGURED":
    case "INVALID_INVITE":
    case "ATTEMPT_LIMIT":
    case "ATTEMPT_EXPIRED":
    case "EXAM_NOT_OPEN":
    case "EXAM_CLOSED":
    case "GROUP_FULL":
      return "validation";
    case "UNAUTHENTICATED":
    case "FORBIDDEN":
    case "NOT_ELIGIBLE":
      return "auth";
    case "RATE_LIMITED":
    case "QUOTA_EXCEEDED":
    case "STORAGE_QUOTA_EXCEEDED":
      return "rate_limit";
    case "PROVIDER_ERROR":
    case "GENERATION_FAILED":
    case "UPSTREAM_UNAVAILABLE":
      return "upstream";
    default:
      return "internal";
  }
}

export const onError: ErrorHandler<AppEnv> = (err, c: Context<AppEnv>) => {
  const requestId = c.get("requestId");
  if (err instanceof AppError) {
    if (err.code === "RATE_LIMITED") recordBlock("rate_limit", c.req.path);
    if (err.code === "QUOTA_EXCEEDED") recordBlock("quota", c.req.path);
    if (err.status >= 500) logger.warn("api.error", { requestId, category: errorCategory(err.code), code: err.code, status: err.status });
    const headers: Record<string, string> = {};
    const retry = err.details?.retryAfterSec;
    if (typeof retry === "number") headers["retry-after"] = String(retry);
    return c.json({ error: { code: err.code, message: err.message, details: err.details, requestId } }, err.status as 400, headers);
  }
  logger.error("api.unhandled", { requestId, category: "internal", err });
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again.", requestId } }, 500);
};

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "We couldn't find what you were looking for.", requestId: c.get("requestId") } }, 404);
