export type Band = "EXCELLENT" | "GOOD" | "NEEDS_IMPROVEMENT" | "BAD" | "VERY_BAD";

/** Feedback band from the displayed percentage (basis points: 8750 = 87.50 %). Exact, non-overlapping boundaries (PART4_SPEC §7). */
export function bandFromPercentBp(percentBp: number): Band {
  if (percentBp >= 9000) return "EXCELLENT";
  if (percentBp >= 8000) return "GOOD";
  if (percentBp >= 7000) return "NEEDS_IMPROVEMENT";
  if (percentBp >= 6000) return "BAD";
  return "VERY_BAD";
}

export const BAND_LABEL: Record<Band, string> = {
  EXCELLENT: "Excellent",
  GOOD: "Good",
  NEEDS_IMPROVEMENT: "Not good — needs improvement",
  BAD: "Bad",
  VERY_BAD: "Very bad",
};

export type DistributionBand = "BELOW_60" | "60_70" | "70_80" | "80_90" | "90_100";
export const DISTRIBUTION: { band: DistributionBand; label: string; minBp: number; maxBpExclusive: number }[] = [
  { band: "BELOW_60", label: "Below 60%", minBp: 0, maxBpExclusive: 6000 },
  { band: "60_70", label: "60% – below 70%", minBp: 6000, maxBpExclusive: 7000 },
  { band: "70_80", label: "70% – below 80%", minBp: 7000, maxBpExclusive: 8000 },
  { band: "80_90", label: "80% – below 90%", minBp: 8000, maxBpExclusive: 9000 },
  { band: "90_100", label: "90% – 100%", minBp: 9000, maxBpExclusive: 10001 },
];
