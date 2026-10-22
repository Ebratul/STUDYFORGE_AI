import type { Role } from "../generated/prisma/client.js";

/**
 * Permission catalogue (PART5_SPEC §9). Roles map to permission sets; modules call `can`/`requirePermission`
 * (or `requirePermissionMw`) instead of scattering `role === "ADMIN"` checks.
 *
 *  - USER:    own data only.
 *  - SUPPORT: read-only operational access (users with masked e-mail, audit, metrics, jobs, health, usage). Never user content.
 *  - ADMIN:   everything SUPPORT can, plus user management, job retries and effective configuration. Still no access to
 *             private content (conversations, documents, credentials, answers): no such permission exists.
 */
export const PERMISSIONS = {
  "admin:dashboard:view": ["ADMIN", "SUPPORT"],
  "admin:users:view": ["ADMIN", "SUPPORT"],
  "admin:users:manage": ["ADMIN"],
  "admin:audit:view": ["ADMIN", "SUPPORT"],
  "admin:metrics:view": ["ADMIN", "SUPPORT"],
  "admin:usage:view": ["ADMIN", "SUPPORT"],
  "admin:jobs:view": ["ADMIN", "SUPPORT"],
  "admin:jobs:manage": ["ADMIN"],
  "admin:health:view": ["ADMIN", "SUPPORT"],
  "admin:config:view": ["ADMIN"],
  "account:manage-own": ["USER", "SUPPORT", "ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** True for any role with operational (admin-area) access. Used only to decide whether to show the area at all. */
export const hasAdminArea = (role: Role): boolean => role === "ADMIN" || role === "SUPPORT";
