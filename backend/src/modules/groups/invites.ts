import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { recordAudit } from "../../lib/audit.js";
import { now } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { notifyUsers } from "../account/notifications.js";
import { invalidInvite, isCapacityError, requireMember, requireStaff } from "./permissions.js";
import { getGroup, lockGroup, type GroupView } from "./service.js";
import type { inviteSchema } from "./schemas.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding). 16 random bytes = 128 bits → 26 characters. */
export function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const generateCode = (): string => base32(randomBytes(16));
/** Groups a code for display: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X. */
export const formatCode = (code: string): string => code.match(/.{1,5}/g)!.join("-");
/** Accepts what a person pastes (dashes, spaces, lower case). Returns null when it can't be a code. */
export function normalizeCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z2-7]/g, "");
  return c.length === 26 ? c : null;
}
export const hashCode = (normalized: string): string => createHash("sha256").update(normalized).digest("hex");

export type InviteStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "USED_UP";
export function inviteStatus(i: { revokedAt: Date | null; expiresAt: Date; maxUses: number; useCount: number }, at: Date): InviteStatus {
  if (i.revokedAt) return "REVOKED";
  if (i.expiresAt <= at) return "EXPIRED";
  if (i.useCount >= i.maxUses) return "USED_UP";
  return "ACTIVE";
}

const inviteView = (i: { id: string; expiresAt: Date; maxUses: number; useCount: number; codeHint: string; forUserId: string | null; revokedAt: Date | null; createdAt: Date }, at: Date) => ({
  id: i.id, status: inviteStatus(i, at), expiresAt: i.expiresAt.toISOString(), maxUses: i.maxUses, useCount: i.useCount, codeHint: i.codeHint, forEmail: i.forUserId !== null, createdAt: i.createdAt.toISOString(),
});

export async function createInvite(user: SessionUser, groupId: string, input: z.infer<ReturnType<typeof inviteSchema>>) {
  const env = getEnv();
  requireStaff(await requireMember(user.id, groupId));
  await enforceRateLimit({ key: `invite-create:${user.id}`, limit: 30, windowSec: 3600 });
  const group = await db.group.findUniqueOrThrow({ where: { id: groupId }, select: { title: true, capacity: true } });

  // Direct invitation: the code is bound to that account. Whether the address has an account is never revealed: an unknown
  // address gets an indistinguishable response and a code bound to nobody (it can never be redeemed).
  let forUserId: string | null = null;
  let target: { id: string } | null = null;
  if (input.email) {
    target = await db.user.findFirst({ where: { email: { equals: input.email, mode: "insensitive" }, status: "ACTIVE" }, select: { id: true } });
    forUserId = target?.id ?? `unclaimed:${randomUUID()}`;
  }
  const code = generateCode();
  const at = now();
  const invite = await db.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const active = await tx.groupInvite.count({ where: { groupId, revokedAt: null, expiresAt: { gt: at }, useCount: { lt: tx.groupInvite.fields.maxUses } } });
    if (active >= env.INVITE_MAX_ACTIVE_PER_GROUP)
      throw new AppError("VALIDATION", `A group can have up to ${env.INVITE_MAX_ACTIVE_PER_GROUP} active invitations. Revoke one first.`, { fields: { expiresInHours: "Too many active invitations." } });
    return tx.groupInvite.create({
      data: {
        groupId, createdById: user.id, codeHash: hashCode(code), codeHint: code.slice(-4),
        expiresAt: new Date(at.getTime() + (input.expiresInHours ?? env.INVITE_DEFAULT_TTL_HOURS) * 3_600_000),
        maxUses: input.email ? 1 : (input.maxUses ?? Math.min(env.INVITE_MAX_USES, group.capacity)), forUserId,
      },
    });
  });

  const shown = formatCode(code);
  if (target && target.id !== user.id) {
    const already = await db.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: target.id } }, select: { userId: true } });
    if (!already)
      await notifyUsers([target.id], {
        type: "group.invitation", title: `You're invited to join ${group.title}`, body: `${user.name} invited you to the study group “${group.title}”. This invitation is just for you.`,
        link: `/join/${shown}`, dedupeKey: `group-invite:${invite.id}`,
      });
  }
  await recordAudit({ actorId: user.id, action: "group.invite_created", targetType: "group", targetId: groupId, metadata: { direct: Boolean(input.email) } });
  return { invite: inviteView(invite, at), code: shown, link: `${env.APP_URL.replace(/\/$/, "")}/join/${shown}` };
}

export async function listInvites(user: SessionUser, groupId: string) {
  requireStaff(await requireMember(user.id, groupId));
  const rows = await db.groupInvite.findMany({ where: { groupId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
  const at = now();
  return { items: rows.map((i) => inviteView(i, at)) };
}

export async function revokeInvite(user: SessionUser, groupId: string, inviteId: string): Promise<void> {
  requireStaff(await requireMember(user.id, groupId));
  const inv = await db.groupInvite.findFirst({ where: { id: inviteId, groupId }, select: { id: true, revokedAt: true } });
  if (!inv) throw Errors.notFound();
  if (inv.revokedAt) return; // idempotent
  await db.groupInvite.updateMany({ where: { id: inviteId, revokedAt: null }, data: { revokedAt: now() } });
  await recordAudit({ actorId: user.id, action: "group.invite_revoked", targetType: "group", targetId: groupId });
}

// ---------------------------------------------------------------------------------------------------------------------
// Preview and join
// ---------------------------------------------------------------------------------------------------------------------
/** Both successes and failures consume the budget, per user and per IP, so guessing is throttled regardless of outcome. */
async function throttleCodeAttempts(userId: string, ip: string | null): Promise<void> {
  const env = getEnv();
  await enforceRateLimit({ key: `invite-code:user:${userId}`, limit: env.INVITE_ATTEMPTS_PER_HOUR_USER, windowSec: 3600 });
  if (ip) await enforceRateLimit({ key: `invite-code:ip:${ip}`, limit: env.INVITE_ATTEMPTS_PER_HOUR_IP, windowSec: 3600 });
}

type InviteRow = { id: string; groupId: string; expiresAt: Date; revokedAt: Date | null; maxUses: number; useCount: number; forUserId: string | null };
const usable = (i: InviteRow, userId: string, at: Date) => !i.revokedAt && i.expiresAt > at && (i.forUserId === null || i.forUserId === userId);

export async function previewInvite(user: SessionUser, rawCode: string, ip: string | null) {
  await throttleCodeAttempts(user.id, ip);
  const code = normalizeCode(rawCode);
  if (!code) throw invalidInvite();
  const inv = await db.groupInvite.findUnique({ where: { codeHash: hashCode(code) } });
  if (!inv || !usable(inv, user.id, now()) || inv.useCount >= inv.maxUses) throw invalidInvite();
  const g = await db.group.findUniqueOrThrow({ where: { id: inv.groupId }, include: { _count: { select: { members: true } } } });
  return { group: { title: g.title, memberCount: g._count.members, capacity: g.capacity } };
}

export async function joinGroup(user: SessionUser, rawCode: string, ip: string | null): Promise<{ group: GroupView; alreadyMember: boolean }> {
  const env = getEnv();
  await throttleCodeAttempts(user.id, ip);
  const code = normalizeCode(rawCode);
  if (!code) throw invalidInvite();
  const hash = hashCode(code);
  const first = await db.groupInvite.findUnique({ where: { codeHash: hash }, select: { groupId: true } });
  if (!first) throw invalidInvite();

  let outcome: { alreadyMember: boolean; joinedAt: Date | null };
  try {
    outcome = await db.$transaction(
      async (tx) => {
        await lockGroup(tx, first.groupId); // everything below is serialized per group: capacity and use counts can't be raced
        const inv = await tx.groupInvite.findUnique({ where: { codeHash: hash } });
        const at = now();
        if (!inv || !usable(inv, user.id, at)) throw invalidInvite();
        const existing = await tx.groupMember.findUnique({ where: { groupId_userId: { groupId: inv.groupId, userId: user.id } }, select: { userId: true } });
        if (existing) return { alreadyMember: true, joinedAt: null }; // idempotent: no use consumed
        if (inv.useCount >= inv.maxUses) throw invalidInvite();
        if ((await tx.groupMember.count({ where: { userId: user.id } })) >= env.GROUP_MAX_MEMBERSHIPS_PER_USER)
          throw new AppError("VALIDATION", `You can belong to up to ${env.GROUP_MAX_MEMBERSHIPS_PER_USER} groups.`);
        const g = await tx.group.findUniqueOrThrow({ where: { id: inv.groupId }, select: { capacity: true } });
        if ((await tx.groupMember.count({ where: { groupId: inv.groupId } })) >= g.capacity) throw new AppError("GROUP_FULL", "This group is full.");
        const m = await tx.groupMember.create({ data: { groupId: inv.groupId, userId: user.id, role: "MEMBER" }, select: { joinedAt: true } });
        const { count } = await tx.groupInvite.updateMany({ where: { id: inv.id, useCount: { lt: inv.maxUses } }, data: { useCount: { increment: 1 } } });
        if (count !== 1) throw invalidInvite();
        return { alreadyMember: false, joinedAt: m.joinedAt };
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  } catch (err) {
    if (isCapacityError(err)) throw new AppError("GROUP_FULL", "This group is full."); // the DB trigger backstop
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { group: await groupFor(user.id, first.groupId), alreadyMember: true };
    throw err;
  }

  if (outcome.joinedAt) {
    const g = await db.group.findUniqueOrThrow({ where: { id: first.groupId }, select: { title: true } });
    const staff = await db.groupMember.findMany({ where: { groupId: first.groupId, role: { in: ["OWNER", "ADMIN"] }, userId: { not: user.id } }, select: { userId: true } });
    await notifyUsers(staff.map((s) => s.userId), {
      type: "group.member_joined", title: `New member in ${g.title}`, body: `${user.name} joined the group.`, link: `/groups/${first.groupId}`,
      dedupeKey: `group-joined:${first.groupId}:${outcome.joinedAt.getTime()}:${user.id}`,
    });
    await recordAudit({ actorId: user.id, action: "group.member_joined", targetType: "group", targetId: first.groupId });
  }
  return { group: await groupFor(user.id, first.groupId), alreadyMember: outcome.alreadyMember };
}

const groupFor = (userId: string, groupId: string): Promise<GroupView> => getGroup({ id: userId } as SessionUser, groupId);
