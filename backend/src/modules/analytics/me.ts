import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { now } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { countUnread } from "../account/notifications.js";
import { bandFromPercentBp } from "../exams/bands.js";
import { countReleasedResults, examsWithMultipleResults, listReleasedResults, releasedTotals } from "./sources.js";
import { buildSuggestions } from "./suggestions.js";
import { dataLevel, releasedSql, strongTopics, userTopicStats, weakTopics } from "./stats.js";

type FeedbackRow = { attemptId: string; examTitle: string; status: string; summary: string | null; generatedAt: Date | null };

/** Latest AI feedback rows for the caller's own released results (read-only; written by the analysis module). */
async function recentFeedback(userId: string) {
  const rows = await db.$queryRaw<FeedbackRow[]>(Prisma.sql`
    SELECT r."attemptId", v."title" AS "examTitle", a."status"::text AS "status",
           CASE WHEN a."status" = 'READY' THEN left(a."content"->>'summary', 240) END AS "summary", a."generatedAt"
    FROM "ExamAnalysis" a JOIN "ExamResult" r ON r."id" = a."resultId" JOIN "ExamVersion" v ON v."id" = r."examVersionId"
    WHERE a."userId" = ${userId} AND r."userId" = ${userId} AND ${releasedSql()}
    ORDER BY COALESCE(a."generatedAt", a."updatedAt") DESC, a."id" DESC LIMIT 5`);
  return rows.map((r) => ({ attemptId: r.attemptId, examTitle: r.examTitle, status: r.status, summary: r.summary, generatedAt: r.generatedAt?.toISOString() ?? null }));
}

async function savedContent(userId: string) {
  const [collections, mcq, cq, notes, recent] = await Promise.all([
    db.questionCollection.count({ where: { ownerId: userId } }),
    db.question.count({ where: { ownerId: userId, kind: "MCQ" } }),
    db.question.count({ where: { ownerId: userId, kind: "CQ" } }),
    db.question.count({ where: { ownerId: userId, shortNote: { not: null }, NOT: { shortNote: "" } } }),
    db.questionCollection.findMany({ where: { ownerId: userId }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 3, select: { id: true, title: true, _count: { select: { questions: true } } } }),
  ]);
  return { collections, mcqQuestions: mcq, cqQuestions: cq, questionsWithNotes: notes, recentCollections: recent.map((c) => ({ id: c.id, title: c.title, questionCount: c._count.questions })) };
}

/** Memberships with the next group exam this user can still take (not yet attempted, not closed, eligible by the late-join rule). */
async function groupSummary(userId: string) {
  const at = now();
  const memberships = await db.groupMember.findMany({ where: { userId }, orderBy: [{ joinedAt: "desc" }, { groupId: "asc" }], take: 50, include: { group: { select: { id: true, title: true } } } });
  if (!memberships.length) return [];
  const exams = await db.exam.findMany({
    where: { mode: "GROUP", status: "PUBLISHED", groupId: { in: memberships.map((m) => m.groupId) }, ownerId: { not: userId }, currentVersion: { gte: 1 } },
    orderBy: { publishedAt: "desc" }, take: 200, select: { id: true, title: true, groupId: true, currentVersion: true },
  });
  const versions = await db.examVersion.findMany({
    where: { OR: exams.map((e) => ({ examId: e.id, version: e.currentVersion })) },
    select: { id: true, examId: true, opensAt: true, closesAt: true, lateJoinGroup: true, publishedAt: true },
  });
  const vById = new Map(versions.map((v) => [v.examId, v]));
  const attempted = new Set((await db.examAttempt.findMany({ where: { userId, examVersionId: { in: versions.map((v) => v.id) } }, select: { examVersionId: true } })).map((a) => a.examVersionId));
  const joined = new Map(memberships.map((m) => [m.groupId, m.joinedAt]));
  const next = new Map<string, { examId: string; title: string; opensAt: string | null; closesAt: string | null; at: number }>();
  for (const e of exams) {
    const v = vById.get(e.id);
    if (!v || !e.groupId || attempted.has(v.id)) continue;
    if (v.closesAt && v.closesAt <= at) continue;
    if (!v.lateJoinGroup && (joined.get(e.groupId)?.getTime() ?? 0) > v.publishedAt.getTime()) continue;
    const when = (v.opensAt && v.opensAt > at ? v.opensAt : (v.closesAt ?? v.opensAt ?? v.publishedAt)).getTime();
    const cur = next.get(e.groupId);
    if (!cur || when < cur.at) next.set(e.groupId, { examId: e.id, title: e.title, opensAt: v.opensAt?.toISOString() ?? null, closesAt: v.closesAt?.toISOString() ?? null, at: when });
  }
  return memberships.map((m) => {
    const n = next.get(m.groupId);
    return { id: m.group.id, title: m.group.title, role: m.role, nextExam: n ? { examId: n.examId, title: n.title, opensAt: n.opensAt, closesAt: n.closesAt } : null };
  });
}

/** PART5_SPEC §7 `GET /api/analytics/me`. Everything is scoped to the caller and limited to finalized, released results. */
export async function myAnalytics(user: SessionUser) {
  const [totals, trendDesc, topics, feedback, saved, groups, unread, compare] = await Promise.all([
    releasedTotals(user.id),
    listReleasedResults(user.id, { limit: 50, order: "desc" }),
    userTopicStats(user.id),
    recentFeedback(user.id),
    savedContent(user.id),
    groupSummary(user.id),
    countUnread(user),
    examsWithMultipleResults(user.id),
  ]);
  const level = dataLevel(totals.completed, topics);
  const weak = weakTopics(topics);
  const { bandCounts, ...rest } = totals;
  return {
    dataLevel: level,
    totals: rest,
    bandCounts,
    trend: trendDesc.reverse().map((r) => ({ attemptId: r.attemptId, examId: r.examId, examTitle: r.examTitle, finalizedAt: r.finalizedAt, percentBp: r.percentBp, band: bandFromPercentBp(r.percentBp) })),
    topics,
    weakTopics: weak,
    strongTopics: strongTopics(topics),
    recentFeedback: feedback,
    suggestions: level === "NONE" ? [] : buildSuggestions(weak, compare),
    saved,
    groups,
    unreadNotifications: unread,
  };
}

export async function myResults(user: SessionUser, q: { page: number; pageSize: number }) {
  const [items, total] = await Promise.all([listReleasedResults(user.id, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize, order: "desc" }), countReleasedResults(user.id)]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
