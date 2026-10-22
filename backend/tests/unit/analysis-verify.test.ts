import { describe, expect, it } from "vitest";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { INITIAL_CAVEAT, verifyPlan } from "../../src/modules/analysis/plan.js";
import { classifyFailure, verifyAnalysis } from "../../src/modules/analysis/service.js";
import { AppError } from "../../src/lib/errors.js";

const ok = { summary: "You answered 4 of 8 correctly.", strengths: [{ topic: "A", detail: "d" }], weaknesses: [{ topic: "B", detail: "d", evidence: "0 of 4 correct" }], next_steps: [{ type: "REVIEW_NOTES", topic: "B", text: "t" }], caveats: [] };
const b = { topicNames: new Set(["A", "B"]), weak: new Set(["B"]), strong: new Set(["A"]) };

describe("verifyAnalysis (backend re-validation)", () => {
  it("accepts grounded output and normalises snake_case steps", () => {
    const c = verifyAnalysis(ok as never, b);
    expect(c?.nextSteps).toEqual([{ type: "REVIEW_NOTES", topic: "B", text: "t" }]);
  });
  it("rejects topics outside the data, strengths that aren't strong, weaknesses that aren't weak", () => {
    expect(verifyAnalysis({ ...ok, strengths: [{ topic: "B", detail: "d" }] } as never, b)).toBeNull();
    expect(verifyAnalysis({ ...ok, weaknesses: [{ topic: "A", detail: "d", evidence: "e" }] } as never, b)).toBeNull();
    expect(verifyAnalysis({ ...ok, next_steps: [{ type: "REVIEW_NOTES", topic: "Z", text: "t" }] } as never, b)).toBeNull();
  });
  it("rejects malformed shapes: unknown step type, extra keys, no steps, oversize text, too many items", () => {
    expect(verifyAnalysis({ ...ok, next_steps: [{ type: "BUY_COURSE", topic: null, text: "t" }] } as never, b)).toBeNull();
    expect(verifyAnalysis({ ...ok, score: 100 } as never, b)).not.toBeNull(); // unknown top-level keys are dropped, not trusted: only mapped fields are read
    expect(verifyAnalysis({ ...ok, next_steps: [] } as never, b)).toBeNull();
    expect(verifyAnalysis({ ...ok, summary: "x".repeat(601) } as never, b)).toBeNull();
    expect(verifyAnalysis({ ...ok, caveats: ["a", "b", "c", "d"] } as never, b)).toBeNull();
    expect(verifyAnalysis({ ...ok, strengths: Array.from({ length: 5 }, () => ({ topic: "A", detail: "d" })) } as never, b)).toBeNull();
  });
});

describe("verifyPlan", () => {
  const d = { level: "INITIAL", topics: [{ topic: "A", questions: 4, correct: 4, incorrect: 0, unanswered: 0, accuracyBp: 10000, sufficient: true }], weak: [], strong: [], notEnough: [], percents: [5000], resultCount: 1 } as never;
  const plan = { headline: "h", focus: [{ topic: "A", reason: "r" }], steps: [{ type: "PRACTICE_MCQ", topic: "A", text: "t", minutes: 15 }], caveats: [] };
  it("forces the initial-suggestions caveat unless there is history, and rejects unknown topics", () => {
    expect(verifyPlan(plan as never, d)?.caveats[0]).toBe(INITIAL_CAVEAT);
    expect(verifyPlan(plan as never, { ...(d as object), level: "BASED_ON_HISTORY" } as never)?.caveats).toEqual([]);
    expect(verifyPlan({ ...plan, focus: [{ topic: "Z", reason: "r" }] } as never, d)).toBeNull();
    expect(verifyPlan({ ...plan, steps: [{ type: "PRACTICE_MCQ", topic: "Z", text: "t", minutes: 1 }] } as never, d)).toBeNull();
    expect(verifyPlan({ ...plan, steps: [{ type: "PRACTICE_MCQ", topic: null, text: "t", minutes: 999 }] } as never, d)).toBeNull();
  });
});

describe("classifyFailure", () => {
  it("separates transient from permanent errors and keeps rag_agent's reason", () => {
    expect(classifyFailure(new RagAgentError("PROVIDER_RATE_LIMITED", "m", true))).toMatchObject({ code: "PROVIDER_RATE_LIMITED", transient: true });
    expect(classifyFailure(new RagAgentError("UPSTREAM_UNAVAILABLE", "m", true))).toMatchObject({ transient: true });
    expect(classifyFailure(new RagAgentError("PROVIDER_AUTH_INVALID", "m"))).toMatchObject({ transient: false });
    expect(classifyFailure(new RagAgentError("GENERATION_FAILED", "m", false, null, 502, "UNGROUNDED_OUTPUT"))).toMatchObject({ code: "UNGROUNDED_OUTPUT", transient: false });
    expect(classifyFailure(new AppError("QUOTA_EXCEEDED", "m"))).toMatchObject({ code: "QUOTA_EXCEEDED", transient: false });
    expect(classifyFailure(new Error("boom"))).toMatchObject({ code: "INTERNAL", transient: false });
  });
});
