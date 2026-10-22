import { describe, expect, it } from "vitest";
import {
  BAND_INFO, BAND_ORDER, countAnswered, countMarked, crossedMilestone, DEFAULT_DRAFT, draftIsSendable, draftPayload, factsFromDraft, fieldMessage, formatCenti, formatClock, formatDuration,
  formatMarks, formatPercentBp, isoToLocalInput, localInputToIso, milestoneText, moveId, navState, normalizeDraft, optionLetter, remainingFromSync, resolveExamLimits, rulesInWords, stepForField,
  syncClock, timerTone, validateDraftLocal, type ExamDraftInput, type LocalAnswer,
} from "@/lib/exams";

const limits = resolveExamLimits(null);
const draft = (over: Partial<ExamDraftInput> = {}): ExamDraftInput => ({ ...DEFAULT_DRAFT, title: "Cells", questionIds: ["a", "b"], ...over });

describe("formatting of server integers", () => {
  it("centi-marks", () => {
    expect(formatCenti(0)).toBe("0");
    expect(formatCenti(100)).toBe("1");
    expect(formatCenti(250)).toBe("2.5");
    expect(formatCenti(25)).toBe("0.25");
    expect(formatCenti(105)).toBe("1.05");
    expect(formatCenti(-25)).toBe("-0.25");
    expect(formatCenti(12345)).toBe("123.45");
  });
  it("percentage basis points always show two decimals", () => {
    expect(formatPercentBp(0)).toBe("0.00%");
    expect(formatPercentBp(8750)).toBe("87.50%");
    expect(formatPercentBp(8999)).toBe("89.99%");
    expect(formatPercentBp(9000)).toBe("90.00%");
    expect(formatPercentBp(10000)).toBe("100.00%");
    expect(formatPercentBp(5)).toBe("0.05%");
  });
  it("marks, durations and the clock", () => {
    expect(formatMarks(2)).toBe("2");
    expect(formatMarks(0.25)).toBe("0.25");
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(60)).toBe("1 h");
    expect(formatDuration(90)).toBe("1 h 30 min");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59_001)).toBe("1:00"); // rounds up: never shows 0:00 while time remains
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_661_000)).toBe("1:01:01");
    expect(formatClock(-5)).toBe("0:00");
  });
  it("option letters", () => expect([0, 1, 5].map(optionLetter)).toEqual(["A", "B", "F"]));
  it("local date-time <-> UTC ISO round-trips", () => {
    const iso = "2026-10-23T14:30:00.000Z";
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("not a date")).toBeNull();
    expect(isoToLocalInput(null)).toBe("");
    expect(isoToLocalInput("garbage")).toBe("");
  });
});

describe("bands: wording only, with the exact thresholds", () => {
  it("lists the five bands in order with the specified ranges", () => {
    expect(BAND_ORDER).toEqual(["EXCELLENT", "GOOD", "NEEDS_IMPROVEMENT", "BAD", "VERY_BAD"]);
    expect(BAND_INFO.EXCELLENT.range).toBe("90% – 100%");
    expect(BAND_INFO.GOOD.range).toBe("80% – below 90%");
    expect(BAND_INFO.NEEDS_IMPROVEMENT.range).toBe("70% – below 80%");
    expect(BAND_INFO.BAD.range).toBe("60% – below 70%");
    expect(BAND_INFO.VERY_BAD.range).toBe("Below 60%");
    expect(BAND_INFO.NEEDS_IMPROVEMENT.label).toMatch(/not good/i);
  });
  it("feedback is constructive: every message encourages and none blames", () => {
    for (const b of BAND_ORDER) {
      expect(BAND_INFO[b].message.length).toBeGreaterThan(40);
      expect(BAND_INFO[b].message).not.toMatch(/\b(stupid|lazy|fail(ed|ure)|hopeless|terrible)\b/i);
    }
  });
});

describe("countdown: server remainingMs + monotonic time only", () => {
  it("counts down from the last server value", () => {
    const s = syncClock(60_000, 1_000);
    expect(remainingFromSync(s, 1_000)).toBe(60_000);
    expect(remainingFromSync(s, 11_000)).toBe(50_000);
    expect(remainingFromSync(s, 61_000)).toBe(0);
    expect(remainingFromSync(s, 90_000)).toBe(0); // never negative
  });
  it("a monotonic clock that appears to go backwards cannot add time", () => {
    const s = syncClock(10_000, 5_000);
    expect(remainingFromSync(s, 4_000)).toBe(10_000);
  });
  it("re-syncing replaces the value (the server's answer always wins)", () => {
    const s1 = syncClock(30_000, 0);
    const s2 = syncClock(28_000, 4_000); // the server says 28 s left at t=4 s: we had been showing 26 s
    expect(remainingFromSync(s1, 4_000)).toBe(26_000);
    expect(remainingFromSync(s2, 4_000)).toBe(28_000);
    expect(syncClock(-5, 0).remainingMs).toBe(0);
  });
  it("does not read the device wall clock: no Date.now / new Date in the countdown helpers", () => {
    const realNow = Date.now;
    Date.now = () => { throw new Error("wall clock used"); };
    try {
      expect(remainingFromSync(syncClock(5_000, 0), 1_000)).toBe(4_000);
      expect(formatClock(4_000)).toBe("0:04");
      expect(crossedMilestone(61_000, 59_000)).toBe(60_000);
    } finally {
      Date.now = realNow;
    }
  });
  it("announces milestones once, when crossed (not every second)", () => {
    expect(crossedMilestone(700_000, 599_000)).toBe(600_000);
    expect(crossedMilestone(599_000, 598_000)).toBeNull();
    expect(crossedMilestone(301_000, 299_000)).toBe(300_000);
    expect(crossedMilestone(31_000, 29_000)).toBe(30_000);
    expect(crossedMilestone(11_000, 9_000)).toBe(10_000);
    expect(milestoneText(300_000)).toBe("5 minutes remaining");
    expect(milestoneText(60_000)).toBe("1 minute remaining");
    expect(milestoneText(10_000)).toBe("10 seconds remaining");
  });
  it("timer tone", () => {
    expect(timerTone(600_000)).toBe("normal");
    expect(timerTone(300_000)).toBe("warning");
    expect(timerTone(60_000)).toBe("danger");
  });
});

describe("navigator state", () => {
  const a = (optionId: string | null, marked = false): LocalAnswer => ({ optionId, marked, seq: 1, confirmedSeq: 1, savedAt: null });
  it("derives answered / marked / unanswered / current", () => {
    expect(navState(undefined, false)).toBe("unanswered");
    expect(navState(a("o1"), false)).toBe("answered");
    expect(navState(a(null, true), false)).toBe("marked");
    expect(navState(a("o1", true), false)).toBe("answered-marked");
    expect(navState(a("o1", true), true)).toBe("current");
  });
  it("counts", () => {
    const m = new Map<string, LocalAnswer>([["q1", a("o1")], ["q2", a(null, true)], ["q3", a("o2", true)]]);
    const qs = [{ id: "q1" }, { id: "q2" }, { id: "q3" }, { id: "q4" }];
    expect(countAnswered(qs, m)).toBe(2);
    expect(countMarked(qs, m)).toBe(2);
  });
});

describe("draft handling", () => {
  it("fills a brand-new empty draft with defaults", () => {
    const d = normalizeDraft({}, { title: "T", description: "D" });
    expect(d).toMatchObject({ title: "T", description: "D", questionIds: [], durationMinutes: 30, attemptLimit: 1, reviewPolicy: "FULL" });
    expect(d.release.mode).toBe("IMMEDIATE");
  });
  it("only sends finite numbers and selected overrides, trimmed", () => {
    const p = draftPayload(draft({ title: "  Cells  ", description: "  ", marks: { perQuestion: 2, overrides: { a: 3, zzz: 4, b: Number.NaN } } }));
    expect(p.title).toBe("Cells");
    expect(p.description).toBeNull();
    expect(p.marks).toEqual({ perQuestion: 2, overrides: { a: 3 } });
    expect(draftIsSendable(draft())).toBe(true);
    expect(draftIsSendable(draft({ durationMinutes: Number.NaN }))).toBe(false);
    expect(draftIsSendable(draft({ title: "  " }))).toBe(false);
  });
  it("moveId", () => {
    expect(moveId(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveId(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
  it("maps server field paths to wizard steps and finds the most specific message", () => {
    expect(stepForField("title")).toBe("details");
    expect(stepForField("questionIds.3")).toBe("questions");
    expect(stepForField("window.closesAt")).toBe("rules");
    expect(stepForField("marks.overrides.x")).toBe("rules");
    expect(fieldMessage({ "questionIds.2": "bad" }, "questionIds")).toBe("bad");
    expect(fieldMessage({ durationMinutes: "too long" }, "durationMinutes")).toBe("too long");
    expect(fieldMessage({}, "x")).toBeUndefined();
  });
});

describe("advisory local validation (the server validates again)", () => {
  const v = (over: Partial<ExamDraftInput>) => validateDraftLocal(draft(over), limits, "INDIVIDUAL");
  it("accepts a sound draft", () => expect(v({})).toEqual({}));
  it("flags out-of-range numbers", () => {
    expect(v({ durationMinutes: 0 })).toHaveProperty("durationMinutes");
    expect(v({ durationMinutes: limits.maxDurationMinutes + 1 })).toHaveProperty("durationMinutes");
    expect(v({ attemptLimit: 0 })).toHaveProperty("attemptLimit");
    expect(v({ marks: { perQuestion: 0.1 } })).toHaveProperty(["marks.perQuestion"]);
    expect(v({ negativeMarking: { fraction: 1.5 } })).toHaveProperty(["negativeMarking.fraction"]);
    expect(v({ questionIds: [] })).toHaveProperty("questionIds");
  });
  it("window and release rules", () => {
    expect(v({ window: { opensAt: "2026-10-23T10:00:00Z", closesAt: "2026-10-23T09:00:00Z" } })).toHaveProperty(["window.closesAt"]);
    expect(v({ release: { mode: "AFTER_CLOSE", at: null } })).toHaveProperty(["release.mode"]);
    expect(v({ release: { mode: "AT_TIME", at: null } })).toHaveProperty(["release.at"]);
    expect(v({ window: { opensAt: null, closesAt: "2026-10-23T12:00:00Z" }, release: { mode: "AT_TIME", at: "2026-10-23T11:00:00Z" } })).toHaveProperty(["release.at"]);
    expect(v({ window: { opensAt: "2026-10-23T10:00:00Z", closesAt: "2026-10-23T10:20:00Z" }, durationMinutes: 30, lateStart: "FULL_TIME_ONLY" })).toHaveProperty(["window.closesAt"]);
    expect(v({ reminderMinutes: 15 })).toHaveProperty("reminderMinutes"); // needs an opening time
  });
});

describe("rules in plain words", () => {
  it("describes timing, negative marking, order, review and release", () => {
    const text = rulesInWords(factsFromDraft(draft({ durationMinutes: 45, attemptLimit: 3, negativeMarking: { fraction: 0.25 }, shuffleQuestions: true, shuffleOptions: true, reviewPolicy: "CORRECTNESS", release: { mode: "AFTER_CLOSE", at: null }, window: { opensAt: null, closesAt: "2026-10-23T12:00:00Z" }, lateStart: "FULL_TIME_ONLY" }), { totalMarks: 10 })).join(" ");
    expect(text).toContain("45 min");
    expect(text).toContain("Up to 3 attempts");
    expect(text).toContain("25%");
    expect(text).toMatch(/Questions and answer options appear in a different order/);
    expect(text).toMatch(/right or wrong/);
    expect(text).toMatch(/after the exam closes/);
    expect(text).toMatch(/full duration/);
    expect(text).toContain("10 marks in total");
  });
  it("says so when there is no negative marking", () => {
    expect(rulesInWords(factsFromDraft(draft())).join(" ")).toMatch(/No negative marking/);
  });
});

describe("limits", () => {
  it("fall back to the spec defaults and read server values", () => {
    expect(limits).toMatchObject({ maxQuestions: 200, maxDurationMinutes: 360, maxAttemptLimit: 10, graceSeconds: 5 });
    expect(resolveExamLimits({ limits: { examMaxQuestions: 50, examMaxDurationMinutes: 90 } })).toMatchObject({ maxQuestions: 50, maxDurationMinutes: 90, maxAttemptLimit: 10 });
  });
});
