import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { now } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { accuracyBp } from "../analytics/stats.js";
import { finalizeExpiredForVersion } from "../exams/lifecycle.js";
import { isReleased, releaseTime } from "../exams/release.js";
import { counts, cte, isClosed, loadAccess } from "./leaderboard.js";

/** A topic is only reported when at least this many participants answered questions in it (small-group privacy). */
export const MIN_TOPIC_PARTICIPANTS = 3;

/**
 * PART5_SPEC §7 `GET /api/exams/:id/topics`: aggregates only, never per-user rows. Same access, release and visibility rules as the
 * leaderboard; accuracy is taken over each current participant's best finalized attempt (the leaderboard's own basis).
 */
export async function getGroupTopics(user: SessionUser, examId: string) {
  const a = await loadAccess(user, examId); // group exams, current members only; everyone else (and non-group exams) get 404
  await finalizeExpiredForVersion(a.version.id);
  const at = now();
  const closed = isClosed(a, at);
  const released = isReleased(a.version, at);
  const releasesAt = releaseTime(a.version)?.toISOString() ?? null;
  if (!a.version.leaderboardVisible && !a.staff) return { released, hidden: true as const, releasesAt };

  const c = await counts(a, closed);
  const completion = { eligible: c.total, submitted: c.submitted, timedOut: c.timedOut, inProgress: c.inProgress, notStarted: c.notStarted, missed: c.missed };
  if (!released) return { released: false as const, releasesAt, topics: [], completion };

  const rows = await db.$queryRaw<{ topic: string; questions: bigint; correct: bigint; participants: bigint }[]>(Prisma.sql`
    ${cte(a, closed)}
    SELECT COALESCE(NULLIF(btrim(q."topic"), ''), 'General') AS "topic", count(*) AS "questions",
           count(*) FILTER (WHERE i."outcome" = 'CORRECT') AS "correct", count(DISTINCT best."userId") AS "participants"
    FROM best JOIN "ExamResultItem" i ON i."resultId" = best."resultId" JOIN "ExamQuestionSnapshot" q ON q."id" = i."examQuestionId"
    GROUP BY 1 HAVING count(DISTINCT best."userId") >= ${MIN_TOPIC_PARTICIPANTS}`);
  const topics = rows
    .map((r) => ({ topic: r.topic, questions: Number(r.questions), participants: Number(r.participants), accuracyBp: accuracyBp(Number(r.correct), Number(r.questions)) }))
    .sort((x, y) => x.accuracyBp - y.accuracyBp || x.topic.localeCompare(y.topic));
  return { released: true as const, releasesAt, topics, completion };
}
