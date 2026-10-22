import type { AnalyzePlanContext, AnalyzeResultContext, AnalyzeTopic } from "../../clients/rag-agent.js";
import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { Prisma } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { accuracyBp, dataLevel, releasedSql, MIN_ANSWERED_FOR_LABEL, releasedResultCount, STRONG_AT_LEAST_BP, strongTopics, userTopicStats, weakTopics, WEAK_BELOW_BP, type DataLevel, type TopicStat } from "../analytics/stats.js";
import { isReleased } from "../exams/release.js";

/**
 * Builds the minimal, privacy-conscious context sent to rag_agent (PART5_SPEC §3.2). Only finalized, RELEASED results are used;
 * item-level detail follows the exam's review policy; there are no ids, names or e-mail addresses and no document text.
 */

const MAX_CONTEXT_CHARS = 12_000;
const cap = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export const topicName = (t: string | null | undefined) => cap(t, 60) || "General";

export const asApiTopic = (t: TopicStat): AnalyzeTopic => ({ topic: t.topic, questions: t.questions, correct: t.correct, incorrect: t.incorrect, unanswered: t.unanswered, accuracy_bp: t.accuracyBp });

export async function userLocale(userId: string): Promise<"en" | "bn"> {
  const p = await db.userPreference.findUnique({ where: { userId }, select: { locale: true } });
  return p?.locale === "bn" ? "bn" : "en";
}

export type ResultContextBundle = {
  context: AnalyzeResultContext;
  topicNames: Set<string>;
  weak: Set<string>;
  strong: Set<string>;
  dataLevel: DataLevel;
  userId: string;
  band: string;
  percentBp: number;
};

/** Throws CONFLICT (details.released=false) when the result's release time has not come. */
export async function buildResultContext(resultId: string): Promise<ResultContextBundle> {
  const result = await db.examResult.findUnique({
    where: { id: resultId },
    include: { items: true, attempt: { select: { id: true, finalizedAt: true } } },
  });
  if (!result) throw new AppError("NOT_FOUND", "Result not found.");
  const v = await db.examVersion.findUniqueOrThrow({ where: { id: result.examVersionId }, select: { id: true, examId: true, title: true, releaseMode: true, closesAt: true, releaseAt: true, reviewPolicy: true, questionCount: true } });
  const at = clockNow();
  if (!isReleased(v, at)) throw new AppError("CONFLICT", "Results for this exam haven't been released yet.", { released: false });

  const questions = await db.examQuestionSnapshot.findMany({ where: { examVersionId: v.id }, orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } });
  const itemById = new Map(result.items.map((i) => [i.examQuestionId, i]));

  const byTopic = new Map<string, TopicStat>();
  for (const q of questions) {
    const name = topicName(q.topic);
    const t = byTopic.get(name) ?? { topic: name, questions: 0, correct: 0, incorrect: 0, unanswered: 0, accuracyBp: 0, sufficient: false };
    const o = itemById.get(q.id)?.outcome ?? "UNANSWERED";
    t.questions++;
    if (o === "CORRECT") t.correct++;
    else if (o === "INCORRECT") t.incorrect++;
    else t.unanswered++;
    byTopic.set(name, t);
  }
  const examTopics = [...byTopic.values()]
    .map((t) => ({ ...t, accuracyBp: accuracyBp(t.correct, t.questions), sufficient: t.questions >= MIN_ANSWERED_FOR_LABEL }))
    .sort((a, b) => a.accuracyBp - b.accuracyBp || a.topic.localeCompare(b.topic));

  // item-level detail depends on the review policy (the participant may not see more than their own review page shows)
  const incorrect_items: AnalyzeResultContext["incorrect_items"] = [];
  if (v.reviewPolicy !== "NONE") {
    for (const q of questions) {
      const it = itemById.get(q.id);
      if (it?.outcome === "CORRECT") continue;
      const sel = q.options.find((o) => o.id === it?.selectedOptionId);
      const full = v.reviewPolicy === "FULL";
      incorrect_items.push({
        topic: topicName(q.topic),
        stem: cap(q.stem, 300),
        selected_text: sel ? cap(sel.text, 400) : null,
        correct_text: full ? cap(q.options.find((o) => o.isCorrect)?.text, 400) || null : null,
        explanation: full ? cap(q.explanation, 400) || null : null,
        note: full ? cap(q.shortNote, 400) || null : null,
      });
    }
  }

  // history: this exam's earlier released attempts + the user's overall topic accuracy (released results only)
  const sameExamVersions = await db.examVersion.findMany({ where: { examId: v.examId }, select: { id: true, releaseMode: true, closesAt: true, releaseAt: true } });
  const versionById = new Map(sameExamVersions.map((x) => [x.id, x]));
  const earlier = await db.examResult.findMany({
    where: { userId: result.userId, id: { not: result.id }, finalizedAt: { lt: result.finalizedAt }, examVersionId: { in: sameExamVersions.map((x) => x.id) } },
    orderBy: { finalizedAt: "desc" },
    take: 20,
    select: { percentBp: true, examVersionId: true },
  });
  const previous = earlier.filter((e) => isReleased(versionById.get(e.examVersionId)!, at)).slice(0, 5).map((e) => ({ percent_bp: e.percentBp })).reverse();
  const [overall, total] = await Promise.all([userTopicStats(result.userId, { at }), releasedResultCount(result.userId, at)]);
  const level = dataLevel(Math.max(total, 1), overall);

  const counts = {
    correct: result.correctCount,
    incorrect: result.incorrectCount,
    unanswered: result.unansweredCount,
  };
  const context: AnalyzeResultContext = {
    language: await userLocale(result.userId),
    exam: { title: cap(v.title, 120), question_count: v.questionCount, percent_bp: result.percentBp, band: result.band, ...counts },
    topics: examTopics.slice(0, 40).map(asApiTopic),
    weak_topics: weakTopics(examTopics).map((t) => t.topic),
    strong_topics: strongTopics(examTopics).map((t) => t.topic),
    incorrect_items: incorrect_items.slice(0, getEnv().ANALYSIS_MAX_INCORRECT_ITEMS),
    history: {
      data_level: level === "BASED_ON_HISTORY" ? "BASED_ON_HISTORY" : "INITIAL",
      results_total: total,
      previous_same_exam: previous,
      topic_history: overall.slice(0, 30).map((t) => ({ topic: t.topic, answered: t.questions, accuracy_bp: t.accuracyBp })),
    },
  };
  while (JSON.stringify(context).length > MAX_CONTEXT_CHARS && context.incorrect_items.length) context.incorrect_items.pop();
  while (JSON.stringify(context).length > MAX_CONTEXT_CHARS && context.history.topic_history.length > 5) context.history.topic_history.pop();

  return {
    context,
    topicNames: new Set(context.topics.map((t) => t.topic)),
    weak: new Set(context.weak_topics),
    strong: new Set(context.strong_topics),
    dataLevel: level === "NONE" ? "INITIAL" : level,
    userId: result.userId,
    band: result.band,
    percentBp: result.percentBp,
  };
}

export type PlanData = { level: DataLevel; topics: TopicStat[]; weak: TopicStat[]; strong: TopicStat[]; notEnough: TopicStat[]; percents: number[]; resultCount: number };

/** Released finalized percentages, chronological, newest `limit`. */
export async function releasedPercents(userId: string, limit = 10): Promise<number[]> {
  const rows = await db.$queryRaw<{ percentBp: number }[]>(Prisma.sql`
    SELECT r."percentBp" FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId"
    WHERE r."userId" = ${userId} AND ${releasedSql()} ORDER BY r."finalizedAt" DESC, r."id" DESC LIMIT ${limit}`);
  return rows.map((r) => r.percentBp).reverse();
}

export async function loadPlanData(userId: string): Promise<PlanData> {
  const [topics, resultCount, percents] = await Promise.all([userTopicStats(userId), releasedResultCount(userId), releasedPercents(userId)]);
  return { level: dataLevel(resultCount, topics), topics, weak: weakTopics(topics), strong: strongTopics(topics), notEnough: topics.filter((t) => !t.sufficient), percents, resultCount };
}

export function buildPlanContext(d: PlanData, language: "en" | "bn"): AnalyzePlanContext {
  return {
    language,
    data_level: d.level === "BASED_ON_HISTORY" ? "BASED_ON_HISTORY" : "INITIAL",
    results: d.percents.map((p) => ({ percent_bp: p })),
    topics: d.topics.slice(0, 40).map(asApiTopic),
    weak_topics: d.weak.map((t) => t.topic),
    strong_topics: d.strong.map((t) => t.topic),
  };
}

export const THRESHOLDS = { weakBelowBp: WEAK_BELOW_BP, strongAtLeastBp: STRONG_AT_LEAST_BP } as const;
