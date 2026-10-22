import type { SessionUser } from "../../auth/types.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { finalizeIfExpired } from "./attempts.js";
import { checkStart } from "./eligibility.js";
import { FEEDBACK, percentBpOf } from "./grading.js";
import { isReleased, releaseTime } from "./release.js";

/**
 * Result of one finalized attempt, honouring the release and review policies (PART4_SPEC §8).
 * Before release NOTHING about the score or the answers is returned.
 */
export async function getResult(user: SessionUser, attemptId: string) {
  const own = await db.examAttempt.findFirst({ where: { id: attemptId, userId: user.id }, select: { id: true, status: true } });
  if (!own) throw Errors.notFound();
  if (own.status === "IN_PROGRESS") await finalizeIfExpired(attemptId);
  const a = await db.examAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { result: { include: { items: true } }, examVersion: { include: { exam: { select: { id: true, status: true, mode: true, ownerId: true, groupId: true, publishedAt: true } } } } },
  });
  if (a.status === "IN_PROGRESS" || !a.result) throw new AppError("CONFLICT", "This attempt hasn't been submitted yet.", { status: a.status });
  const v = a.examVersion;
  const at = clockNow();
  const released = isReleased(v, at);
  const base = {
    attemptId: a.id,
    examId: v.examId,
    examTitle: v.title,
    status: a.status,
    attemptNo: a.attemptNo,
    submittedAt: a.submittedAt?.toISOString() ?? null,
    finalizedAt: a.finalizedAt?.toISOString() ?? null,
    release: { released, mode: v.releaseMode, releasesAt: releaseTime(v)?.toISOString() ?? null },
  };
  if (!released) return base;

  const r = a.result;
  const questions = await db.examQuestionSnapshot.findMany({ where: { examVersionId: v.id }, orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } });
  const qById = new Map(questions.map((q) => [q.id, q]));
  const itemById = new Map(r.items.map((i) => [i.examQuestionId, i]));

  // topic-level performance
  const topics = new Map<string, { topic: string; questions: number; correct: number; incorrect: number; unanswered: number; awarded: number; max: number }>();
  for (const q of questions) {
    const key = q.topic ?? "General";
    const t = topics.get(key) ?? { topic: key, questions: 0, correct: 0, incorrect: 0, unanswered: 0, awarded: 0, max: 0 };
    const it = itemById.get(q.id);
    t.questions++;
    t.max += q.marksCenti;
    t.awarded += it?.awardedCenti ?? 0;
    if (it?.outcome === "CORRECT") t.correct++;
    else if (it?.outcome === "INCORRECT") t.incorrect++;
    else t.unanswered++;
    topics.set(key, t);
  }

  const stored = Array.isArray(a.questionOrder) ? (a.questionOrder as string[]).filter((id) => qById.has(id)) : [];
  const order = [...stored, ...questions.map((q) => q.id).filter((id) => !stored.includes(id))];
  const optOrder = (a.optionOrder ?? {}) as Record<string, string[]>;
  const review =
    v.reviewPolicy === "NONE"
      ? undefined
      : order.map((qid, i) => {
          const q = qById.get(qid)!;
          const it = itemById.get(qid);
          const ids = (optOrder[qid] ?? []).filter((o) => q.options.some((x) => x.id === o));
          const optIds = [...ids, ...q.options.map((o) => o.id).filter((o) => !ids.includes(o))];
          const item = {
            position: i + 1, questionId: qid, stem: q.stem, options: optIds.map((oid) => ({ id: oid, text: q.options.find((o) => o.id === oid)!.text })),
            selectedOptionId: it?.selectedOptionId ?? null, outcome: it?.outcome ?? "UNANSWERED", awardedCenti: it?.awardedCenti ?? 0,
          };
          return v.reviewPolicy === "FULL"
            ? { ...item, correctOptionId: q.options.find((o) => o.isCorrect)?.id ?? null, explanation: q.explanation, shortNote: q.shortNote, sources: q.sources }
            : item;
        });

  const used = await db.examAttempt.count({ where: { examVersionId: v.id, userId: user.id } });
  const attemptsLeft = Math.max(0, v.attemptLimit - used);
  const check = await checkStart(user.id, v.exam, v, at);
  const retry = { allowed: check.allowed, attemptsLeft };

  const f = FEEDBACK[r.band];
  return {
    ...base,
    score: { scoreCenti: r.scoreCenti, maxCenti: r.maxCenti, percentBp: r.percentBp, correct: r.correctCount, incorrect: r.incorrectCount, unanswered: r.unansweredCount, band: r.band, feedback: { label: f.label, message: f.message } },
    topics: [...topics.values()]
      .map((t) => ({ topic: t.topic, questions: t.questions, correct: t.correct, incorrect: t.incorrect, unanswered: t.unanswered, percentBp: percentBpOf(Math.max(0, t.awarded), t.max) }))
      .sort((x, y) => x.percentBp - y.percentBp || x.topic.localeCompare(y.topic)),
    reviewPolicy: v.reviewPolicy,
    ...(review ? { review } : {}),
    retry,
  };
}
