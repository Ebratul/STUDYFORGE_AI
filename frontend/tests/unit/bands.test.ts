import { describe, expect, it } from "vitest";
import { BAND_INFO, BAND_LABEL, BAND_ORDER, bandForPercentBp, bandLabel, isBand } from "@/lib/bands";
import * as exams from "@/lib/exams";
import * as leaderboard from "@/lib/leaderboard";

describe("one shared band classification", () => {
  it.each([
    [0, "VERY_BAD"], [5999, "VERY_BAD"], [6000, "BAD"], [6999, "BAD"], [7000, "NEEDS_IMPROVEMENT"], [7999, "NEEDS_IMPROVEMENT"],
    [8000, "GOOD"], [8999, "GOOD"], [9000, "EXCELLENT"], [9999, "EXCELLENT"], [10000, "EXCELLENT"],
  ])("%i basis points -> %s", (bp, band) => {
    expect(bandForPercentBp(bp)).toBe(band);
  });

  it("uses the exact wording from the spec for the five bands, in order", () => {
    expect(BAND_ORDER).toEqual(["EXCELLENT", "GOOD", "NEEDS_IMPROVEMENT", "BAD", "VERY_BAD"]);
    expect(BAND_INFO.EXCELLENT.range).toBe("90% – 100%");
    expect(BAND_INFO.GOOD.range).toBe("80% – below 90%");
    expect(BAND_INFO.NEEDS_IMPROVEMENT.range).toBe("70% – below 80%");
    expect(BAND_INFO.BAD.range).toBe("60% – below 70%");
    expect(BAND_INFO.VERY_BAD.range).toBe("Below 60%");
    expect(bandLabel("NEEDS_IMPROVEMENT")).toMatch(/not good.*needs improvement/i);
  });

  it("keeps feedback supportive and practical", () => {
    for (const b of BAND_ORDER) {
      expect(BAND_INFO[b].message.length).toBeGreaterThan(40);
      expect(BAND_INFO[b].message).not.toMatch(/\b(stupid|lazy|hopeless|terrible|fail(ed|ure)?)\b/i);
    }
  });

  it("exams and leaderboard use the same tables (no second copy)", () => {
    expect(exams.BAND_INFO).toBe(BAND_INFO);
    expect(exams.BAND_ORDER).toBe(BAND_ORDER);
    expect(leaderboard.BAND_LABEL).toBe(BAND_LABEL);
  });

  it("recognises only real bands", () => {
    expect(isBand("GOOD")).toBe(true);
    expect(isBand("good")).toBe(false);
    expect(isBand(null)).toBe(false);
  });
});
