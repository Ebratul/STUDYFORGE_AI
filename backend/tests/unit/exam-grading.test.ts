import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bandFromPercentBp } from "../../src/modules/exams/bands.js";
import { computeDeadline, fractionToBp, gradeAttempt, negativeCenti, percentBpOf, toCenti } from "../../src/modules/exams/grading.js";
import { isReleased, releaseTime } from "../../src/modules/exams/release.js";
import { orderOptions, orderQuestions, seededShuffle } from "../../src/modules/exams/shuffle.js";

const q = (id: string, marks = 100, neg = 0) => ({ id, marksCenti: marks, negativeCenti: neg, correctOptionId: `${id}-ok` });
const answers = (o: Record<string, string | null>) => new Map(Object.entries(o));

describe("centi-mark conversion and negative marking", () => {
  it("converts marks to integers without float drift", () => {
    expect(toCenti(1)).toBe(100);
    expect(toCenti(0.25)).toBe(25);
    expect(toCenti(1.1)).toBe(110);
    expect(toCenti(0.07 + 0.01)).toBe(8);
    expect(fractionToBp(0.25)).toBe(2500);
    expect(fractionToBp(1 / 3)).toBe(3333);
  });
  it("rounds the negative amount half up, in integers", () => {
    expect(negativeCenti(100, 2500)).toBe(25);
    expect(negativeCenti(100, 3333)).toBe(33);
    expect(negativeCenti(50, 3333)).toBe(17); // 16.665 → 17
    expect(negativeCenti(25, 2000)).toBe(5);
    expect(negativeCenti(100, 0)).toBe(0);
    expect(negativeCenti(100, 10_000)).toBe(100);
    expect(negativeCenti(1, 5000)).toBe(1); // 0.5 rounds up
    expect(negativeCenti(1, 4999)).toBe(0);
  });
});

describe("gradeAttempt", () => {
  const qs = [q("a", 100, 25), q("b", 200, 50), q("c", 100, 25), q("d", 100, 25)];
  it("awards correct, penalises incorrect, ignores unanswered", () => {
    const g = gradeAttempt(qs, answers({ a: "a-ok", b: "b-wrong", c: null }));
    expect(g.items.map((i) => [i.examQuestionId, i.outcome, i.awardedCenti])).toEqual([["a", "CORRECT", 100], ["b", "INCORRECT", -50], ["c", "UNANSWERED", 0], ["d", "UNANSWERED", 0]]);
    expect(g).toMatchObject({ rawScoreCenti: 50, scoreCenti: 50, maxCenti: 500, correct: 1, incorrect: 1, unanswered: 2, percentBp: 1000, band: "VERY_BAD" });
    expect(g.correct + g.incorrect + g.unanswered).toBe(qs.length);
  });
  it("treats a missing answer record and an explicit null identically", () => {
    expect(gradeAttempt(qs, answers({})).unanswered).toBe(4);
    expect(gradeAttempt(qs, answers({ a: null })).unanswered).toBe(4);
  });
  it("a perfect paper is 100% / Excellent; an empty paper is 0%", () => {
    expect(gradeAttempt(qs, answers({ a: "a-ok", b: "b-ok", c: "c-ok", d: "d-ok" }))).toMatchObject({ scoreCenti: 500, percentBp: 10_000, band: "EXCELLENT" });
    expect(gradeAttempt(qs, answers({}))).toMatchObject({ scoreCenti: 0, percentBp: 0, band: "VERY_BAD" });
  });
  it("clamps a negative total at zero but keeps the raw total", () => {
    const g = gradeAttempt(qs, answers({ a: "x", b: "x", c: "x", d: "a-ok-not" }));
    expect(g.rawScoreCenti).toBe(-125);
    expect(g.scoreCenti).toBe(0);
    expect(g.percentBp).toBe(0);
  });
  it("an answer that is not the key scores as incorrect even if it is the key of another question", () => {
    expect(gradeAttempt(qs, answers({ a: "b-ok" })).incorrect).toBe(1);
  });
  it("is order independent and deterministic", () => {
    const a = gradeAttempt(qs, answers({ a: "a-ok", c: "c-ok" }));
    const b = gradeAttempt([...qs].reverse(), answers({ c: "c-ok", a: "a-ok" }));
    expect([a.scoreCenti, a.percentBp, a.correct]).toEqual([b.scoreCenti, b.percentBp, b.correct]);
  });
  it("handles a quarter-mark exam without drift (40 × 0.25 marks)", () => {
    const many = Array.from({ length: 40 }, (_, i) => q(`q${i}`, 25, 6));
    const sel = Object.fromEntries(many.slice(0, 33).map((x) => [x.id, `${x.id}-ok`]));
    const g = gradeAttempt(many, answers(sel));
    expect(g.maxCenti).toBe(1000);
    expect(g.scoreCenti).toBe(825);
    expect(g.percentBp).toBe(8250);
  });
});

describe("percentage rounding (half up, 2 decimals)", () => {
  it.each([
    [1, 3, 3333], [2, 3, 6667], [1, 8, 1250], [1, 6, 1667], [5, 6, 8333], [1, 200, 50], [1, 400, 25], [199, 200, 9950], [0, 7, 0], [7, 7, 10_000],
    [1, 16, 625], [1, 32, 313] /* 3.125 → 3.13 */, [1, 3000, 3] /* 0.0333 → 0.03 */,
  ])("%i/%i → %i bp", (s, m, bp) => expect(percentBpOf(s, m)).toBe(bp));
  it("never returns more than 100% or less than 0%", () => {
    expect(percentBpOf(1000, 1000)).toBe(10_000);
    expect(percentBpOf(0, 1000)).toBe(0);
    expect(percentBpOf(5, 0)).toBe(0);
  });
});

describe("feedback bands: exact boundaries, ±1 basis point", () => {
  it.each([
    [10_000, "EXCELLENT"], [9001, "EXCELLENT"], [9000, "EXCELLENT"], [8999, "GOOD"], [8001, "GOOD"], [8000, "GOOD"], [7999, "NEEDS_IMPROVEMENT"],
    [7001, "NEEDS_IMPROVEMENT"], [7000, "NEEDS_IMPROVEMENT"], [6999, "BAD"], [6001, "BAD"], [6000, "BAD"], [5999, "VERY_BAD"], [1, "VERY_BAD"], [0, "VERY_BAD"],
  ])("%i bp → %s", (bp, band) => expect(bandFromPercentBp(bp)).toBe(band));
  it("a score a hair under 90% that displays as 90.00% is classed by the displayed value", () => {
    // 8999.5 bp rounds half up to 9000 → Excellent, consistent with what the participant sees
    expect(bandFromPercentBp(percentBpOf(89_995, 100_000))).toBe("EXCELLENT");
    expect(bandFromPercentBp(percentBpOf(89_994, 100_000))).toBe("GOOD");
  });
  it("every percentage maps to exactly one band (no gaps, no overlaps)", () => {
    const seen = new Set<string>();
    let prevRank = -1;
    const order = ["VERY_BAD", "BAD", "NEEDS_IMPROVEMENT", "GOOD", "EXCELLENT"];
    for (let bp = 0; bp <= 10_000; bp++) {
      const band = bandFromPercentBp(bp);
      seen.add(band);
      const rank = order.indexOf(band);
      expect(rank).toBeGreaterThanOrEqual(prevRank); // monotonic
      prevRank = rank;
    }
    expect(seen.size).toBe(5);
  });
});

describe("deadline math", () => {
  const start = new Date("2026-10-23T10:00:00.000Z");
  it("is start + duration without a closing time", () => {
    expect(computeDeadline(start, 1800, null).toISOString()).toBe("2026-10-23T10:30:00.000Z");
  });
  it("is capped at the closing time", () => {
    expect(computeDeadline(start, 1800, new Date("2026-10-23T10:10:00.000Z")).toISOString()).toBe("2026-10-23T10:10:00.000Z");
    expect(computeDeadline(start, 1800, new Date("2026-10-23T12:00:00.000Z")).toISOString()).toBe("2026-10-23T10:30:00.000Z");
    expect(computeDeadline(start, 1800, new Date("2026-10-23T10:30:00.000Z")).toISOString()).toBe("2026-10-23T10:30:00.000Z");
  });
});

describe("release predicate", () => {
  const closes = new Date("2026-10-23T12:00:00.000Z");
  const at = new Date("2026-10-23T15:00:00.000Z");
  it("IMMEDIATE is always released", () => {
    expect(isReleased({ releaseMode: "IMMEDIATE", closesAt: null, releaseAt: null }, new Date(0))).toBe(true);
    expect(releaseTime({ releaseMode: "IMMEDIATE", closesAt: null, releaseAt: null })).toBeNull();
  });
  it("AFTER_CLOSE releases at closesAt + grace, never before, never without a closing time", () => {
    const v = { releaseMode: "AFTER_CLOSE" as const, closesAt: closes, releaseAt: null };
    expect(releaseTime(v, 5)!.toISOString()).toBe("2026-10-23T12:00:05.000Z");
    expect(isReleased(v, new Date(closes.getTime() + 4999), 5)).toBe(false);
    expect(isReleased(v, new Date(closes.getTime() + 5000), 5)).toBe(true);
    expect(isReleased({ ...v, closesAt: null }, new Date(9e12), 5)).toBe(false);
  });
  it("AT_TIME releases at the stated time", () => {
    const v = { releaseMode: "AT_TIME" as const, closesAt: closes, releaseAt: at };
    expect(isReleased(v, new Date(at.getTime() - 1))).toBe(false);
    expect(isReleased(v, at)).toBe(true);
  });
});

describe("deterministic shuffle", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const base = { examVersionId: "v1", userId: "u1", attemptNo: 1 };

  /** An independent re-implementation of PART4_SPEC §6 used as an oracle for the production code. */
  function reference(items: string[], seedText: string): string[] {
    const seed = createHash("sha256").update(seedText).digest();
    let buf = Buffer.alloc(0);
    let ctr = 0;
    const u32 = () => {
      while (buf.length < 4) {
        const c = Buffer.alloc(4);
        c.writeUInt32BE(ctr++);
        buf = Buffer.concat([buf, createHash("sha256").update(Buffer.concat([seed, c])).digest()]);
      }
      const v = buf.readUInt32BE(0);
      buf = buf.subarray(4);
      return v;
    };
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const n = i + 1;
      const limit = Math.floor(2 ** 32 / n) * n;
      let v = u32();
      while (v >= limit) v = u32();
      const j = v % n;
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  it("matches fixed test vectors (regression guard)", () => {
    expect(orderQuestions(ids, base, true)).toEqual(["f", "b", "e", "d", "a", "c", "h", "g"]);
    expect(orderQuestions(ids, { ...base, attemptNo: 2 }, true)).toEqual(["f", "d", "c", "g", "a", "h", "b", "e"]);
    expect(orderQuestions(ids, { ...base, userId: "u2" }, true)).toEqual(["f", "g", "c", "e", "b", "a", "d", "h"]);
    expect(orderOptions(["o1", "o2", "o3", "o4"], "q1", base, true)).toEqual(["o2", "o3", "o1", "o4"]);
    expect(seededShuffle([1, 2, 3, 4, 5], "seed")).toEqual([1, 5, 3, 2, 4]);
  });
  it("agrees with an independent reference implementation of the spec", () => {
    expect(orderQuestions(ids, base, true)).toEqual(reference(ids, "sf-exam-order-v1|v1|u1|1"));
    expect(orderOptions(["o1", "o2", "o3", "o4"], "q1", base, true)).toEqual(reference(["o1", "o2", "o3", "o4"], "sf-exam-order-v1|v1|u1|1|q1"));
    for (let n = 0; n < 40; n++) expect(seededShuffle(ids, `s${n}`)).toEqual(reference(ids, `s${n}`));
  });
  it("is deterministic: the same inputs always give the same order", () => {
    expect(orderQuestions(ids, base, true)).toEqual(orderQuestions(ids, base, true));
  });
  it("differs across participants and attempts, but every order is a permutation of the same set", () => {
    const orders = new Set<string>();
    for (let u = 0; u < 30; u++) {
      const o = orderQuestions(ids, { ...base, userId: `user-${u}` }, true);
      expect([...o].sort()).toEqual([...ids].sort());
      orders.add(o.join(""));
    }
    expect(orders.size).toBeGreaterThan(25);
    expect(orderQuestions(ids, { ...base, attemptNo: 2 }, true)).not.toEqual(orderQuestions(ids, base, true));
  });
  it("is the identity when shuffling is off and never mutates its input", () => {
    const copy = [...ids];
    expect(orderQuestions(ids, base, false)).toEqual(ids);
    orderQuestions(ids, base, true);
    expect(ids).toEqual(copy);
    expect(orderOptions(["x", "y"], "q", base, false)).toEqual(["x", "y"]);
  });
  it("is statistically fair: each element lands in each position about equally (no modulo bias)", () => {
    const counts = Array.from({ length: 3 }, () => [0, 0, 0]);
    const N = 3000;
    for (let i = 0; i < N; i++) seededShuffle(["x", "y", "z"], `fair-${i}`).forEach((v, pos) => counts[["x", "y", "z"].indexOf(v)]![pos]!++);
    for (const row of counts) for (const c of row) expect(Math.abs(c - N / 3)).toBeLessThan(N * 0.05);
  });
  it("handles empty and single-item inputs", () => {
    expect(seededShuffle([], "s")).toEqual([]);
    expect(seededShuffle(["only"], "s")).toEqual(["only"]);
  });
});
