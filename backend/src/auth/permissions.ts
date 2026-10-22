import type { Role } from "../generated/prisma/client.js";

/**
 * Permission catalogue. Roles map to permission sets; later parts add entries here
 * rather than scattering `role === "ADMIN"` checks across the codebase.
 */
export const PERMISSIONS = {
  "admin:dashboard:view": ["ADMIN"],
  "admin:audit:view": ["ADMIN"],
  "account:manage-own": ["USER", "ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
