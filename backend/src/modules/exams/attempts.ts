import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { scheduleAutoAnalysis } from "../analysis/service.js";
import { enqueue } from "../jobs/queue.js";
import { notifyUsers } from "../account/notifications.js";
import { checkStart, throwIfNotAllowed } from "./eligibility.js";
import { computeDeadline, fromCenti, gradeAttempt } from "./grading.js";
import { isReleased, releaseTime } from "./release.js";
import { orderOptions, orderQuestions } from "./shuffle.js";
import type { AnswerItem, listAttemptsSchema } from "./schemas.js";

type Tx = Prisma.TransactionClient;
type Reason = "MANUAL" | "TIMEOUT";
type LockedAttempt = { id: string; status: "IN_PROGRESS" | "SUBMITTED" | "TIMED_OUT"; deadlineAt: Date; userId: string; examVersionId: string };
export type FinalizeInfo = { attemptId: string; userId: string; versionId: string; reason: Reason };

const graceMs = () => getEnv().EXAM_GRACE_SECONDS * 1000;
const TX = { timeout: 30_000, maxWait: 10_000 } as const;

/** `SELECT … FOR UPDATE` on the attempt row: serialises submit / expiry / autosave / start (PART4_SPEC §5.4). */
async function lockAttempt(tx: Tx, id: string, userId?: string): Promise<LockedAttempt | null> {
  const rows = userId
    ? await tx.$queryRaw<LockedAttempt[]>`SELECT "id","status","deadlineAt","userId","examVersionId" FROM "ExamAttempt" WHERE "id" = ${id} AND "userId" = ${userId} FOR UPDATE`
    : await tx.$queryRaw<LockedAttempt[]>`SELECT "id","status","deadlineAt","userId","examVersionId" FROM "ExamAttempt" WHERE "id" = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * The one place a score is produced. The caller holds the row lock. Idempotent: a non-IN_PROGRESS attempt is left untouched.
 * Grades only from the published snapshot and the stored option ids.
 */
async function finalizeLocked(tx: Tx, a: LockedAttempt, reason: Reason, at: Date): Promise<FinalizeInfo | null> {
  if (a.status !== "IN_PROGRESS") return null;
  const [questions, answers] = await Promise.all([
    tx.examQuestionSnapshot.findMany({ where: { examVersionId: a.examVersionId }, orderBy: { position: "asc" }, select: { id: true, marksCenti: true, negativeCenti: true, options: { select: { id: true, isCorrect: true } } } }),
    tx.attemptAnswer.findMany({ where: { attemptId: a.id }, select: { examQuestionId: true, selectedOptionId: true } }),
  ]);
  const selected = new Map(answers.map((x) => [x.examQuestionId, x.selectedOptionId]));
  const graded = gradeAttempt(
    questions.map((q) => ({ id: q.id, marksCenti: q.marksCenti, negativeCenti: q.negativeCenti, correctOptionId: q.options.find((o) => o.isCorrect)!.id })),
    selected,
  );
  const result = await tx.examResult.create({
    data: {
      attemptId: a.id, examVersionId: a.examVersionId, userId: a.userId, rawScoreCenti: graded.rawScoreCenti, scoreCenti: graded.scoreCenti, maxCenti: graded.maxCenti, percentBp: graded.percentBp,
      correctCount: graded.correct, incorrectCount: graded.incorrect, unansweredCount: graded.unanswered, band: graded.band, finalizedAt: at,
    },
  });
  await tx.examResultItem.createMany({ data: graded.items.map((i) => ({ resultId: result.id, examQuestionId: i.examQuestionId, selectedOptionId: i.selectedOptionId, outcome: i.outcome, awardedCenti: i.awardedCenti })) });
  await tx.examAttempt.update({ where: { id: a.id }, data: { status: reason === "MANUAL" ? "SUBMITTED" : "TIMED_OUT", submittedAt: reason === "MANUAL" ? at : null, finalizedAt: at } });
  return { attemptId: a.id, userId: a.userId, versionId: a.examVersionId, reason };
}

/** Post-commit side effects (idempotent: notifications carry per-user dedupe keys). Never throws. */
export async function afterFinalized(info: FinalizeInfo | null | undefined): Promise<void> {
  if (!info) return;
  try {
    const v = await db.examVersion.findUnique({ where: { id: info.versionId }, select: { id: true, examId: true, title: true, releaseMode: true, closesAt: true, releaseAt: true } });
    if (!v) return;
    const link = `/attempts/${info.attemptId}/result`;
    await notifyUsers([info.userId], {
      type: "exam.submitted",
      title: "Submission received",
      body: info.reason === "MANUAL" ? `We received your answers for “${v.title}”.` : `Time ran out on “${v.title}”, so your answers were submitted automatically.`,
      link,
      dedupeKey: `attempt-submitted:${info.attemptId}`,
    });
    if (isReleased(v, clockNow())) {
      await notifyUsers([info.userId], { type: "exam.results_available", title: "Your results are available", body: `Results for “${v.title}” are ready.`, link, dedupeKey: `results:${v.id}` });
      const result = await db.examResult.findUnique({ where: { attemptId: info.attemptId }, select: { id: true } });
      if (result) await scheduleAutoAnalysis(result.id); // optional AI feedback; never affects the result
    }
    await recordAudit({ actorId: info.userId, action: "attempt.finalized", targetType: "attempt", targetId: info.attemptId, metadata: { reason: info.reason } });
  } catch (err) {
    logger.error("exam.after_finalize_failed", { attemptId: info.attemptId, err });
  }
}

/** Finalizes one attempt if (and only if) it is still running and its deadline + grace has passed. Used by the expiry job, sweeper and lazy paths. */
export async function finalizeIfExpired(attemptId: string): Promise<boolean> {
  const info = await db.$transaction(async (tx) => {
    const a = await lockAttempt(tx, attemptId);
    if (!a || a.status !== "IN_PROGRESS") return null;
    const at = clockNow();
    if (at.getTime() <= a.deadlineAt.getTime() + graceMs()) return null;
    return finalizeLocked(tx, a, "TIMEOUT", at);
  }, TX);
  await afterFinalized(info);
  return info !== null;
}

/** Bounded batch of expired attempts (optionally limited to one version). */
export async function finalizeExpiredAttempts(opts: { versionId?: string; userId?: string; max?: number } = {}): Promise<number> {
  const cutoff = new Date(clockNow().getTime() - graceMs());
  const due = await db.examAttempt.findMany({
    where: { status: "IN_PROGRESS", deadlineAt: { lt: cutoff }, ...(opts.versionId ? { examVersionId: opts.versionId } : {}), ...(opts.userId ? { userId: opts.userId } : {}) },
    orderBy: { deadlineAt: "asc" },
    take: opts.max ?? 200,
    select: { id: true },
  });
  let n = 0;
  for (const a of due) if (await finalizeIfExpired(a.id)) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------------------------------
export async function attemptView(attemptId: string) {
  const a = await db.examAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: {
      answers: true,
      examVersion: { select: { id: true, examId: true, title: true, totalCenti: true, negativeMarkingBp: true, releaseMode: true, closesAt: true, releaseAt: true } },
    },
  });
  // No `isCorrect` is ever selected here.
  const questions = await db.examQuestionSnapshot.findMany({ where: { examVersionId: a.examVersionId }, orderBy: { position: "asc" }, select: { id: true, position: true, stem: true, marksCenti: true, options: { orderBy: { position: "asc" }, select: { id: true, text: true } } } });
  const byId = new Map(questions.map((q) => [q.id, q]));
  const stored = Array.isArray(a.questionOrder) ? (a.questionOrder as string[]).filter((id) => byId.has(id)) : [];
  const order = [...stored, ...questions.map((q) => q.id).filter((id) => !stored.includes(id))];
  const optOrder = (a.optionOrder ?? {}) as Record<string, string[]>;
  const serverNow = clockNow();
  const rel = a.examVersion;
  return {
    id: a.id,
    examId: rel.examId,
    examTitle: rel.title,
    status: a.status,
    attemptNo: a.attemptNo,
    startedAt: a.startedAt.toISOString(),
    deadlineAt: a.deadlineAt.toISOString(),
    serverNow: serverNow.toISOString(),
    remainingMs: a.status === "IN_PROGRESS" ? Math.max(0, a.deadlineAt.getTime() - serverNow.getTime()) : 0,
    finalizedAt: a.finalizedAt?.toISOString() ?? null,
    totalMarks: fromCenti(rel.totalCenti),
    negativeMarking: rel.negativeMarkingBp > 0,
    questions: order.map((qid, i) => {
      const q = byId.get(qid)!;
      const ids = (optOrder[qid] ?? []).filter((o) => q.options.some((x) => x.id === o));
      const optIds = [...ids, ...q.options.map((o) => o.id).filter((o) => !ids.includes(o))];
      return { id: q.id, position: i + 1, stem: q.stem, options: optIds.map((oid) => ({ id: oid, text: q.options.find((o) => o.id === oid)!.text })), marks: fromCenti(q.marksCenti) };
    }),
    answers: Object.fromEntries(a.answers.map((x) => [x.examQuestionId, { optionId: x.selectedOptionId, marked: x.markedForReview, seq: x.seq, savedAt: x.updatedAt.toISOString() }])),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Start / resume
// ---------------------------------------------------------------------------------------------------------------------
export async function startAttempt(user: SessionUser, examId: string) {
  await enforceRateLimit({ key: `attempt-start:${user.id}`, limit: 20, windowSec: 60 });
  const exam = await db.exam.findUnique({ where: { id: examId }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  const v = exam?.versions[0];
  if (!exam || !v || exam.status === "DRAFT") throw Errors.notFound();
  if (exam.ownerId !== user.id) {
    // individual exams belong to their author; group exams are visible to members only
    const member = exam.mode === "GROUP" && exam.groupId ? await db.groupMember.findUnique({ where: { groupId_userId: { groupId: exam.groupId, userId: user.id } }, select: { userId: true } }) : null;
    if (!member) throw Errors.notFound();
  }

  type Outcome = { kind: "resume" | "created"; attemptId: string; info: FinalizeInfo | null } | { kind: "denied"; check: Awaited<ReturnType<typeof checkStart>>; info: FinalizeInfo | null };
  const outcome = await db.$transaction(async (tx): Promise<Outcome> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attempt:${v.id}:${user.id}`}, 0))`;
    let info: FinalizeInfo | null = null;
    const running = await tx.examAttempt.findFirst({ where: { examVersionId: v.id, userId: user.id, status: "IN_PROGRESS" } });
    const at = clockNow();
    if (running) {
      if (at.getTime() <= running.deadlineAt.getTime() + graceMs()) return { kind: "resume", attemptId: running.id, info: null };
      const locked = await lockAttempt(tx, running.id);
      if (locked) info = await finalizeLocked(tx, locked, "TIMEOUT", at);
    }
    const check = await checkStart(user.id, exam, v, at, tx);
    if (!check.allowed) return { kind: "denied", check, info };
    const agg = await tx.examAttempt.aggregate({ where: { examVersionId: v.id, userId: user.id }, _max: { attemptNo: true } });
    const attemptNo = (agg._max.attemptNo ?? 0) + 1;
    const qs = await tx.examQuestionSnapshot.findMany({ where: { examVersionId: v.id }, orderBy: { position: "asc" }, select: { id: true, options: { orderBy: { position: "asc" }, select: { id: true } } } });
    const seedInfo = { examVersionId: v.id, userId: user.id, attemptNo };
    const questionOrder = orderQuestions(qs.map((q) => q.id), seedInfo, v.shuffleQuestions);
    const optionOrder = Object.fromEntries(qs.map((q) => [q.id, orderOptions(q.options.map((o) => o.id), q.id, seedInfo, v.shuffleOptions)]));
    let created;
    try {
      created = await tx.examAttempt.create({
        data: { examVersionId: v.id, userId: user.id, attemptNo, status: "IN_PROGRESS", startedAt: at, deadlineAt: computeDeadline(at, v.durationSeconds, v.closesAt), questionOrder, optionOrder },
      });
    } catch (err) {
      if (String((err as Error).message).includes("attempt limit")) return { kind: "denied", check: { allowed: false, code: "ATTEMPT_LIMIT", reason: "You've used all attempts for this exam." }, info };
      throw err;
    }
    await enqueue(tx, {
      type: "exam.expire", payload: { attemptId: created.id }, dedupeKey: `exam-expire:${created.id}`, runAt: new Date(created.deadlineAt.getTime() + graceMs() + 1000),
    });
    return { kind: "created", attemptId: created.id, info };
  }, TX);

  await afterFinalized(outcome.info);
  if (outcome.kind === "denied") throwIfNotAllowed(outcome.check);
  if (outcome.kind === "denied") throw Errors.notFound(); // unreachable (throwIfNotAllowed throws for a denied check)
  if (outcome.kind === "created") await recordAudit({ actorId: user.id, action: "attempt.started", targetType: "attempt", targetId: outcome.attemptId });
  return { attempt: await attemptView(outcome.attemptId), resumed: outcome.kind === "resume" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------------------------
async function ownedAttempt(user: SessionUser, id: string) {
  const a = await db.examAttempt.findFirst({ where: { id, userId: user.id }, select: { id: true, status: true, deadlineAt: true } });
  if (!a) throw Errors.notFound(); // foreign ids are indistinguishable from missing ones
  return a;
}

export async function getAttempt(user: SessionUser, id: string) {
  const a = await ownedAttempt(user, id);
  if (a.status === "IN_PROGRESS") await finalizeIfExpired(id); // lazy finalization
  return { attempt: await attemptView(id) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Autosave / submit
// ---------------------------------------------------------------------------------------------------------------------
type Saved = { questionId: string; seq: number; savedAt: string; stale: boolean };

async function applyItems(tx: Tx, a: LockedAttempt, items: AnswerItem[], at: Date): Promise<Saved[]> {
  const qs = await tx.examQuestionSnapshot.findMany({ where: { examVersionId: a.examVersionId }, select: { id: true, options: { select: { id: true } } } });
  const opts = new Map(qs.map((q) => [q.id, new Set(q.options.map((o) => o.id))]));
  const fields: Record<string, string> = {};
  items.forEach((it, i) => {
    const o = opts.get(it.questionId);
    if (!o) fields[`answers.${i}.questionId`] = "That question isn't part of this exam.";
    else if (it.optionId !== null && !o.has(it.optionId)) fields[`answers.${i}.optionId`] = "That option doesn't belong to the question.";
  });
  if (Object.keys(fields).length) throw new AppError("VALIDATION", "Some answers are invalid.", { fields });

  const existing = new Map((await tx.attemptAnswer.findMany({ where: { attemptId: a.id, examQuestionId: { in: [...new Set(items.map((i) => i.questionId))] } } })).map((r) => [r.examQuestionId, r]));
  const saved: Saved[] = [];
  for (const it of items) {
    const cur = existing.get(it.questionId);
    if (cur && it.seq <= cur.seq) {
      saved.push({ questionId: it.questionId, seq: cur.seq, savedAt: cur.updatedAt.toISOString(), stale: true });
      continue;
    }
    const row = cur
      ? await tx.attemptAnswer.update({ where: { attemptId_examQuestionId: { attemptId: a.id, examQuestionId: it.questionId } }, data: { selectedOptionId: it.optionId, markedForReview: it.marked ?? cur.markedForReview, seq: it.seq, updatedAt: at } })
      : await tx.attemptAnswer.create({ data: { attemptId: a.id, examQuestionId: it.questionId, selectedOptionId: it.optionId, markedForReview: it.marked ?? false, seq: it.seq, updatedAt: at } });
    existing.set(it.questionId, row);
    saved.push({ questionId: it.questionId, seq: row.seq, savedAt: at.toISOString(), stale: false });
  }
  await tx.examAttempt.update({ where: { id: a.id }, data: { lastSavedAt: at } });
  return saved;
}

export async function saveAnswers(user: SessionUser, attemptId: string, items: AnswerItem[]) {
  await enforceRateLimit({ key: `autosave:${attemptId}`, limit: 240, windowSec: 60 });
  type Outcome = { kind: "ok"; saved: Saved[]; deadlineAt: Date } | { kind: "final" } | { kind: "expired"; info: FinalizeInfo | null };
  const out = await db.$transaction(async (tx): Promise<Outcome> => {
    const a = await lockAttempt(tx, attemptId, user.id);
    if (!a) throw Errors.notFound();
    const at = clockNow();
    if (a.status !== "IN_PROGRESS") return { kind: "final" };
    if (at.getTime() > a.deadlineAt.getTime() + graceMs()) return { kind: "expired", info: await finalizeLocked(tx, a, "TIMEOUT", at) };
    return { kind: "ok", saved: await applyItems(tx, a, items, at), deadlineAt: a.deadlineAt };
  }, TX);
  if (out.kind === "final") throw new AppError("ATTEMPT_EXPIRED", "This attempt has already been submitted.", { finalized: true });
  if (out.kind === "expired") {
    await afterFinalized(out.info);
    throw new AppError("ATTEMPT_EXPIRED", "Time is up. Your saved answers were submitted.", { finalized: true, timedOut: true });
  }
  const serverNow = clockNow();
  return { saved: out.saved, serverNow: serverNow.toISOString(), deadlineAt: out.deadlineAt.toISOString(), remainingMs: Math.max(0, out.deadlineAt.getTime() - serverNow.getTime()) };
}

/** Manual submit. Returns whether the attempt had already been finalized (idempotent) so the caller can build the result payload. */
export async function submitAttempt(user: SessionUser, attemptId: string, items: AnswerItem[] | undefined): Promise<{ alreadyFinalized: boolean }> {
  await enforceRateLimit({ key: `attempt-submit:${user.id}`, limit: 20, windowSec: 60 });
  const out = await db.$transaction(async (tx) => {
    const a = await lockAttempt(tx, attemptId, user.id);
    if (!a) throw Errors.notFound();
    if (a.status !== "IN_PROGRESS") return { already: true, info: null as FinalizeInfo | null };
    const at = clockNow();
    if (at.getTime() <= a.deadlineAt.getTime() + graceMs()) {
      if (items?.length) await applyItems(tx, a, items, at);
      return { already: false, info: await finalizeLocked(tx, a, "MANUAL", at) };
    }
    return { already: false, info: await finalizeLocked(tx, a, "TIMEOUT", at) }; // late: the outcome is reported, not an error
  }, TX);
  await afterFinalized(out.info);
  return { alreadyFinalized: out.already };
}

/** Marks the user's own expired attempts as finalized before listing (lazy finalization, bounded). */
export async function listAttempts(user: SessionUser, q: z.infer<typeof listAttemptsSchema>, examId?: string) {
  await finalizeExpiredAttempts({ userId: user.id, max: 50 });
  const where: Prisma.ExamAttemptWhereInput = { userId: user.id, ...(q.status ? { status: q.status } : {}), ...(examId ? { examVersion: { examId } } : {}) };
  const [total, rows] = await Promise.all([
    db.examAttempt.count({ where }),
    db.examAttempt.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      include: { result: true, examVersion: { select: { id: true, examId: true, title: true, releaseMode: true, closesAt: true, releaseAt: true } } },
    }),
  ]);
  const at = clockNow();
  return {
    items: rows.map((a) => {
      const released = isReleased(a.examVersion, at);
      return {
        id: a.id, examId: a.examVersion.examId, examTitle: a.examVersion.title, attemptNo: a.attemptNo, status: a.status, startedAt: a.startedAt.toISOString(), finalizedAt: a.finalizedAt?.toISOString() ?? null,
        result: a.result && released
          ? { released: true, scoreCenti: a.result.scoreCenti, maxCenti: a.result.maxCenti, percentBp: a.result.percentBp, band: a.result.band }
          : { released, ...(a.status === "IN_PROGRESS" ? {} : { releasesAt: releaseTime(a.examVersion)?.toISOString() ?? null }) },
      };
    }),
    total, page: q.page, pageSize: q.pageSize,
  };
}
