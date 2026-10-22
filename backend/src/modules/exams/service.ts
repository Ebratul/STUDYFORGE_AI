import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { db } from "../../lib/db.js";
import { now as clockNow } from "../../lib/clock.js";
import { AppError, Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { getEnv } from "../../config/env.js";
import { enqueue } from "../jobs/queue.js";
import { notifyUsers } from "../account/notifications.js";
import { questionInclude, type QuestionRow } from "../questions/content.js";
import { normKey } from "../questions/text.js";
import { checkStart, requireGroupStaff, type StartCheck } from "./eligibility.js";
import { fractionToBp, fromCenti, negativeCenti as negCenti, toCenti } from "./grading.js";
import { EXAM_FIELDS } from "./limits.js";
import { listReleasedResults, releasedTotals } from "../analytics/sources.js";
import { isReleased, releaseTime } from "./release.js";
import { createExamSchema, examDraftSchema, listExamsSchema, type ExamDraft } from "./schemas.js";
import { snapshotHash, verifySnapshot, type SnapshotHeader, type SnapshotQuestion } from "./snapshot.js";

type CreateInput = z.infer<typeof createExamSchema>;
type ListQuery = z.infer<typeof listExamsSchema>;
type Issue = { path: string; message: string; severity: "error" | "warning" };

const fieldError = (message: string, fields: Record<string, string>) => new AppError("VALIDATION", message, { fields });

const examInclude = { group: { select: { id: true, title: true } }, versions: { orderBy: { version: "desc" }, take: 1 } } satisfies Prisma.ExamInclude;
type ExamRow = Prisma.ExamGetPayload<{ include: typeof examInclude }>;

const asDraft = (json: Prisma.JsonValue): ExamDraft => examDraftSchema().parse(json);

// ---------------------------------------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------------------------------------
export type MyAttempts = { used: number; limit: number; inProgressAttemptId: string | null; bestPercentBp: number | null };

/** Attempt counters for one user across the given versions. `bestPercentBp` only counts results that are already released. */
async function myAttemptStats(userId: string, versions: { id: string; attemptLimit: number; releaseMode: "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME"; closesAt: Date | null; releaseAt: Date | null }[]): Promise<Map<string, MyAttempts>> {
  const out = new Map<string, MyAttempts>();
  if (!versions.length) return out;
  const ids = versions.map((v) => v.id);
  const [attempts, results] = await Promise.all([
    db.examAttempt.findMany({ where: { examVersionId: { in: ids }, userId }, select: { id: true, examVersionId: true, status: true } }),
    db.examResult.findMany({ where: { examVersionId: { in: ids }, userId }, select: { examVersionId: true, percentBp: true } }),
  ]);
  const now = clockNow();
  for (const v of versions) {
    const mine = attempts.filter((a) => a.examVersionId === v.id);
    const released = isReleased(v, now);
    const best = released ? results.filter((r) => r.examVersionId === v.id).reduce<number | null>((m, r) => (m === null || r.percentBp > m ? r.percentBp : m), null) : null;
    out.set(v.id, { used: mine.length, limit: v.attemptLimit, inProgressAttemptId: mine.find((a) => a.status === "IN_PROGRESS")?.id ?? null, bestPercentBp: best });
  }
  return out;
}

export function toSummary(e: ExamRow, mine?: MyAttempts) {
  const v = e.versions[0];
  const draft = e.status === "DRAFT" ? asDraft(e.draft) : null;
  const draftTotal = draft ? draft.questionIds.reduce((s, qid) => s + toCenti(draft.marks.overrides[qid] ?? draft.marks.perQuestion), 0) : 0;
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    mode: e.mode,
    status: e.status,
    group: e.group,
    questionCount: v ? v.questionCount : (draft?.questionIds.length ?? 0),
    totalMarks: v ? fromCenti(v.totalCenti) : draft && draft.questionIds.length ? fromCenti(draftTotal) : null,
    durationMinutes: v ? v.durationSeconds / 60 : (draft?.durationMinutes ?? null),
    opensAt: (v ? v.opensAt?.toISOString() : draft?.window.opensAt) ?? null,
    closesAt: (v ? v.closesAt?.toISOString() : draft?.window.closesAt) ?? null,
    publishedAt: e.publishedAt?.toISOString() ?? null,
    updatedAt: e.updatedAt.toISOString(),
    ...(mine ? { myAttempts: mine } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Create / draft
// ---------------------------------------------------------------------------------------------------------------------
export async function createExam(user: SessionUser, input: CreateInput) {
  const env = getEnv();
  if ((await db.exam.count({ where: { ownerId: user.id } })) >= env.EXAM_MAX_DRAFTS_PER_USER)
    throw new AppError("QUOTA_EXCEEDED", `You can have up to ${env.EXAM_MAX_DRAFTS_PER_USER} exams. Delete some drafts to make room.`, { limit: env.EXAM_MAX_DRAFTS_PER_USER });
  if (input.mode === "GROUP") {
    if (!input.groupId) throw fieldError("Choose a group.", { groupId: "Choose the group this exam is for." });
    await requireGroupStaff(user.id, input.groupId);
  } else if (input.groupId) throw fieldError("An individual exam has no group.", { groupId: "Remove the group or choose “Group exam”." });
  const draft = examDraftSchema().parse({ title: input.title, description: input.description });
  const exam = await db.exam.create({
    data: { ownerId: user.id, groupId: input.mode === "GROUP" ? input.groupId! : null, mode: input.mode, title: draft.title, description: draft.description, draft: draft as unknown as Prisma.InputJsonValue },
    include: examInclude,
  });
  await recordAudit({ actorId: user.id, action: "exam.created", targetType: "exam", targetId: exam.id, metadata: { mode: exam.mode } });
  return toSummary(exam);
}

async function authoredExam(userId: string, id: string, client: Prisma.TransactionClient | typeof db = db): Promise<ExamRow> {
  const e = await client.exam.findFirst({ where: { id, ownerId: userId }, include: examInclude });
  if (!e) throw Errors.notFound();
  return e;
}

async function bankQuestions(userId: string, ids: string[], client: Prisma.TransactionClient | typeof db = db) {
  const rows = ids.length ? await client.question.findMany({ where: { id: { in: ids }, ownerId: userId }, include: questionInclude }) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

export async function saveDraft(user: SessionUser, id: string, input: ExamDraft) {
  const exam = await authoredExam(user.id, id);
  if (exam.status !== "DRAFT") throw new AppError("CONFLICT", "A published exam can't be edited. Duplicate it to make changes.");
  const rows = await bankQuestions(user.id, input.questionIds);
  const fields: Record<string, string> = {};
  input.questionIds.forEach((qid, i) => {
    const r = rows.get(qid);
    if (!r) fields[`questionIds.${i}`] = "This question wasn't found in your question bank.";
    else if (r.kind !== "MCQ") fields[`questionIds.${i}`] = "Only multiple-choice questions can be used in an exam.";
  });
  if (Object.keys(fields).length) throw fieldError("Some questions can't be used.", fields);
  const updated = await db.exam.update({ where: { id }, data: { title: input.title, description: input.description, draft: input as unknown as Prisma.InputJsonValue }, include: examInclude });
  return manageView(updated);
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation (preview + publish share it)
// ---------------------------------------------------------------------------------------------------------------------
type Evaluation = { issues: Issue[]; rows: QuestionRow[]; marksCenti: number[]; negCenti: number[]; totalCenti: number };

function evaluate(exam: { mode: "INDIVIDUAL" | "GROUP" }, draft: ExamDraft, bank: Map<string, QuestionRow>, at: Date): Evaluation {
  const env = getEnv();
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: "error" });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: "warning" });
  const rows: QuestionRow[] = [];
  const marksCenti: number[] = [];
  const negCenti_: number[] = [];

  if (draft.questionIds.length === 0) err("questionIds", "Add at least one question.");
  if (draft.questionIds.length > env.EXAM_MAX_QUESTIONS) err("questionIds", `An exam can have up to ${env.EXAM_MAX_QUESTIONS} questions.`);
  const fractionBp = fractionToBp(draft.negativeMarking.fraction);
  draft.questionIds.forEach((qid, i) => {
    const r = bank.get(qid);
    const at_ = `questionIds.${i}`;
    if (!r) return err(at_, "This question wasn't found in your question bank.");
    if (r.kind !== "MCQ") return err(at_, "Only multiple-choice questions can be used in an exam.");
    const correct = r.options.filter((o) => o.isCorrect);
    if (r.options.length < EXAM_FIELDS.optionsMin || r.options.length > EXAM_FIELDS.optionsMax) return err(at_, `A question needs ${EXAM_FIELDS.optionsMin}–${EXAM_FIELDS.optionsMax} options.`);
    if (correct.length !== 1) return err(at_, "This question doesn't have exactly one correct answer. Fix it in your question bank.");
    if (r.options.some((o) => !o.text.trim())) return err(at_, "This question has an empty option.");
    if (new Set(r.options.map((o) => normKey(o.text))).size !== r.options.length) return err(at_, "This question has duplicate options.");
    const m = toCenti(draft.marks.overrides[qid] ?? draft.marks.perQuestion);
    if (m <= 0 || m > EXAM_FIELDS.marksMax * 100) return err(at_, "Marks must be between 0.25 and 100.");
    rows.push(r);
    marksCenti.push(m);
    negCenti_.push(negCenti(m, fractionBp));
  });

  const { opensAt, closesAt } = draft.window;
  const opens = opensAt ? new Date(opensAt) : null;
  const closes = closesAt ? new Date(closesAt) : null;
  if (opens && closes && closes <= opens) err("window.closesAt", "The closing time must be after the opening time.");
  if (closes && closes <= at) err("window.closesAt", "The closing time must be in the future.");
  const durationMs = draft.durationMinutes * 60_000;
  if (draft.lateStart === "FULL_TIME_ONLY" && closes) {
    const earliest = opens && opens > at ? opens : at;
    if (closes.getTime() - earliest.getTime() < durationMs) err("window.closesAt", "The window is shorter than the exam duration, so nobody could start with full time. Extend the window or shorten the exam.");
  }
  if (draft.lateStart === "CAP_AT_CLOSE" && opens && closes && closes.getTime() - opens.getTime() < durationMs) warn("window", "The window is shorter than the duration: everyone's time is capped at the closing time.");
  if (draft.release.mode === "AFTER_CLOSE" && !closes) err("release.mode", "“After the exam closes” needs a closing time.");
  if (draft.release.mode === "AT_TIME") {
    if (!draft.release.at) err("release.at", "Choose when results are released.");
    else if (closes && new Date(draft.release.at) < closes) err("release.at", "Results can't be released before the exam closes.");
  }
  if (draft.reminderMinutes) {
    if (!opens) err("reminderMinutes", "A reminder needs an opening time.");
    else if (opens <= at) err("reminderMinutes", "The opening time must be in the future to send a reminder.");
  }
  if (exam.mode === "GROUP" && draft.release.mode === "IMMEDIATE" && draft.reviewPolicy !== "NONE")
    warn("reviewPolicy", "Participants will see their results and answers as soon as they submit, while other members may still be taking the exam.");
  if (exam.mode === "GROUP" && draft.attemptLimit > 1) warn("attemptLimit", "With more than one attempt per member, the leaderboard ranks each member's best attempt.");
  if (exam.mode === "INDIVIDUAL" && (draft.leaderboardVisible || !draft.lateJoinGroup)) warn("mode", "Leaderboard and late-join settings only apply to group exams.");
  if (draft.shuffleOptions && !draft.shuffleQuestions) warn("shuffleQuestions", "Options are shuffled but the question order is the same for everyone.");

  return { issues, rows, marksCenti, negCenti: negCenti_, totalCenti: marksCenti.reduce((a, b) => a + b, 0) };
}

export async function previewExam(user: SessionUser, id: string) {
  const exam = await authoredExam(user.id, id);
  if (exam.status !== "DRAFT") throw new AppError("CONFLICT", "Only a draft can be previewed.");
  const draft = asDraft(exam.draft);
  const ev = evaluate(exam, draft, await bankQuestions(user.id, draft.questionIds), clockNow());
  const negs = ev.negCenti.map(fromCenti);
  return {
    canPublish: !ev.issues.some((i) => i.severity === "error"),
    issues: ev.issues,
    totals: { questionCount: ev.rows.length, totalMarks: fromCenti(ev.totalCenti), negativePerWrongRange: { min: negs.length ? Math.min(...negs) : 0, max: negs.length ? Math.max(...negs) : 0 } },
    questions: ev.rows.map((r, i) => ({
      position: i + 1, id: r.id, stem: r.stem, options: r.options.map((o) => ({ id: o.id, text: o.text })), correctOptionId: r.options.find((o) => o.isCorrect)?.id ?? null,
      marks: fromCenti(ev.marksCenti[i]!), negativeMarks: fromCenti(ev.negCenti[i]!), topic: r.topic,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------------------------------------------------
export async function publishExam(user: SessionUser, id: string) {
  const at = clockNow();
  const result = await db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Exam" WHERE "id" = ${id} AND "ownerId" = ${user.id} FOR UPDATE`;
      if (!locked.length) throw Errors.notFound();
      const exam = await authoredExam(user.id, id, tx);
      if (exam.status !== "DRAFT") throw new AppError("CONFLICT", exam.status === "PUBLISHED" ? "This exam is already published." : "This exam was cancelled.");
      if (exam.mode === "GROUP") {
        if (!exam.groupId) throw Errors.notFound();
        await requireGroupStaff(user.id, exam.groupId, tx);
      }
      const draft = asDraft(exam.draft);
      const ev = evaluate(exam, draft, await bankQuestions(user.id, draft.questionIds, tx), at);
      const errors = ev.issues.filter((i) => i.severity === "error");
      if (errors.length) {
        const fields: Record<string, string> = {};
        for (const i of errors) fields[i.path] ??= i.message;
        throw fieldError("Fix these problems before publishing.", fields);
      }
      const group = exam.mode === "GROUP";
      const header: SnapshotHeader = {
        title: draft.title, description: draft.description, mode: exam.mode, groupId: exam.groupId, durationSeconds: draft.durationMinutes * 60, attemptLimit: draft.attemptLimit,
        opensAt: draft.window.opensAt ? new Date(draft.window.opensAt) : null, closesAt: draft.window.closesAt ? new Date(draft.window.closesAt) : null,
        shuffleQuestions: draft.shuffleQuestions, shuffleOptions: draft.shuffleOptions, reviewPolicy: draft.reviewPolicy, releaseMode: draft.release.mode,
        releaseAt: draft.release.mode === "AT_TIME" && draft.release.at ? new Date(draft.release.at) : null, lateStart: draft.lateStart, lateJoinGroup: group ? draft.lateJoinGroup : false,
        leaderboardVisible: group ? draft.leaderboardVisible : false, reminderMinutes: draft.reminderMinutes, negativeMarkingBp: fractionToBp(draft.negativeMarking.fraction),
        questionCount: ev.rows.length, totalCenti: ev.totalCenti,
      };
      const snapQuestions: SnapshotQuestion[] = ev.rows.map((r, i) => ({
        position: i, sourceQuestionId: r.id, sourceQuestionVersion: r.version, stem: r.stem, explanation: r.explanation, shortNote: r.shortNote, topic: r.topic, subject: r.subject,
        difficulty: r.difficulty, language: r.language, marksCenti: ev.marksCenti[i]!, negativeCenti: ev.negCenti[i]!,
        sources: r.sources.map((s) => ({ documentName: s.documentName, page: s.page, section: s.section, quote: s.quote, quoteVerified: s.quoteVerified })),
        options: r.options.map((o, k) => ({ position: k, text: o.text, isCorrect: o.isCorrect })),
      }));
      const hash = snapshotHash(header, snapQuestions);
      const version = await tx.examVersion.create({
        data: {
          examId: exam.id, version: 1, ...header, mode: exam.mode, reviewPolicy: draft.reviewPolicy, releaseMode: draft.release.mode, lateStart: draft.lateStart,
          snapshotHash: hash, publishedById: user.id, publishedAt: at,
        },
      });
      for (const q of snapQuestions)
        await tx.examQuestionSnapshot.create({
          data: { examVersionId: version.id, ...q, sources: q.sources as Prisma.InputJsonValue, difficulty: q.difficulty as never, language: q.language as never, options: { create: q.options } },
        });
      await tx.examVersionState.create({ data: { examVersionId: version.id } });
      const updated = await tx.exam.update({ where: { id: exam.id }, data: { status: "PUBLISHED", currentVersion: 1, publishedAt: at, title: draft.title, description: draft.description }, include: examInclude });
      return { exam: updated, version };
    },
    { timeout: 30_000 },
  );

  await recordAudit({ actorId: user.id, action: "exam.published", targetType: "exam", targetId: result.exam.id, metadata: { mode: result.exam.mode, questions: result.version.questionCount } });
  await afterPublish(result.exam, result.version, user.id);
  return toSummary(result.exam);
}

/** Post-commit, idempotent: notify the group and schedule reminder/release jobs. Failures are logged; the sweeper recovers them. */
async function afterPublish(exam: ExamRow, v: Prisma.ExamVersionGetPayload<object>, authorId: string) {
  try {
    if (exam.mode === "GROUP" && exam.groupId) {
      const members = await db.groupMember.findMany({ where: { groupId: exam.groupId, userId: { not: authorId } }, select: { userId: true } });
      await notifyUsers(members.map((m) => m.userId), {
        type: "exam.group_published", title: "New group exam", body: `“${exam.title}” was published${exam.group ? ` in ${exam.group.title}` : ""}.`, link: `/exams/${exam.id}`, dedupeKey: `exam-published:${v.id}`,
      });
      await db.examVersionState.update({ where: { examVersionId: v.id }, data: { publishNotifiedAt: new Date() } });
    }
    if (v.reminderMinutes && v.opensAt) {
      const runAt = new Date(Math.max(clockNow().getTime(), v.opensAt.getTime() - v.reminderMinutes * 60_000));
      await enqueue(db, { type: "exam.reminder", payload: { versionId: v.id }, dedupeKey: `exam-reminder:${v.id}`, runAt });
    }
    const rel = releaseTime(v);
    if (v.releaseMode !== "IMMEDIATE" && rel) await enqueue(db, { type: "exam.release", payload: { versionId: v.id }, dedupeKey: `exam-release:${v.id}`, runAt: rel });
  } catch (err) {
    logger.error("exam.after_publish_failed", { examId: exam.id, err });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cancel / duplicate / delete
// ---------------------------------------------------------------------------------------------------------------------
export async function cancelExam(user: SessionUser, id: string) {
  const exam = await authoredExam(user.id, id);
  if (exam.status === "DRAFT") throw new AppError("CONFLICT", "A draft can be deleted instead of cancelled.");
  if (exam.status === "CANCELLED") return toSummary(exam);
  const updated = await db.exam.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: clockNow() }, include: examInclude });
  await recordAudit({ actorId: user.id, action: "exam.cancelled", targetType: "exam", targetId: id });
  return toSummary(updated);
}

export async function duplicateExam(user: SessionUser, id: string) {
  const env = getEnv();
  const exam = await authoredExam(user.id, id);
  if ((await db.exam.count({ where: { ownerId: user.id } })) >= env.EXAM_MAX_DRAFTS_PER_USER) throw new AppError("QUOTA_EXCEEDED", `You can have up to ${env.EXAM_MAX_DRAFTS_PER_USER} exams.`, { limit: env.EXAM_MAX_DRAFTS_PER_USER });
  if (exam.mode === "GROUP" && exam.groupId) await requireGroupStaff(user.id, exam.groupId);
  const draft = asDraft(exam.draft); // for a published exam this is the configuration it was published from
  const title = `${draft.title} (copy)`.slice(0, EXAM_FIELDS.title);
  const copy = { ...draft, title, window: { opensAt: null, closesAt: null }, release: { mode: draft.release.mode === "AT_TIME" ? ("IMMEDIATE" as const) : draft.release.mode, at: null } };
  const created = await db.exam.create({
    data: { ownerId: user.id, groupId: exam.groupId, mode: exam.mode, title, description: exam.description, draft: examDraftSchema().parse(copy) as unknown as Prisma.InputJsonValue },
    include: examInclude,
  });
  await recordAudit({ actorId: user.id, action: "exam.created", targetType: "exam", targetId: created.id, metadata: { duplicatedFrom: id } });
  return toSummary(created);
}

export async function deleteExam(user: SessionUser, id: string) {
  const exam = await authoredExam(user.id, id);
  if (exam.status !== "DRAFT") {
    const attempts = await db.examAttempt.count({ where: { examVersion: { examId: id } } });
    if (attempts > 0) throw new AppError("CONFLICT", "This exam has attempts, so it can't be deleted. Cancel it instead.");
  }
  await db.exam.delete({ where: { id } });
  await recordAudit({ actorId: user.id, action: "exam.deleted", targetType: "exam", targetId: id });
}

// ---------------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------------
async function manageView(exam: ExamRow) {
  const v = exam.versions[0] ?? null;
  const draft = asDraft(exam.draft);
  let questions: { id: string; stem: string; options: { id: string; text: string }[]; correctOptionId: string | null; topic: string | null; marks: number }[];
  let integrity: "OK" | "MISMATCH" | null = null;
  let attemptsCount = 0;
  if (v) {
    const qs = await db.examQuestionSnapshot.findMany({ where: { examVersionId: v.id }, orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } });
    questions = qs.map((q) => ({ id: q.id, stem: q.stem, options: q.options.map((o) => ({ id: o.id, text: o.text })), correctOptionId: q.options.find((o) => o.isCorrect)?.id ?? null, topic: q.topic, marks: fromCenti(q.marksCenti) }));
    integrity = await verifySnapshot(v.id);
    attemptsCount = await db.examAttempt.count({ where: { examVersionId: v.id } });
  } else {
    const bank = await bankQuestions(exam.ownerId, draft.questionIds);
    questions = draft.questionIds.flatMap((qid) => {
      const r = bank.get(qid);
      return r ? [{ id: r.id, stem: r.stem, options: r.options.map((o) => ({ id: o.id, text: o.text })), correctOptionId: r.options.find((o) => o.isCorrect)?.id ?? null, topic: r.topic, marks: draft.marks.overrides[qid] ?? draft.marks.perQuestion }] : [];
    });
  }
  return {
    ...toSummary(exam),
    role: "AUTHOR" as const,
    draft,
    currentVersion: exam.currentVersion,
    cancelledAt: exam.cancelledAt?.toISOString() ?? null,
    questions,
    version: v
      ? {
          id: v.id, version: v.version, questionCount: v.questionCount, totalMarks: fromCenti(v.totalCenti), durationMinutes: v.durationSeconds / 60, attemptLimit: v.attemptLimit, opensAt: v.opensAt?.toISOString() ?? null,
          closesAt: v.closesAt?.toISOString() ?? null, shuffleQuestions: v.shuffleQuestions, shuffleOptions: v.shuffleOptions, reviewPolicy: v.reviewPolicy, releaseMode: v.releaseMode,
          releaseAt: v.releaseAt?.toISOString() ?? null, lateStart: v.lateStart, lateJoinGroup: v.lateJoinGroup, leaderboardVisible: v.leaderboardVisible, reminderMinutes: v.reminderMinutes,
          negativeMarkingFraction: v.negativeMarkingBp / 10_000, snapshotHash: v.snapshotHash, publishedAt: v.publishedAt.toISOString(),
        }
      : null,
    snapshotIntegrity: integrity,
    attemptsCount,
  };
}

const POLICY_TEXT = {
  review: { NONE: "You'll see your score only.", CORRECTNESS: "You'll see which answers were right or wrong, but not the correct answers.", FULL: "You'll see the correct answers, explanations and notes." },
} as const;

async function takeView(user: SessionUser, exam: ExamRow, member: boolean) {
  const v = exam.versions[0];
  if (!v) throw Errors.notFound();
  const at = clockNow();
  const stats = (await myAttemptStats(user.id, [v])).get(v.id)!;
  const attempts = await db.examAttempt.findMany({ where: { examVersionId: v.id, userId: user.id }, orderBy: { attemptNo: "asc" }, select: { id: true, attemptNo: true, status: true, startedAt: true, finalizedAt: true, deadlineAt: true } });
  let canStart: StartCheck & { resumeAttemptId?: string } = await checkStart(user.id, exam, v, at);
  const running = attempts.find((a) => a.status === "IN_PROGRESS");
  if (running && at.getTime() <= running.deadlineAt.getTime() + getEnv().EXAM_GRACE_SECONDS * 1000) canStart = { allowed: true, resumeAttemptId: running.id };
  return {
    ...toSummary(exam, stats),
    role: "PARTICIPANT" as const,
    isMember: member,
    attemptLimit: v.attemptLimit,
    negativeMarking: v.negativeMarkingBp > 0,
    policies: {
      shuffleQuestions: v.shuffleQuestions, shuffleOptions: v.shuffleOptions, reviewPolicy: v.reviewPolicy, reviewPolicyText: POLICY_TEXT.review[v.reviewPolicy], lateStart: v.lateStart,
      leaderboardVisible: v.leaderboardVisible, release: { mode: v.releaseMode, releasesAt: releaseTime(v)?.toISOString() ?? null },
    },
    attempts: attempts.map((a) => ({ id: a.id, attemptNo: a.attemptNo, status: a.status, startedAt: a.startedAt.toISOString(), finalizedAt: a.finalizedAt?.toISOString() ?? null })),
    canStart,
  };
}

/** Author → manage view (with keys); eligible participant → take view (no questions, no keys); anyone else → 404. */
export async function getExamFor(user: SessionUser, id: string) {
  const exam = await db.exam.findUnique({ where: { id }, include: examInclude });
  if (!exam) throw Errors.notFound();
  if (exam.ownerId === user.id) return manageView(exam);
  if (exam.mode === "GROUP" && exam.groupId && exam.status !== "DRAFT") {
    const m = await db.groupMember.findUnique({ where: { groupId_userId: { groupId: exam.groupId, userId: user.id } }, select: { userId: true } });
    if (m) return takeView(user, exam, true);
  }
  throw Errors.notFound();
}

// ---------------------------------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------------------------------
export async function listExams(user: SessionUser, q: ListQuery) {
  const at = clockNow();
  const where: Prisma.ExamWhereInput =
    q.scope === "mine"
      ? { ownerId: user.id, ...(q.status ? { status: q.status } : {}) }
      : q.scope === "history"
        ? { versions: { some: { attempts: { some: { userId: user.id } } } }, ...(q.status ? { status: q.status } : {}) }
        : {
            status: "PUBLISHED",
            OR: [
              { mode: "INDIVIDUAL", ownerId: user.id },
              { mode: "GROUP", ownerId: { not: user.id }, group: { members: { some: { userId: user.id } } } },
            ],
          };
  let rows = await db.exam.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], include: examInclude, take: 500 });

  if (q.scope === "available") {
    const members = await db.groupMember.findMany({ where: { userId: user.id }, select: { groupId: true, joinedAt: true } });
    const joined = new Map(members.map((m) => [m.groupId, m.joinedAt]));
    const running = new Set((await db.examAttempt.findMany({ where: { userId: user.id, status: "IN_PROGRESS" }, select: { examVersionId: true } })).map((a) => a.examVersionId));
    rows = rows.filter((e) => {
      const v = e.versions[0];
      if (!v) return false;
      if (running.has(v.id)) return true;
      if (v.closesAt && v.closesAt <= at) return false;
      if (e.mode === "GROUP" && !v.lateJoinGroup && e.groupId && (joined.get(e.groupId)?.getTime() ?? 0) > v.publishedAt.getTime()) return false;
      return true;
    });
  }
  const total = rows.length;
  const page = rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
  const versions = page.flatMap((e) => (e.versions[0] ? [e.versions[0]] : []));
  const stats = await myAttemptStats(user.id, versions);
  return { items: page.map((e) => toSummary(e, e.versions[0] ? stats.get(e.versions[0].id) : undefined)), total, page: q.page, pageSize: q.pageSize };
}

// ---------------------------------------------------------------------------------------------------------------------
// Dashboard (PART4_SPEC §12): released results only
// ---------------------------------------------------------------------------------------------------------------------
export async function dashboardExams(user: SessionUser) {
  const at = clockNow();
  // Scores, averages and bands come from the shared analytics source (finalized + released results), so this block can never
  // disagree with /api/analytics/me, the results list or the group leaderboard.
  const [attempts, finalized, totals, recent, groups] = await Promise.all([
    db.examAttempt.count({ where: { userId: user.id } }),
    db.examAttempt.count({ where: { userId: user.id, status: { not: "IN_PROGRESS" } } }),
    releasedTotals(user.id, at),
    listReleasedResults(user.id, { limit: 5, order: "desc", at }),
    db.groupMember.count({ where: { userId: user.id } }),
  ]);
  const upcoming = (await listExams(user, { scope: "available", page: 1, pageSize: 50 })).items
    .filter((e) => (e.opensAt && new Date(e.opensAt) > at) || (e.closesAt && new Date(e.closesAt) > at))
    .slice(0, 5)
    .map((e) => ({ examId: e.id, title: e.title, opensAt: e.opensAt, closesAt: e.closesAt }));
  return {
    attempts,
    finalized,
    averagePercentBp: totals.average,
    best: totals.highest,
    byBand: totals.bandCounts,
    recent: recent.map((r) => ({ attemptId: r.attemptId, examId: r.examId, title: r.examTitle, percentBp: r.percentBp, band: r.band, finalizedAt: r.finalizedAt })),
    upcoming,
    groups,
  };
}
