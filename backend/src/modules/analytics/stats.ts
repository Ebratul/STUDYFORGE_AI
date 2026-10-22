import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { getEnv } from "../../config/env.js";
import { now } from "../../lib/clock.js";
import { db } from "../../lib/db.js";

/**
 * Single source of truth for per-user analytics (PART5_SPEC §1 and §7): every figure comes from FINALIZED, RELEASED results,
 * through this one SQL fragment, so dashboards, analysis context and group views always agree on a result's score.
 */

export type DataLevel = "NONE" | "INITIAL" | "BASED_ON_HISTORY";
export type TopicStat = { topic: string; questions: number; correct: number; incorrect: number; unanswered: number; accuracyBp: number; sufficient: boolean };

export const MIN_ANSWERED_FOR_LABEL = 3;
export const WEAK_BELOW_BP = 7000;
export const STRONG_AT_LEAST_BP = 8500;
export const HISTORY_MIN_RESULTS = 3;
export const HISTORY_MIN_TOPIC_QUESTIONS = 5;

/** `r` = ExamResult, `v` = ExamVersion. True when the version's release policy permits showing the result at `at`. */
export function releasedSql(at: Date = now(), graceSeconds: number = getEnv().EXAM_GRACE_SECONDS): Prisma.Sql {
  return Prisma.sql`(v."releaseMode" = 'IMMEDIATE'
    OR (v."releaseMode" = 'AFTER_CLOSE' AND v."closesAt" IS NOT NULL AND v."closesAt" + make_interval(secs => ${graceSeconds}) <= ${at}::timestamp)
    OR (v."releaseMode" = 'AT_TIME' AND v."releaseAt" IS NOT NULL AND v."releaseAt" <= ${at}::timestamp))`;
}

/** Round half up to basis points: correct / total × 10000. */
export const accuracyBp = (correct: number, total: number): number => (total > 0 ? Math.floor((correct * 10000 * 2 + total) / (2 * total)) : 0);

type Row = { topic: string; questions: bigint; correct: bigint; incorrect: bigint; unanswered: bigint };

/** Topic-wise accuracy over the user's released results (optionally limited to some results). Weakest first. Unanswered counts as not correct. */
export async function userTopicStats(userId: string, opts: { resultIds?: string[]; at?: Date } = {}): Promise<TopicStat[]> {
  const only = opts.resultIds ? Prisma.sql`AND r."id" IN (${Prisma.join(opts.resultIds.length ? opts.resultIds : [""])})` : Prisma.empty;
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT COALESCE(NULLIF(btrim(q."topic"), ''), 'General') AS "topic", count(*) AS "questions",
           count(*) FILTER (WHERE i."outcome" = 'CORRECT') AS "correct",
           count(*) FILTER (WHERE i."outcome" = 'INCORRECT') AS "incorrect",
           count(*) FILTER (WHERE i."outcome" = 'UNANSWERED') AS "unanswered"
    FROM "ExamResultItem" i
    JOIN "ExamResult" r ON r."id" = i."resultId"
    JOIN "ExamVersion" v ON v."id" = r."examVersionId"
    JOIN "ExamQuestionSnapshot" q ON q."id" = i."examQuestionId"
    WHERE r."userId" = ${userId} AND ${releasedSql(opts.at)} ${only}
    GROUP BY 1`);
  return rows
    .map((r) => {
      const questions = Number(r.questions);
      const correct = Number(r.correct);
      return { topic: r.topic, questions, correct, incorrect: Number(r.incorrect), unanswered: Number(r.unanswered), accuracyBp: accuracyBp(correct, questions), sufficient: questions >= MIN_ANSWERED_FOR_LABEL };
    })
    .sort((a, b) => a.accuracyBp - b.accuracyBp || b.questions - a.questions || a.topic.localeCompare(b.topic));
}

export const weakTopics = (t: TopicStat[]): TopicStat[] => t.filter((x) => x.sufficient && x.accuracyBp < WEAK_BELOW_BP);
export const strongTopics = (t: TopicStat[]): TopicStat[] => t.filter((x) => x.sufficient && x.accuracyBp >= STRONG_AT_LEAST_BP).sort((a, b) => b.accuracyBp - a.accuracyBp || a.topic.localeCompare(b.topic));

/** NONE: no released results. BASED_ON_HISTORY needs ≥ 3 results and a topic with ≥ 5 answered questions; everything else is INITIAL. */
export function dataLevel(resultCount: number, topics: TopicStat[]): DataLevel {
  if (resultCount <= 0) return "NONE";
  if (resultCount >= HISTORY_MIN_RESULTS && topics.some((t) => t.questions >= HISTORY_MIN_TOPIC_QUESTIONS)) return "BASED_ON_HISTORY";
  return "INITIAL";
}

export async function releasedResultCount(userId: string, at?: Date): Promise<number> {
  const [row] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS "n" FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId" WHERE r."userId" = ${userId} AND ${releasedSql(at)}`);
  return Number(row?.n ?? 0);
}

/** Stable hash of the verified inputs of a study plan: same data ⇒ same plan row. */
export function planFingerprint(topics: TopicStat[], percents: number[], locale: string): string {
  const t = [...topics].sort((a, b) => a.topic.localeCompare(b.topic)).map((x) => [x.topic, x.questions, x.correct, x.incorrect, x.unanswered]);
  return createHash("sha256").update(JSON.stringify({ t, p: percents, l: locale })).digest("hex");
}
