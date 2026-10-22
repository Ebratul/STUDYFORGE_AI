import type { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { recordAudit } from "../../lib/audit.js";
import { now } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { notifyUsers } from "../account/notifications.js";
import { isReleased } from "../exams/release.js";
import { requireMember, requireOwner, requireStaff } from "./permissions.js";
import type { createGroupSchema, deleteGroupSchema, updateGroupSchema } from "./schemas.js";

type Tx = Prisma.TransactionClient;

export type GroupView = {
  id: string;
  title: string;
  description: string | null;
  capacity: number;
  memberCount: number;
  myRole: "OWNER" | "ADMIN" | "MEMBER";
  /** The caller's own membership (role and leaderboard-name privacy). */
  me: { role: "OWNER" | "ADMIN" | "MEMBER"; showNameOnLeaderboard: boolean };
  ownerName: string;
  createdAt: string;
  updatedAt: string;
};

const displayName = (u: { name: string; profile: { displayName: string | null } | null }) => u.profile?.displayName?.trim() || u.name;

/** Locks the group row so capacity/invite bookkeeping is serialized per group. */
export const lockGroup = (tx: Tx, groupId: string) => tx.$queryRaw`SELECT "id" FROM "Group" WHERE "id" = ${groupId} FOR UPDATE`;

async function viewOf(groupId: string, myRole: GroupView["myRole"], showNameOnLeaderboard = true): Promise<GroupView> {
  const g = await db.group.findUniqueOrThrow({
    where: { id: groupId },
    include: { _count: { select: { members: true } }, owner: { select: { name: true, profile: { select: { displayName: true } } } } },
  });
  return { id: g.id, title: g.title, description: g.description, capacity: g.capacity, memberCount: g._count.members, myRole, me: { role: myRole, showNameOnLeaderboard }, ownerName: displayName(g.owner), createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString() };
}

export async function createGroup(user: SessionUser, input: z.infer<ReturnType<typeof createGroupSchema>>): Promise<GroupView> {
  const env = getEnv();
  const id = await db.$transaction(async (tx) => {
    // Serialize a user's own group creation so the per-user caps can't be raced past.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`group-create:${user.id}`}, 0))`;
    if ((await tx.group.count({ where: { ownerId: user.id } })) >= env.GROUP_MAX_OWNED_PER_USER)
      throw new AppError("VALIDATION", `You can own up to ${env.GROUP_MAX_OWNED_PER_USER} groups.`, { fields: { title: "Group limit reached." } });
    if ((await tx.groupMember.count({ where: { userId: user.id } })) >= env.GROUP_MAX_MEMBERSHIPS_PER_USER)
      throw new AppError("VALIDATION", `You can belong to up to ${env.GROUP_MAX_MEMBERSHIPS_PER_USER} groups.`, { fields: { title: "Membership limit reached." } });
    const g = await tx.group.create({ data: { ownerId: user.id, title: input.title, description: input.description, capacity: input.capacity ?? Math.min(env.GROUP_DEFAULT_CAPACITY, env.GROUP_MAX_CAPACITY) }, select: { id: true } });
    await tx.groupMember.create({ data: { groupId: g.id, userId: user.id, role: "OWNER" } });
    return g.id;
  });
  await recordAudit({ actorId: user.id, action: "group.created", targetType: "group", targetId: id });
  return viewOf(id, "OWNER");
}

export async function listGroups(user: SessionUser): Promise<{ items: GroupView[] }> {
  const rows = await db.groupMember.findMany({
    where: { userId: user.id },
    orderBy: [{ joinedAt: "desc" }, { groupId: "asc" }],
    include: { group: { include: { _count: { select: { members: true } }, owner: { select: { name: true, profile: { select: { displayName: true } } } } } } },
  });
  return {
    items: rows.map(({ group: g, role, showNameOnLeaderboard }) => ({
      id: g.id, title: g.title, description: g.description, capacity: g.capacity, memberCount: g._count.members, myRole: role, me: { role, showNameOnLeaderboard }, ownerName: displayName(g.owner),
      createdAt: g.createdAt.toISOString(), updatedAt: g.updatedAt.toISOString(),
    })),
  };
}

export async function getGroup(user: SessionUser, groupId: string): Promise<GroupView> {
  const m = await requireMember(user.id, groupId);
  return viewOf(groupId, m.role, m.showNameOnLeaderboard);
}

export async function updateGroup(user: SessionUser, groupId: string, input: z.infer<ReturnType<typeof updateGroupSchema>>): Promise<GroupView> {
  const me = await requireMember(user.id, groupId);
  requireOwner(me);
  await db.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    if (input.capacity !== undefined) {
      const members = await tx.groupMember.count({ where: { groupId } });
      if (input.capacity < members) throw new AppError("VALIDATION", `The group already has ${members} members, so capacity can't be lower than that.`, { fields: { capacity: `At least ${members} (current members).` } });
    }
    await tx.group.update({
      where: { id: groupId },
      data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.capacity !== undefined ? { capacity: input.capacity } : {}) },
    });
  });
  await recordAudit({ actorId: user.id, action: "group.updated", targetType: "group", targetId: groupId });
  return viewOf(groupId, "OWNER", me.showNameOnLeaderboard);
}

export async function deleteGroup(user: SessionUser, groupId: string, input: z.infer<typeof deleteGroupSchema>): Promise<void> {
  requireOwner(await requireMember(user.id, groupId));
  const g = await db.group.findUniqueOrThrow({ where: { id: groupId }, select: { title: true } });
  if (input.confirmTitle.trim() !== g.title) throw new AppError("VALIDATION", "Type the group's name to confirm.", { fields: { confirmTitle: "That doesn't match the group's name." } });
  await db.group.delete({ where: { id: groupId } }); // members, invites and group exams (with attempts/results) cascade
  await recordAudit({ actorId: user.id, action: "group.deleted", targetType: "group", targetId: groupId });
}

// ---------------------------------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------------------------------
export async function listMembers(user: SessionUser, groupId: string, q: { page: number; pageSize: number }) {
  await requireMember(user.id, groupId);
  const [total, rows] = await Promise.all([
    db.groupMember.count({ where: { groupId } }),
    db.groupMember.findMany({
      where: { groupId },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }, { userId: "asc" }], // enum order: OWNER, ADMIN, MEMBER
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { user: { select: { name: true, profile: { select: { displayName: true } } } } },
    }),
  ]);
  return {
    items: rows.map((m) => ({ memberId: m.userId, displayName: displayName(m.user), role: m.role, joinedAt: m.joinedAt.toISOString(), isSelf: m.userId === user.id })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function changeRole(user: SessionUser, groupId: string, memberId: string, role: "ADMIN" | "MEMBER"): Promise<void> {
  requireOwner(await requireMember(user.id, groupId));
  const target = await db.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: memberId } }, select: { role: true } });
  if (!target) throw Errors.notFound();
  if (target.role === "OWNER") throw new AppError("VALIDATION", "The owner's role can't be changed.");
  if (target.role !== role) {
    await db.groupMember.update({ where: { groupId_userId: { groupId, userId: memberId } }, data: { role } });
    await recordAudit({ actorId: user.id, action: "group.role_changed", targetType: "group", targetId: groupId, metadata: { role } });
  }
}

export async function removeMember(user: SessionUser, groupId: string, memberId: string): Promise<void> {
  const actor = await requireMember(user.id, groupId);
  requireStaff(actor);
  if (memberId === user.id) throw new AppError("VALIDATION", "Use “Leave group” to leave a group yourself.");
  const target = await db.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: memberId } }, select: { role: true, joinedAt: true } });
  if (!target) throw Errors.notFound();
  if (target.role === "OWNER") throw Errors.forbidden();
  if (target.role === "ADMIN" && actor.role !== "OWNER") throw Errors.forbidden();
  const { count } = await db.groupMember.deleteMany({ where: { groupId, userId: memberId, role: { not: "OWNER" } } });
  if (!count) return;
  const g = await db.group.findUniqueOrThrow({ where: { id: groupId }, select: { title: true } });
  await notifyUsers([memberId], {
    type: "group.member_removed", title: `You were removed from ${g.title}`, body: "A group admin removed you from this group. Your own exam results stay private to you.", link: "/groups",
    dedupeKey: `group-removed:${groupId}:${target.joinedAt.getTime()}`,
  });
  await recordAudit({ actorId: user.id, action: "group.member_removed", targetType: "group", targetId: groupId });
}

export async function leaveGroup(user: SessionUser, groupId: string): Promise<void> {
  const m = await requireMember(user.id, groupId);
  if (m.role === "OWNER") throw new AppError("FORBIDDEN", "The owner can't leave the group. Delete the group instead.");
  const { count } = await db.groupMember.deleteMany({ where: { groupId, userId: user.id, role: { not: "OWNER" } } });
  if (!count) return;
  const g = await db.group.findUniqueOrThrow({ where: { id: groupId }, select: { title: true, ownerId: true } });
  await notifyUsers([g.ownerId], {
    type: "group.member_left", title: `A member left ${g.title}`, body: `${user.name} left the group.`, link: `/groups/${groupId}`,
    dedupeKey: `group-left:${groupId}:${m.joinedAt.getTime()}:${user.id}`,
  });
  await recordAudit({ actorId: user.id, action: "group.member_left", targetType: "group", targetId: groupId });
}

export async function setMyPrivacy(user: SessionUser, groupId: string, showNameOnLeaderboard: boolean): Promise<{ showNameOnLeaderboard: boolean }> {
  await requireMember(user.id, groupId);
  await db.groupMember.update({ where: { groupId_userId: { groupId, userId: user.id } }, data: { showNameOnLeaderboard } });
  return { showNameOnLeaderboard };
}

// ---------------------------------------------------------------------------------------------------------------------
// Group exam history
// ---------------------------------------------------------------------------------------------------------------------
export type ParticipationStatus = "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "TIMED_OUT" | "MISSED" | "AUTHOR" | "NOT_ELIGIBLE";

export async function listGroupExams(user: SessionUser, groupId: string, q: { page: number; pageSize: number }) {
  const me = await requireMember(user.id, groupId);
  const where: Prisma.ExamWhereInput = { groupId, OR: [{ status: { in: ["PUBLISHED", "CANCELLED"] } }, { status: "DRAFT", ownerId: user.id }] };
  const [total, exams] = await Promise.all([
    db.exam.count({ where }),
    db.exam.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { owner: { select: { name: true, profile: { select: { displayName: true } } } } } }),
  ]);
  const published = exams.filter((e) => e.currentVersion > 0);
  const versions = published.length
    ? await db.examVersion.findMany({ where: { OR: published.map((e) => ({ examId: e.id, version: e.currentVersion })) } })
    : [];
  const vByExam = new Map(versions.map((v) => [v.examId, v]));
  const attempts = versions.length
    ? await db.examAttempt.findMany({ where: { userId: user.id, examVersionId: { in: versions.map((v) => v.id) } }, include: { result: true }, orderBy: { attemptNo: "asc" } })
    : [];
  const t = now();

  const items = exams.map((e) => {
    const v = vByExam.get(e.id);
    let myStatus: ParticipationStatus | null = null;
    let myResult: { released: boolean; scoreCenti?: number; maxCenti?: number; percentBp?: number; band?: string } | null = null;
    if (v) {
      const mine = attempts.filter((a) => a.examVersionId === v.id);
      const finalized = mine.filter((a) => a.result);
      const best = [...finalized].sort((a, b) => b.result!.scoreCenti - a.result!.scoreCenti || a.finalizedAt!.getTime() - b.finalizedAt!.getTime())[0];
      const closed = e.status === "CANCELLED" || (v.closesAt !== null && t >= v.closesAt);
      if (e.ownerId === user.id) myStatus = "AUTHOR";
      else if (!v.lateJoinGroup && me.joinedAt > v.publishedAt) myStatus = "NOT_ELIGIBLE";
      else if (best) myStatus = best.status === "TIMED_OUT" ? "TIMED_OUT" : "SUBMITTED";
      else if (mine.some((a) => a.status === "IN_PROGRESS")) myStatus = "IN_PROGRESS";
      else myStatus = closed ? "MISSED" : "NOT_STARTED";
      const released = isReleased(v, t);
      myResult = best ? (released ? { released, scoreCenti: best.result!.scoreCenti, maxCenti: best.result!.maxCenti, percentBp: best.result!.percentBp, band: best.result!.band } : { released }) : null;
    }
    return {
      id: e.id, title: e.title, status: e.status, mine: e.ownerId === user.id, authorName: displayName(e.owner),
      questionCount: v?.questionCount ?? null, totalMarks: v ? v.totalCenti / 100 : null, durationMinutes: v ? Math.round(v.durationSeconds / 60) : null,
      opensAt: v?.opensAt?.toISOString() ?? null, closesAt: v?.closesAt?.toISOString() ?? null, publishedAt: e.publishedAt?.toISOString() ?? null,
      leaderboardVisible: v?.leaderboardVisible ?? null,
      myStatus, myResult,
    };
  });
  return { items, total, page: q.page, pageSize: q.pageSize };
}
