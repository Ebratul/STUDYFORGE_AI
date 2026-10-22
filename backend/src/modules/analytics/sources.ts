import { Prisma } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { bandFromPercentBp, type Band } from "../exams/bands.js";
import { releasedSql } from "./stats.js";

/**
 * The one query path for "my finalized, released results". The dashboard summary, /api/analytics/me, the results list and the
 * analysis context all read through here, so a finalized result has the same score, percentage and band everywhere.
 * Bands are always derived with the single classifier (`bandFromPercentBp`) from the stored percentage.
 */

export const BANDS: Band[] = ["EXCELLENT", "GOOD", "NEEDS_IMPROVEMENT", "BAD", "VERY_BAD"];
export const emptyBandCounts = (): Record<Band, number> => ({ EXCELLENT: 0, GOOD: 0, NEEDS_IMPROVEMENT: 0, BAD: 0, VERY_BAD: 0 });

export type ReleasedResult = {
  attemptId: string; examId: string; examTitle: string; finalizedAt: string; scoreCenti: number; maxCenti: number; percentBp: number; band: Band;
  correct: number; incorrect: number; unanswered: number;
};

type Row = {
  attemptId: string; examId: string; examTitle: string; finalizedAt: Date; scoreCenti: number; maxCenti: number; percentBp: number; correct: number; incorrect: number; unanswered: number;
};

export async function listReleasedResults(userId: string, opts: { limit: number; offset?: number; order?: "asc" | "desc"; at?: Date }): Promise<ReleasedResult[]> {
  const dir = opts.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT r."attemptId", v."examId", v."title" AS "examTitle", r."finalizedAt", r."scoreCenti", r."maxCenti", r."percentBp",
           r."correctCount" AS "correct", r."incorrectCount" AS "incorrect", r."unansweredCount" AS "unanswered"
    FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId"
    WHERE r."userId" = ${userId} AND ${releasedSql(opts.at)}
    ORDER BY r."finalizedAt" ${dir}, r."id" ${dir}
    LIMIT ${opts.limit} OFFSET ${opts.offset ?? 0}`);
  return rows.map((r) => ({ ...r, finalizedAt: r.finalizedAt.toISOString(), band: bandFromPercentBp(r.percentBp) }));
}

export type ReleasedTotals = {
  completed: number; average: number | null; highest: number | null; lowest: number | null; correct: number; incorrect: number; unanswered: number; bandCounts: Record<Band, number>;
};

/** `null` percentages mean "no released results" — a real 0 % result is the number 0. */
export async function releasedTotals(userId: string, at?: Date): Promise<ReleasedTotals> {
  const [[t], byPercent] = await Promise.all([
    db.$queryRaw<{ n: bigint; sum: bigint | null; hi: number | null; lo: number | null; c: bigint | null; i: bigint | null; u: bigint | null }[]>(Prisma.sql`
      SELECT count(*) AS "n", sum(r."percentBp") AS "sum", max(r."percentBp") AS "hi", min(r."percentBp") AS "lo",
             sum(r."correctCount") AS "c", sum(r."incorrectCount") AS "i", sum(r."unansweredCount") AS "u"
      FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId" WHERE r."userId" = ${userId} AND ${releasedSql(at)}`),
    db.$queryRaw<{ p: number; n: bigint }[]>(Prisma.sql`
      SELECT r."percentBp" AS "p", count(*) AS "n" FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId"
      WHERE r."userId" = ${userId} AND ${releasedSql(at)} GROUP BY 1`),
  ]);
  const n = Number(t?.n ?? 0);
  const bandCounts = emptyBandCounts();
  for (const row of byPercent) bandCounts[bandFromPercentBp(row.p)] += Number(row.n);
  const sum = Number(t?.sum ?? 0);
  return {
    completed: n,
    average: n ? Math.floor((sum * 2 + n) / (2 * n)) : null,
    highest: n ? (t!.hi ?? null) : null,
    lowest: n ? (t!.lo ?? null) : null,
    correct: Number(t?.c ?? 0), incorrect: Number(t?.i ?? 0), unanswered: Number(t?.u ?? 0),
    bandCounts,
  };
}

export async function countReleasedResults(userId: string, at?: Date): Promise<number> {
  const [r] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS "n" FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId" WHERE r."userId" = ${userId} AND ${releasedSql(at)}`);
  return Number(r?.n ?? 0);
}

/** Exams where the user has ≥ 2 released results (enables the "compare attempts" suggestion). */
export async function examsWithMultipleResults(userId: string, at?: Date): Promise<{ examId: string; title: string; n: number }[]> {
  const rows = await db.$queryRaw<{ examId: string; title: string; n: bigint }[]>(Prisma.sql`
    SELECT v."examId", max(v."title") AS "title", count(*) AS "n" FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId"
    WHERE r."userId" = ${userId} AND ${releasedSql(at)} GROUP BY v."examId" HAVING count(*) >= 2 ORDER BY max(r."finalizedAt") DESC LIMIT 3`);
  return rows.map((r) => ({ examId: r.examId, title: r.title, n: Number(r.n) }));
}
