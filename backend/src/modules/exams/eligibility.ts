import type { Prisma } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { AppError, Errors, type ErrorCode } from "../../lib/errors.js";

type Client = Prisma.TransactionClient | typeof db;
export type ExamHead = { id: string; status: "DRAFT" | "PUBLISHED" | "CANCELLED"; mode: "INDIVIDUAL" | "GROUP"; ownerId: string; groupId: string | null; publishedAt: Date | null };
export type VersionHead = {
  id: string; durationSeconds: number; attemptLimit: number; opensAt: Date | null; closesAt: Date | null; lateStart: "CAP_AT_CLOSE" | "FULL_TIME_ONLY"; lateJoinGroup: boolean; publishedAt: Date;
};

export type StartCheck = { allowed: true } | { allowed: false; code: ErrorCode; reason: string; details?: Record<string, unknown> };

/** Staff = OWNER or ADMIN of the group. Not a member → 404 (no existence oracle); plain member → NOT_ELIGIBLE. */
export async function requireGroupStaff(userId: string, groupId: string, client: Client = db): Promise<"OWNER" | "ADMIN"> {
  const m = await client.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, select: { role: true } });
  if (!m) throw Errors.notFound();
  if (m.role === "MEMBER") throw new AppError("NOT_ELIGIBLE", "Only the group's owner or an admin can do that.");
  return m.role;
}

/**
 * May `userId` start (a new attempt on) this exam version right now? PART4_SPEC §5.1 rules, in order. Used by both the
 * start endpoint (which throws) and the participant view (`canStart`). Resuming an in-progress attempt is checked by the caller first.
 */
export async function checkStart(userId: string, exam: ExamHead, v: VersionHead, now: Date, client: Client = db): Promise<StartCheck> {
  const no = (code: ErrorCode, reason: string, details?: Record<string, unknown>): StartCheck => ({ allowed: false, code, reason, ...(details ? { details } : {}) });
  if (exam.status !== "PUBLISHED") return no("EXAM_CLOSED", "This exam is no longer open for new attempts.");
  if (exam.mode === "INDIVIDUAL") {
    if (exam.ownerId !== userId) return no("NOT_ELIGIBLE", "This exam isn't available to you.");
  } else {
    if (exam.ownerId === userId) return no("NOT_ELIGIBLE", "You wrote this exam, so you can't take it as a participant.");
    const member = exam.groupId ? await client.groupMember.findUnique({ where: { groupId_userId: { groupId: exam.groupId, userId } }, select: { joinedAt: true } }) : null;
    if (!member) return no("NOT_ELIGIBLE", "Only members of the group can take this exam.");
    if (!v.lateJoinGroup && member.joinedAt.getTime() > v.publishedAt.getTime()) return no("NOT_ELIGIBLE", "This exam is only open to members who were in the group when it was published.");
  }
  if (v.opensAt && now < v.opensAt) return no("EXAM_NOT_OPEN", "This exam hasn't opened yet.", { opensAt: v.opensAt.toISOString() });
  if (v.closesAt && now >= v.closesAt) return no("EXAM_CLOSED", "This exam has closed.", { closesAt: v.closesAt.toISOString() });
  if (v.lateStart === "FULL_TIME_ONLY" && v.closesAt && now.getTime() + v.durationSeconds * 1000 > v.closesAt.getTime())
    return no("EXAM_CLOSED", "It's too late to start: there isn't enough time left to complete this exam in full.", { closesAt: v.closesAt.toISOString() });
  const used = await client.examAttempt.count({ where: { examVersionId: v.id, userId } });
  if (used >= v.attemptLimit) return no("ATTEMPT_LIMIT", `You've used all ${v.attemptLimit} attempt${v.attemptLimit === 1 ? "" : "s"} for this exam.`, { limit: v.attemptLimit, used });
  return { allowed: true };
}

export function throwIfNotAllowed(check: StartCheck): void {
  if (!check.allowed) throw new AppError(check.code, check.reason, check.details);
}
