import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { notifyUsers } from "../account/notifications.js";
import { enqueue, RetryableJobError } from "../jobs/queue.js";
import type { Handlers } from "../jobs/worker.js";
import { finalizeExpiredAttempts, finalizeIfExpired } from "./attempts.js";
import { isReleased } from "./release.js";

/**
 * Exam jobs (PART4_SPEC §5.7). Every handler is idempotent: running twice, late, or concurrently with the sweeper/lazy paths
 * produces the same state and never a second notification (per-user dedupe keys).
 */

export async function sendReminder(versionId: string): Promise<number> {
  const v = await db.examVersion.findUnique({ where: { id: versionId }, include: { exam: { select: { id: true, status: true, ownerId: true, groupId: true, title: true } } } });
  if (!v || v.exam.status !== "PUBLISHED" || !v.opensAt || !v.reminderMinutes) return 0;
  let candidates: string[];
  if (v.mode === "INDIVIDUAL") candidates = [v.exam.ownerId];
  else {
    const members = v.exam.groupId ? await db.groupMember.findMany({ where: { groupId: v.exam.groupId, userId: { not: v.exam.ownerId } }, select: { userId: true, joinedAt: true } }) : [];
    candidates = members.filter((m) => v.lateJoinGroup || m.joinedAt.getTime() <= v.publishedAt.getTime()).map((m) => m.userId);
  }
  const started = new Set((await db.examAttempt.findMany({ where: { examVersionId: v.id, userId: { in: candidates } }, select: { userId: true } })).map((a) => a.userId));
  const n = await notifyUsers(candidates.filter((u) => !started.has(u)), {
    type: "exam.reminder", title: "Exam starting soon", body: `“${v.title}” opens at ${v.opensAt.toISOString().replace("T", " ").slice(0, 16)} UTC.`, link: `/exams/${v.exam.id}`, dedupeKey: `exam-reminder:${v.id}`,
  });
  await db.examVersionState.updateMany({ where: { examVersionId: v.id }, data: { reminderSentAt: clockNow() } });
  return n;
}

/** Tells every participant with a finalized result that results are available (only once the release time has passed). Returns false if not yet due. */
export async function sendReleaseNotices(versionId: string): Promise<boolean> {
  const v = await db.examVersion.findUnique({ where: { id: versionId }, select: { id: true, examId: true, title: true, releaseMode: true, closesAt: true, releaseAt: true } });
  if (!v) return true;
  if (!isReleased(v, clockNow())) return false;
  const results = await db.examResult.findMany({ where: { examVersionId: v.id }, orderBy: { finalizedAt: "desc" }, select: { attemptId: true, userId: true } });
  const latest = new Map<string, string>();
  for (const r of results) if (!latest.has(r.userId)) latest.set(r.userId, r.attemptId);
  for (const [userId, attemptId] of latest)
    await notifyUsers([userId], { type: "exam.results_available", title: "Your results are available", body: `Results for “${v.title}” are ready.`, link: `/attempts/${attemptId}/result`, dedupeKey: `results:${v.id}` });
  await db.examVersionState.updateMany({ where: { examVersionId: v.id }, data: { resultsNotifiedAt: clockNow() } });
  return true;
}

/** One sweeper pass: finalize expired attempts, send reminders and release notices that the one-shot jobs missed. */
export async function sweepOnce(): Promise<{ finalized: number; reminders: number; releases: number }> {
  const at = clockNow();
  const finalized = await finalizeExpiredAttempts({ max: 200 });
  const reminderCandidates = await db.examVersion.findMany({
    where: { reminderMinutes: { not: null }, opensAt: { gt: at }, state: { reminderSentAt: null }, exam: { status: "PUBLISHED" } },
    select: { id: true, opensAt: true, reminderMinutes: true }, take: 200,
  });
  let reminders = 0;
  for (const v of reminderCandidates) {
    if (v.opensAt!.getTime() - v.reminderMinutes! * 60_000 <= at.getTime()) {
      await sendReminder(v.id);
      reminders++;
    }
  }
  const releaseCandidates = await db.examVersion.findMany({
    where: { releaseMode: { in: ["AFTER_CLOSE", "AT_TIME"] }, state: { resultsNotifiedAt: null }, publishedAt: { gt: new Date(at.getTime() - 90 * 86_400_000) } },
    select: { id: true, releaseMode: true, closesAt: true, releaseAt: true }, take: 200,
  });
  let releases = 0;
  for (const v of releaseCandidates) if (isReleased(v, at) && (await sendReleaseNotices(v.id))) releases++;
  return { finalized, reminders, releases };
}

const other = (slot: string) => (slot === "a" ? "b" : "a");

/** Examines whether a sweeper chain is already queued; if not, starts one. Called once at server start. */
export async function ensureSweeperScheduled(): Promise<void> {
  const active = await db.job.findFirst({ where: { type: "exam.sweep", status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } });
  if (active) return;
  await enqueue(db, { type: "exam.sweep", payload: { slot: "a" }, dedupeKey: "exam-sweep-a", maxAttempts: 3 });
}

export function examHandlers(): Handlers {
  return {
    "exam.expire": async (job) => {
      const { attemptId } = job.payload as { attemptId: string };
      if (await finalizeIfExpired(attemptId)) return;
      const a = await db.examAttempt.findUnique({ where: { id: attemptId }, select: { status: true, deadlineAt: true } });
      if (a?.status === "IN_PROGRESS") throw new RetryableJobError("deadline not reached yet", Math.max(1000, a.deadlineAt.getTime() + getEnv().EXAM_GRACE_SECONDS * 1000 - clockNow().getTime() + 1000));
    },
    "exam.reminder": async (job) => {
      await sendReminder((job.payload as { versionId: string }).versionId);
    },
    "exam.release": async (job) => {
      const { versionId } = job.payload as { versionId: string };
      if (!(await sendReleaseNotices(versionId))) throw new RetryableJobError("release time not reached yet", 30_000);
    },
    // The chain re-schedules itself in `finally` (alternating dedupe slots, because a running job still holds its own key), so a failing pass never ends it.
    "exam.sweep": async (job) => {
      const slot = (job.payload as { slot?: string }).slot === "b" ? "b" : "a";
      try {
        await sweepOnce();
      } catch (err) {
        logger.error("exam.sweep_failed", { err });
      } finally {
        await enqueue(db, { type: "exam.sweep", payload: { slot: other(slot) }, dedupeKey: `exam-sweep-${other(slot)}`, maxAttempts: 3, runAt: new Date(Date.now() + getEnv().EXAM_SWEEP_INTERVAL_SECONDS * 1000) });
      }
    },
  };
}
