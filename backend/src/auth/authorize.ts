import { Errors } from "../lib/errors.js";
import { roleHasPermission, type Permission } from "./permissions.js";
import type { SessionUser } from "./types.js";

/**
 * Authorization primitives shared by every module.
 *
 * Rules every future module follows:
 *  1. Resolve the actor from the server session (never from request input).
 *  2. Call `requirePermission` for role-gated operations.
 *  3. Scope every query on owned data with `ownedBy(actor)` (or assert with `assertOwner`).
 *  4. Missing and not-yours are indistinguishable (404), so ids cannot be probed.
 */
export function can(user: SessionUser, permission: Permission): boolean {
  return user.status === "ACTIVE" && roleHasPermission(user.role, permission);
}

export function requirePermission(user: SessionUser, permission: Permission): void {
  if (!can(user, permission)) throw Errors.forbidden();
}

export function assertOwner(user: SessionUser, ownerId: string | null | undefined): void {
  if (!ownerId || ownerId !== user.id) throw Errors.notFound();
}

/** Prisma `where` fragment: `db.thing.findFirst({ where: { id, ...ownedBy(user) } })`. */
export function ownedBy(user: SessionUser): { userId: string } {
  return { userId: user.id };
}
