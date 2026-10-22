import { bandFromPercentBp, type Band } from "./bands.js";

/** Integer "centi-marks" (marks × 100) are used everywhere; no floating-point accumulation (PART4_SPEC §0.5, §7). */
export const toCenti = (marks: number): number => Math.round(marks * 100);
export const fromCenti = (centi: number): number => centi / 100;

/** Negative-marking fraction (0..1, ≤4 decimals) in basis points. */
export const fractionToBp = (fraction: number): number => Math.round(fraction * 10_000);

/** `negativeCenti = round_half_up(marksCenti × fractionBp / 10000)` (integer arithmetic). */
export function negativeCenti(marksCenti: number, fractionBp: number): number {
  return Math.floor((marksCenti * fractionBp * 2 + 10_000) / 20_000);
}

/** Percentage in basis points, rounded half up to 2 decimals: 8750 = 87.50 %. */
export function percentBpOf(scoreCenti: number, maxCenti: number): number {
  if (maxCenti <= 0) return 0;
  return Math.floor((scoreCenti * 10_000 * 2 + maxCenti) / (2 * maxCenti));
}

export type GradingQuestion = { id: string; marksCenti: number; negativeCenti: number; correctOptionId: string };
export type Outcome = "CORRECT" | "INCORRECT" | "UNANSWERED";
export type GradedItem = { examQuestionId: string; selectedOptionId: string | null; outcome: Outcome; awardedCenti: number };
export type Graded = {
  items: GradedItem[];
  rawScoreCenti: number;
  scoreCenti: number;
  maxCenti: number;
  percentBp: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  band: Band;
};

/**
 * Pure, deterministic grading from the published answer key and the stored selections (option ids only).
 * unanswered → 0; correct → +marks; wrong → −negative; the total is clamped at 0.
 */
export function gradeAttempt(questions: GradingQuestion[], selected: ReadonlyMap<string, string | null>): Graded {
  let raw = 0;
  let max = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  const items: GradedItem[] = questions.map((q) => {
    max += q.marksCenti;
    const sel = selected.get(q.id) ?? null;
    if (sel === null) {
      unanswered++;
      return { examQuestionId: q.id, selectedOptionId: null, outcome: "UNANSWERED", awardedCenti: 0 };
    }
    if (sel === q.correctOptionId) {
      correct++;
      raw += q.marksCenti;
      return { examQuestionId: q.id, selectedOptionId: sel, outcome: "CORRECT", awardedCenti: q.marksCenti };
    }
    incorrect++;
    raw -= q.negativeCenti;
    return { examQuestionId: q.id, selectedOptionId: sel, outcome: "INCORRECT", awardedCenti: -q.negativeCenti };
  });
  const score = Math.max(0, raw);
  const percentBp = percentBpOf(score, max);
  return { items, rawScoreCenti: raw, scoreCenti: score, maxCenti: max, percentBp, correct, incorrect, unanswered, band: bandFromPercentBp(percentBp) };
}

/** deadlineAt = min(startedAt + duration, closesAt) (closesAt optional). */
export function computeDeadline(startedAt: Date, durationSeconds: number, closesAt: Date | null): Date {
  const byDuration = startedAt.getTime() + durationSeconds * 1000;
  return new Date(closesAt ? Math.min(byDuration, closesAt.getTime()) : byDuration);
}

/** Constructive, never-blaming feedback copy for each band. */
export const FEEDBACK: Record<Band, { label: string; message: string }> = {
  EXCELLENT: { label: "Excellent", message: "Outstanding work — you have a strong grasp of this material. Keep it fresh with occasional revision." },
  GOOD: { label: "Good", message: "Good result. A little more practice on the questions you missed should take you to the top band." },
  NEEDS_IMPROVEMENT: { label: "Not good — needs improvement", message: "You're getting there. Review the questions you missed, then try again to lift your score." },
  BAD: { label: "Bad", message: "This topic needs more work. Go back over the material, focus on the weaker topics below and retry when you're ready." },
  VERY_BAD: { label: "Very bad", message: "This one was tough, and that's useful information. Start with the basics of the weaker topics below — steady practice will move this score." },
};
