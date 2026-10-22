export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "BAD_ORIGIN"
  | "CONFLICT"
  | "NOT_CONFIGURED"
  | "QUOTA_EXCEEDED"
  | "STORAGE_QUOTA_EXCEEDED"
  | "UNSUPPORTED_MEDIA"
  | "PROVIDER_ERROR"
  | "GENERATION_FAILED"
  | "NOT_ELIGIBLE"
  | "EXAM_NOT_OPEN"
  | "EXAM_CLOSED"
  | "ATTEMPT_LIMIT"
  | "ATTEMPT_EXPIRED"
  | "GROUP_FULL"
  | "INVALID_INVITE"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  BAD_ORIGIN: 403,
  CONFLICT: 409,
  NOT_CONFIGURED: 422,
  QUOTA_EXCEEDED: 429,
  STORAGE_QUOTA_EXCEEDED: 413,
  UNSUPPORTED_MEDIA: 415,
  PROVIDER_ERROR: 502,
  GENERATION_FAILED: 502,
  NOT_ELIGIBLE: 403,
  EXAM_NOT_OPEN: 409,
  EXAM_CLOSED: 409,
  ATTEMPT_LIMIT: 409,
  ATTEMPT_EXPIRED: 409,
  GROUP_FULL: 409,
  INVALID_INVITE: 404,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** An error whose `message` is safe to show to end users. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const Errors = {
  unauthenticated: () => new AppError("UNAUTHENTICATED", "You need to sign in to continue."),
  forbidden: () => new AppError("FORBIDDEN", "You do not have permission to do that."),
  // Deliberately identical for "missing" and "belongs to someone else" to avoid existence leaks.
  notFound: () => new AppError("NOT_FOUND", "We couldn't find what you were looking for."),
  rateLimited: (retryAfterSec: number) =>
    new AppError("RATE_LIMITED", "Too many requests. Please wait a moment and try again.", { retryAfterSec }),
};
