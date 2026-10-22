import { createHmac } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { now } from "../../lib/clock.js";
import { deriveKey } from "../../lib/crypto.js";
import { db } from "../../lib/db.js";
import { Errors } from "../../lib/errors.js";
import { DISTRIBUTION } from "../exams/bands.js";
import { finalizeExpiredForVersion } from "../exams/lifecycle.js";
import { isReleased, releaseTime } from "../exams/release.js";
import { isStaff } from "./permissions.js";

export const RANKING_POLICY = "COMPETITION_1224_BEST_ATTEMPT" as const;
export type EntryStatus = "SUBMITTED" | "TIMED_OUT" | "IN_PROGRESS" | "NOT_STARTED" | "MISSED";

export type Access = {
  exam: { id: string; title: string; ownerId: string; groupId: string; status: "DRAFT" | "PUBLISHED" | "CANCELLED" };
  version: { id: string; totalCenti: number; closesAt: Date | null; publishedAt: Date; lateJoinGroup: boolean; leaderboardVisible: boolean; releaseMode: "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME"; releaseAt: Date | null };
  staff: boolean;
};

/** Group-exam access: current members only (everyone else, and non-group exams, get 404). */
export async function loadAccess(user: SessionUser, examId: string): Promise<Access> {
  const exam = await db.exam.findUnique({ where: { id: examId }, select: { id: true, title: true, ownerId: true, groupId: true, mode: true, status: true, currentVersion: true } });
  if (!exam || exam.mode !== "GROUP" || !exam.groupId || exam.currentVersion < 1) throw Errors.notFound();
  const member = await db.groupMember.findUnique({ where: { groupId_userId: { groupId: exam.groupId, userId: user.id } }, select: { role: true } });
  if (!member) throw Errors.notFound();
  const version = await db.examVersion.findUnique({
    where: { examId_version: { examId, version: exam.currentVersion } },
    select: { id: true, totalCenti: true, closesAt: true, publishedAt: true, lateJoinGroup: true, leaderboardVisible: true, releaseMode: true, releaseAt: true },
  });
  if (!version) throw Errors.notFound();
  return { exam: { ...exam, groupId: exam.groupId }, version, staff: exam.ownerId === user.id || isStaff(member.role) };
}

/**
 * The shared CTE. `parts` = eligible participants (current members except the author; late joiners only when allowed),
 * `best` = each participant's best finalized attempt (highest score, earliest finalization on ties) with its COMPETITION rank
 * (`rank()` window: 1, 2, 2, 4) computed in SQL over ranked participants only, `att` = attempt counters.
 */
export function cte(a: Access, closed: boolean): Prisma.Sql {
  return Prisma.sql`
    WITH parts AS (
      SELECT m."userId", m."role", m."showNameOnLeaderboard" AS "showName", COALESCE(NULLIF(btrim(p."displayName"), ''), u."name") AS "name"
      FROM "GroupMember" m
      JOIN "User" u ON u."id" = m."userId"
      LEFT JOIN "UserProfile" p ON p."userId" = u."id"
      WHERE m."groupId" = ${a.exam.groupId} AND m."userId" <> ${a.exam.ownerId}
        AND (${a.version.lateJoinGroup}::boolean OR m."joinedAt" <= ${a.version.publishedAt}::timestamp)
    ),
    best0 AS (
      SELECT DISTINCT ON (r."userId") r."id" AS "resultId", r."userId", r."scoreCenti", r."percentBp", r."band"::text AS "band", r."finalizedAt",
             at."status"::text AS "attemptStatus", at."submittedAt"
      FROM "ExamResult" r
      JOIN "ExamAttempt" at ON at."id" = r."attemptId"
      WHERE r."examVersionId" = ${a.version.id} AND r."userId" IN (SELECT "userId" FROM parts)
      ORDER BY r."userId", r."scoreCenti" DESC, r."finalizedAt" ASC
    ),
    best AS (SELECT best0.*, rank() OVER (ORDER BY best0."scoreCenti" DESC)::int AS "rank" FROM best0),
    att AS (
      SELECT "userId", count(*)::int AS "used", bool_or("status" = 'IN_PROGRESS') AS "inProgress"
      FROM "ExamAttempt" WHERE "examVersionId" = ${a.version.id} GROUP BY "userId"
    ),
    ent AS (
      SELECT parts."userId", parts."name", parts."showName", parts."role", best."rank", best."scoreCenti", best."percentBp", best."band", best."finalizedAt", best."submittedAt",
             COALESCE(att."used", 0) AS "attemptsUsed",
             CASE WHEN best."attemptStatus" IS NOT NULL THEN best."attemptStatus"
                  WHEN COALESCE(att."inProgress", false) THEN 'IN_PROGRESS'
                  WHEN ${closed}::boolean THEN 'MISSED' ELSE 'NOT_STARTED' END AS "status"
      FROM parts LEFT JOIN best ON best."userId" = parts."userId" LEFT JOIN att ON att."userId" = parts."userId"
    )`;
}

type EntRow = {
  userId: string; name: string; showName: boolean; role: string; rank: number | null; scoreCenti: number | null; percentBp: number | null; band: string | null;
  finalizedAt: Date | null; submittedAt: Date | null; attemptsUsed: number; status: EntryStatus; total: bigint;
};

const ORDER = Prisma.sql`ORDER BY (ent."rank" IS NULL), ent."rank", ent."finalizedAt", CASE ent."status" WHEN 'IN_PROGRESS' THEN 0 WHEN 'NOT_STARTED' THEN 1 ELSE 2 END, ent."userId"`;

function entries(a: Access, closed: boolean, opts: { limit: number; offset: number; onlyUser?: string }): Promise<EntRow[]> {
  return db.$queryRaw<EntRow[]>(Prisma.sql`${cte(a, closed)}
    SELECT ent.*, count(*) OVER () AS "total" FROM ent
    WHERE (${opts.onlyUser ?? null}::text IS NULL OR ent."userId" = ${opts.onlyUser ?? null}::text)
    ${ORDER} LIMIT ${opts.limit} OFFSET ${opts.offset}`);
}

export async function counts(a: Access, closed: boolean) {
  const rows = await db.$queryRaw<{ status: EntryStatus; n: number }[]>(Prisma.sql`${cte(a, closed)} SELECT ent."status", count(*)::int AS "n" FROM ent GROUP BY ent."status"`);
  const get = (s: EntryStatus) => rows.find((r) => r.status === s)?.n ?? 0;
  const c = { submitted: get("SUBMITTED"), timedOut: get("TIMED_OUT"), inProgress: get("IN_PROGRESS"), notStarted: get("NOT_STARTED"), missed: get("MISSED") };
  return { total: c.submitted + c.timedOut + c.inProgress + c.notStarted + c.missed, ...c };
}

async function stats(a: Access, closed: boolean) {
  const [s] = await db.$queryRaw<{ participants: number; ranked: number; average: number | null; highest: number | null; lowest: number | null; median: number | null; bands: number[] }[]>(Prisma.sql`
    ${cte(a, closed)}
    SELECT (SELECT count(*)::int FROM ent) AS "participants",
           count(*)::int AS "ranked",
           round(avg("percentBp"))::int AS "average", max("percentBp") AS "highest", min("percentBp") AS "lowest",
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY "percentBp"))::int AS "median",
           ${Prisma.raw(`ARRAY[${DISTRIBUTION.map((d) => `count(*) FILTER (WHERE "percentBp" >= ${d.minBp} AND "percentBp" < ${d.maxBpExclusive})`).join(", ")}]::int[]`)} AS "bands"
    FROM best`);
  return {
    stats: { participants: s!.participants, ranked: s!.ranked, average: s!.average, highest: s!.highest, lowest: s!.lowest, median: s!.median },
    distribution: DISTRIBUTION.map((d, i) => ({ band: d.band, label: d.label, count: s!.bands[i] ?? 0 })),
  };
}

/** Opaque, stable per (exam version, participant); not reversible to a user id. */
const entryId = (versionId: string, userId: string) => createHmac("sha256", deriveKey("leaderboard-entry")).update(`${versionId}|${userId}`).digest("base64url").slice(0, 16);

export const isClosed = (a: Access, at: Date) => a.exam.status === "CANCELLED" || (a.version.closesAt !== null && at >= a.version.closesAt);

export async function getLeaderboard(user: SessionUser, examId: string, q: { page: number; pageSize: number }) {
  const a = await loadAccess(user, examId);
  await finalizeExpiredForVersion(a.version.id); // expired attempts are finalized before anything is read
  const at = now();
  const closed = isClosed(a, at);
  const released = isReleased(a.version, at);
  const releasesAt = releaseTime(a.version)?.toISOString() ?? null;

  // The organiser can hide the board from ordinary members entirely (staff keep it after release).
  if (!a.version.leaderboardVisible && !a.staff) return { released, hidden: true as const, releasesAt };
  if (!released) {
    const c = await counts(a, closed);
    const [mine] = await entries(a, closed, { limit: 1, offset: 0, onlyUser: user.id });
    return {
      released: false as const, releasesAt,
      participants: { total: c.total, submitted: c.submitted, timedOut: c.timedOut, inProgress: c.inProgress, notStarted: c.notStarted, missed: c.missed },
      myStatus: mine?.status ?? null,
    };
  }

  const [rows, mineRows, st] = await Promise.all([
    entries(a, closed, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
    entries(a, closed, { limit: 1, offset: 0, onlyUser: user.id }),
    stats(a, closed),
  ]);
  const toItem = (r: EntRow) => {
    const self = r.userId === user.id;
    return {
      entryId: entryId(a.version.id, r.userId), rank: r.rank, displayName: self || r.showName ? r.name : "Anonymous participant", isSelf: self, status: r.status,
      scoreCenti: r.scoreCenti, maxCenti: a.version.totalCenti, percentBp: r.percentBp, band: r.band,
      submittedAt: r.status === "SUBMITTED" ? (r.submittedAt?.toISOString() ?? null) : null,
    };
  };
  return {
    released: true as const, policy: RANKING_POLICY, releasesAt, exam: { id: a.exam.id, title: a.exam.title },
    items: rows.map(toItem), total: Number(rows[0]?.total ?? st.stats.participants), page: q.page, pageSize: q.pageSize,
    stats: st.stats, distribution: st.distribution, myEntry: mineRows[0] ? toItem(mineRows[0]) : null,
  };
}

/** Staff view: who is taking part and in what state. Scores only after release; never answers. */
export async function getParticipants(user: SessionUser, examId: string, q: { page: number; pageSize: number }) {
  const a = await loadAccess(user, examId);
  if (!a.staff) throw Errors.notFound();
  await finalizeExpiredForVersion(a.version.id);
  const at = now();
  const closed = isClosed(a, at);
  const released = isReleased(a.version, at);
  const [c, rows] = await Promise.all([counts(a, closed), entries(a, closed, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize })]);
  return {
    released, releasesAt: releaseTime(a.version)?.toISOString() ?? null,
    counts: { total: c.total, submitted: c.submitted, timedOut: c.timedOut, inProgress: c.inProgress, notStarted: c.notStarted, missed: c.missed },
    items: rows.map((r) => ({
      memberId: r.userId, displayName: r.name, role: r.role, status: r.status, attemptsUsed: r.attemptsUsed,
      scoreCenti: released ? r.scoreCenti : null, maxCenti: a.version.totalCenti, percentBp: released ? r.percentBp : null, band: released ? r.band : null,
      finalizedAt: r.finalizedAt?.toISOString() ?? null,
    })),
    total: Number(rows[0]?.total ?? c.total), page: q.page, pageSize: q.pageSize,
  };
}
