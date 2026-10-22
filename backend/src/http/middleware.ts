import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler, ErrorHandler, NotFoundHandler } from "hono";
import { AppError, Errors } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
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

export const onError: ErrorHandler<AppEnv> = (err, c: Context<AppEnv>) => {
  const requestId = c.get("requestId");
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    const retry = err.details?.retryAfterSec;
    if (typeof retry === "number") headers["retry-after"] = String(retry);
    return c.json({ error: { code: err.code, message: err.message, details: err.details, requestId } }, err.status as 400, headers);
  }
  logger.error("api.unhandled", { requestId, err });
  return c.json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again.", requestId } }, 500);
};

export const onNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "We couldn't find what you were looking for.", requestId: c.get("requestId") } }, 404);
