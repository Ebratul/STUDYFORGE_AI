import { db } from "../../src/lib/db.js";
import { bandOf, percentBpOf, seedPublishedExam } from "./exam-fixtures.js";
import type { TestUser } from "./users.js";

export type Seeded = Awaited<ReturnType<typeof seedPublishedExam>>;
export type Outcome = "C" | "I" | "U";

/**
 * Inserts a finalized attempt + a CORRECTLY computed result + item rows (outcomes per question position; the seeded exam has 100 centi-marks
 * per question, topic "Topic A" for even positions and "Topic B" for odd ones). Option 0 is correct; incorrect answers choose option 1.
 */
export async function seedGradedResult(opts: { exam: Seeded; user: TestUser; outcomes: Outcome[]; attemptNo?: number; finalizedAt?: Date }) {
  const { exam, user, outcomes } = opts;
  const finalizedAt = opts.finalizedAt ?? new Date(Date.now() - 60_000);
  const startedAt = new Date(finalizedAt.getTime() - 600_000);
  const attempt = await db.examAttempt.create({
    data: {
      examVersionId: exam.version.id, userId: user.id, attemptNo: opts.attemptNo ?? 1, status: "SUBMITTED", startedAt, deadlineAt: new Date(startedAt.getTime() + 3_600_000),
      submittedAt: finalizedAt, finalizedAt, questionOrder: exam.questions.map((q) => q.id), optionOrder: {},
    },
  });
  const correct = outcomes.filter((o) => o === "C").length;
  const incorrect = outcomes.filter((o) => o === "I").length;
  const score = correct * exam.questions[0]!.marksCenti;
  const max = exam.version.totalCenti;
  const percentBp = percentBpOf(score, max);
  const result = await db.examResult.create({
    data: {
      attemptId: attempt.id, examVersionId: exam.version.id, userId: user.id, rawScoreCenti: score, scoreCenti: score, maxCenti: max, percentBp,
      correctCount: correct, incorrectCount: incorrect, unansweredCount: outcomes.length - correct - incorrect, band: bandOf(percentBp), finalizedAt,
    },
  });
  await db.examResultItem.createMany({
    data: exam.questions.map((q, i) => ({
      resultId: result.id, examQuestionId: q.id, selectedOptionId: outcomes[i] === "C" ? q.optionIds[0]! : outcomes[i] === "I" ? q.optionIds[1]! : null,
      outcome: outcomes[i] === "C" ? ("CORRECT" as const) : outcomes[i] === "I" ? ("INCORRECT" as const) : ("UNANSWERED" as const), awardedCenti: outcomes[i] === "C" ? q.marksCenti : 0,
    })),
  });
  return { attempt, result };
}

/** Outcome string like "CCII" → array (positions beyond the string default to U). */
export const outcomesOf = (s: string, n = s.length): Outcome[] => Array.from({ length: n }, (_, i) => (s[i] as Outcome | undefined) ?? "U");
