import { ApiError } from "./api";

export const USERS_PAGE_SIZE = 20;
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 100;

/** Safe, human text for a failed admin call. The server's own message is used for guard errors (self-change, last admin…): it never contains internals. */
export function describeAdminError(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "NETWORK": return err.message;
    case "UNAUTHENTICATED": return "Your session has ended. Sign in again to continue.";
    case "NOT_FOUND": return "That item wasn't found, or you don't have permission to use it.";
    case "FORBIDDEN": return err.message || "You don't have permission to do that.";
    case "RATE_LIMITED": return "Too many requests. Please wait a moment and try again.";
    case "CONFLICT":
    case "VALIDATION": return err.message || "That change isn't allowed.";
    default: return err.status >= 500 ? "The server had a problem. Please try again." : err.message || "Something went wrong. Please try again.";
  }
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && String(v).trim() !== "") u.set(k, String(v).trim());
  const s = u.toString();
  return s ? `?${s}` : "";
}

export type UserFilters = { q: string; status: "" | "ACTIVE" | "SUSPENDED"; role: "" | "USER" | "SUPPORT" | "ADMIN" };
export const usersPath = (f: UserFilters, page: number): string => `/api/admin/users${qs({ q: f.q, status: f.status, role: f.role, page, pageSize: USERS_PAGE_SIZE })}`;

export type AuditFilters = { action: string; actor: string; from: string; to: string };
/** `from`/`to` are `<input type=date>` values (local dates); sent as ISO instants covering whole days. */
export function auditPath(f: AuditFilters, page: number): string {
  const from = f.from ? new Date(`${f.from}T00:00:00`) : null;
  const to = f.to ? new Date(`${f.to}T23:59:59.999`) : null;
  return `/api/admin/audit${qs({ action: f.action, actor: f.actor, from: from && !Number.isNaN(from.getTime()) ? from.toISOString() : undefined, to: to && !Number.isNaN(to.getTime()) ? to.toISOString() : undefined, page, pageSize: AUDIT_PAGE_SIZE })}`;
}

export const metricsPath = (hours: number): string => `/api/admin/metrics?hours=${hours}`;
