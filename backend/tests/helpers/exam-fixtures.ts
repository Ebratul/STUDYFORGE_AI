import { randomUUID } from "node:crypto";
import { db } from "../../src/lib/db.js";
import type { TestUser } from "./users.js";

/** Direct-to-database fixtures for exam/group tests (they bypass the API on purpose so each suite can test its own layer in isolation). */

export async function seedGroup(owner: TestUser, opts: { capacity?: number; members?: { user: TestUser; role?: "ADMIN" | "MEMBER"; joinedAt?: Date; showName?: boolean }[]; title?: string } = {}) {
  const group = await db.group.create({ data: { ownerId: owner.id, title: opts.title ?? "Study group", capacity: opts.capacity ?? 30 } });
  await db.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: "OWNER" } });
  for (const m of opts.members ?? [])
    await db.groupMember.create({ data: { groupId: group.id, userId: m.user.id, role: m.role ?? "MEMBER", ...(m.joinedAt ? { joinedAt: m.joinedAt } : {}), showNameOnLeaderboard: m.showName ?? true } });
  return group;
}

export type SeedQuestion = { id: string; stem: string; optionIds: string[]; correctId: string; marksCenti: number };

/** Creates N saved MCQs in the bank (the real table) for `owner`. Option 0 is correct. */
export async function seedBankQuestions(owner: TestUser, n: number, prefix = "Bank question") {
  const out: { id: string; optionIds: string[]; correctId: string }[] = [];
  for (let i = 0; i < n; i++) {
    const id = `q${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const optionIds = [0, 1, 2, 3].map((k) => `o${randomUUID().replaceAll("-", "").slice(0, 20)}${k}`);
    await db.question.create({
      data: {
        id, ownerId: owner.id, kind: "MCQ", language: "en", stem: `${prefix} ${i + 1} ${randomUUID()}`, difficulty: "MEDIUM", topic: i % 2 ? "Topic B" : "Topic A", origin: "USER_AUTHORED", sourceSupport: "NONE",
        contentHash: randomUUID(), explanation: `Explanation ${i + 1}`, shortNote: `Note ${i + 1}`,
        options: { create: optionIds.map((oid, k) => ({ id: oid, position: k, text: `Option ${k} of ${i + 1}`, isCorrect: k === 0 })) },
      },
    });
    out.push({ id, optionIds, correctId: optionIds[0]! });
  }
  return out;
}

export const bandOf = (percentBp: number) => (percentBp >= 9000 ? "EXCELLENT" : percentBp >= 8000 ? "GOOD" : percentBp >= 7000 ? "NEEDS_IMPROVEMENT" : percentBp >= 6000 ? "BAD" : "VERY_BAD") as "EXCELLENT" | "GOOD" | "NEEDS_IMPROVEMENT" | "BAD" | "VERY_BAD";
export const percentBpOf = (score: number, max: number) => Math.floor((score * 10000 * 2 + max) / (2 * max));

/**
 * Inserts a published ExamVersion with `questionCount` snapshot questions (4 options each, option 0 correct) straight into the database.
 * Defaults: 1 mark per question, no negative marking, 60 minutes, 1 attempt, immediate release, full review.
 */
export async function seedPublishedExam(opts: {
  owner: TestUser; group?: { id: string } | null; questionCount?: number; marksCenti?: number; negativeCenti?: number; durationSeconds?: number; attemptLimit?: number;
  opensAt?: Date | null; closesAt?: Date | null; releaseMode?: "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME"; releaseAt?: Date | null; reviewPolicy?: "NONE" | "CORRECTNESS" | "FULL";
  shuffleQuestions?: boolean; shuffleOptions?: boolean; lateStart?: "CAP_AT_CLOSE" | "FULL_TIME_ONLY"; lateJoinGroup?: boolean; leaderboardVisible?: boolean; publishedAt?: Date; title?: string;
}) {
  const n = opts.questionCount ?? 3;
  const marks = opts.marksCenti ?? 100;
  const neg = opts.negativeCenti ?? 0;
  const mode = opts.group ? "GROUP" : "INDIVIDUAL";
  const exam = await db.exam.create({
    data: { ownerId: opts.owner.id, groupId: opts.group?.id ?? null, mode, status: "PUBLISHED", title: opts.title ?? "Seeded exam", draft: {}, currentVersion: 1, publishedAt: opts.publishedAt ?? new Date() },
  });
  const version = await db.examVersion.create({
    data: {
      examId: exam.id, version: 1, title: exam.title, mode, groupId: opts.group?.id ?? null, durationSeconds: opts.durationSeconds ?? 3600, attemptLimit: opts.attemptLimit ?? 1,
      opensAt: opts.opensAt ?? null, closesAt: opts.closesAt ?? null, shuffleQuestions: opts.shuffleQuestions ?? false, shuffleOptions: opts.shuffleOptions ?? false,
      reviewPolicy: opts.reviewPolicy ?? "FULL", releaseMode: opts.releaseMode ?? "IMMEDIATE", releaseAt: opts.releaseAt ?? null, lateStart: opts.lateStart ?? "CAP_AT_CLOSE",
      lateJoinGroup: opts.lateJoinGroup ?? true, leaderboardVisible: opts.leaderboardVisible ?? true, negativeMarkingBp: marks ? Math.round((neg / marks) * 10000) : 0,
      questionCount: n, totalCenti: n * marks, snapshotHash: "seeded", publishedById: opts.owner.id, ...(opts.publishedAt ? { publishedAt: opts.publishedAt } : {}),
    },
  });
  await db.examVersionState.create({ data: { examVersionId: version.id } });
  const questions: SeedQuestion[] = [];
  for (let i = 0; i < n; i++) {
    const q = await db.examQuestionSnapshot.create({
      data: {
        examVersionId: version.id, position: i, sourceQuestionVersion: 1, stem: `Snapshot question ${i + 1}`, explanation: `Snapshot explanation ${i + 1}`, shortNote: `Snapshot note ${i + 1}`,
        topic: i % 2 ? "Topic B" : "Topic A", difficulty: "MEDIUM", language: "en", marksCenti: marks, negativeCenti: neg, sources: [],
        options: { create: [0, 1, 2, 3].map((k) => ({ position: k, text: `Snapshot option ${k} of ${i + 1}`, isCorrect: k === 0 })) },
      },
      include: { options: { orderBy: { position: "asc" } } },
    });
    questions.push({ id: q.id, stem: q.stem, optionIds: q.options.map((o) => o.id), correctId: q.options[0]!.id, marksCenti: marks });
  }
  return { exam, version, questions };
}

/** Inserts a finalized attempt + result directly (for leaderboard/analytics tests); correct/incorrect counts are derived from the score. */
export async function seedFinalResult(opts: {
  version: { id: string; totalCenti: number; questionCount: number }; user: TestUser; scoreCenti: number; status?: "SUBMITTED" | "TIMED_OUT"; attemptNo?: number; finalizedAt?: Date;
}) {
  const finalizedAt = opts.finalizedAt ?? new Date();
  const startedAt = new Date(finalizedAt.getTime() - 600_000);
  const attempt = await db.examAttempt.create({
    data: {
      examVersionId: opts.version.id, userId: opts.user.id, attemptNo: opts.attemptNo ?? 1, status: opts.status ?? "SUBMITTED", startedAt, deadlineAt: new Date(startedAt.getTime() + 3_600_000),
      submittedAt: opts.status === "TIMED_OUT" ? null : finalizedAt, finalizedAt, questionOrder: [], optionOrder: {},
    },
  });
  const percentBp = percentBpOf(opts.scoreCenti, opts.version.totalCenti);
  const perQ = opts.version.totalCenti / opts.version.questionCount;
  const correct = Math.min(opts.version.questionCount, Math.round(opts.scoreCenti / perQ));
  await db.examResult.create({
    data: {
      attemptId: attempt.id, examVersionId: opts.version.id, userId: opts.user.id, rawScoreCenti: opts.scoreCenti, scoreCenti: opts.scoreCenti, maxCenti: opts.version.totalCenti, percentBp,
      correctCount: correct, incorrectCount: 0, unansweredCount: opts.version.questionCount - correct, band: bandOf(percentBp), finalizedAt,
    },
  });
  return attempt;
}
