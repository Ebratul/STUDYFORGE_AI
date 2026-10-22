import type { GroupRole } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";

export type Membership = { role: GroupRole; joinedAt: Date; showNameOnLeaderboard: boolean };

/** The caller's membership, or NotFound: non-members can't tell a group exists. */
export async function requireMember(userId: string, groupId: string): Promise<Membership> {
  const m = await db.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, select: { role: true, joinedAt: true, showNameOnLeaderboard: true } });
  if (!m) throw Errors.notFound();
  return m;
}

export const isStaff = (role: GroupRole) => role === "OWNER" || role === "ADMIN";

export function requireStaff(m: Membership): void {
  if (!isStaff(m.role)) throw Errors.forbidden();
}

export function requireOwner(m: Membership): void {
  if (m.role !== "OWNER") throw Errors.forbidden();
}

export const invalidInvite = () => new AppError("INVALID_INVITE", "That invitation code is invalid or has expired.");

/** The DB capacity trigger raises 'group is full'; its text may sit in the error, its cause or its meta depending on the driver. */
export function isCapacityError(err: unknown): boolean {
  const e = err as { message?: string; cause?: unknown; meta?: unknown } | null;
  const text = [e?.message, JSON.stringify(e?.meta ?? {}), String((e?.cause as { message?: string } | undefined)?.message ?? "")].join(" ");
  return /group is full/i.test(text);
}
