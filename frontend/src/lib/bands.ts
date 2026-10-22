/**
 * The ONE place that defines result bands for the UI (docs/PART4_SPEC.md §7, docs/PART5_SPEC.md §0.2).
 * The band of a result is decided by the server (`bandFromPercentBp` in the backend) and always arrives with the data; this module only
 * holds labels, ranges, tone and constructive wording, plus `bandForPercentBp` — a mirror of the backend rule used by tests and as a
 * display fallback for percentages that arrive without a band.
 */

import { msg } from "@/lib/i18n/translate";

export type FeedbackBand = "EXCELLENT" | "GOOD" | "NEEDS_IMPROVEMENT" | "BAD" | "VERY_BAD";
export type BandTone = "success" | "primary" | "warning" | "orange" | "destructive";

export const BAND_ORDER: FeedbackBand[] = ["EXCELLENT", "GOOD", "NEEDS_IMPROVEMENT", "BAD", "VERY_BAD"];

export const BAND_INFO: Record<FeedbackBand, { label: string; range: string; tone: BandTone; message: string }> = {
  EXCELLENT: { label: msg("Excellent"), range: msg("90% – 100%"), tone: "success", message: msg("Outstanding work. You have a strong grip on this material — keep revising to stay sharp.") },
  GOOD: { label: msg("Good"), range: msg("80% – below 90%"), tone: "primary", message: msg("Good result. A little more practice on the questions you missed will push you into the top band.") },
  NEEDS_IMPROVEMENT: { label: msg("Not good — needs improvement"), range: msg("70% – below 80%"), tone: "warning", message: msg("You're getting there. Review the topics below and try again — steady practice makes a real difference.") },
  BAD: { label: msg("Bad"), range: msg("60% – below 70%"), tone: "orange", message: msg("This one was tough. Start with the explanations for the questions you missed, then retry when you feel ready.") },
  VERY_BAD: { label: msg("Very bad"), range: msg("Below 60%"), tone: "destructive", message: msg("This attempt didn't go the way you wanted, and that's okay. Go through the review, focus on one topic at a time, and try again.") },
};

export const bandLabel = (b: FeedbackBand): string => BAND_INFO[b].label;
export const BAND_LABEL: Record<FeedbackBand, string> = Object.fromEntries(BAND_ORDER.map((b) => [b, BAND_INFO[b].label])) as Record<FeedbackBand, string>;

/** Exact, non-overlapping thresholds on the displayed percentage in basis points (9000 = 90.00 %). Mirrors backend `bandFromPercentBp`. */
export function bandForPercentBp(percentBp: number): FeedbackBand {
  if (percentBp >= 9000) return "EXCELLENT";
  if (percentBp >= 8000) return "GOOD";
  if (percentBp >= 7000) return "NEEDS_IMPROVEMENT";
  if (percentBp >= 6000) return "BAD";
  return "VERY_BAD";
}

export const isBand = (v: unknown): v is FeedbackBand => typeof v === "string" && (BAND_ORDER as string[]).includes(v);

/** Badge classes per tone (text + border + background), shared by the result page, dashboard and leaderboard. */
export const BAND_TONE_CLASS: Record<BandTone, string> = {
  success: "border-success/40 bg-success-soft text-success",
  primary: "border-primary/30 bg-info-soft text-primary",
  warning: "border-warning/50 bg-warning-soft text-amber-800 dark:text-amber-200",
  orange: "border-orange-500/40 bg-orange-50 text-orange-800 dark:bg-orange-950/40 dark:text-orange-200",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
};
