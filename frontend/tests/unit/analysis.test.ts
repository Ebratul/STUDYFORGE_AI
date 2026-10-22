import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFailure, isPending, pollDelay, readAnalysis, readPlanData, stepHref } from "@/lib/analysis";
import { readSession, stashPrompt, takePrompt } from "@/lib/assistant";

afterEach(() => vi.unstubAllGlobals());

describe("AI feedback response", () => {
  it("reads a ready analysis, wrapped or bare, and keeps the deterministic feedback", () => {
    const body = {
      attemptId: "a1", status: "READY", dataLevel: "INITIAL", canRetry: false, generatedAt: "2026-01-01T00:00:00Z", provider: "mock", model: "mock-chat",
      deterministic: { band: "GOOD", label: "Good", message: "Nice", percentBp: 8250 },
      content: { summary: "Well done.", strengths: [{ topic: "Cells", detail: "6 of 6" }], weaknesses: [{ topic: "Energy", detail: "needs work", evidence: "1 of 4 correct" }, {}], nextSteps: [{ type: "PRACTICE_MCQ", topic: "Energy", text: "Try 5 MCQs" }, { text: "" }], caveats: ["One exam only."] },
      disclaimer: "AI-generated from your verified results. It does not change your score.",
    };
    for (const raw of [body, { analysis: body }]) {
      const a = readAnalysis(raw);
      expect(a.status).toBe("READY");
      expect(a.deterministic).toMatchObject({ band: "GOOD", percentBp: 8250 });
      expect(a.content!.weaknesses).toHaveLength(1);
      expect(a.content!.nextSteps).toHaveLength(1);
      expect(a.content!.caveats).toEqual(["One exam only."]);
    }
  });
  it("treats unknown statuses as NONE and always supplies a disclaimer", () => {
    const a = readAnalysis({ status: "???" });
    expect(a.status).toBe("NONE");
    expect(a.content).toBeNull();
    expect(a.disclaimer).toMatch(/does not change your score/);
  });
  it("explains failures without raw provider text and offers a safe default", () => {
    expect(describeFailure("QUOTA_EXCEEDED")).toMatch(/limit/);
    expect(describeFailure("PROVIDER_AUTH_INVALID")).toMatch(/API key/);
    expect(describeFailure("SOMETHING_ELSE")).toMatch(/unaffected/);
    expect(describeFailure(null)).toMatch(/unaffected/);
  });
});

describe("polling", () => {
  it("backs off, then stops", () => {
    expect(pollDelay(0)).toBe(1500);
    expect(pollDelay(3)).toBeGreaterThan(pollDelay(0)!);
    expect(pollDelay(10)).toBe(15_000);
    expect(pollDelay(20)).toBeNull();
    expect(isPending("PENDING")).toBe(true);
    expect(isPending("READY")).toBe(false);
    expect(isPending(undefined)).toBe(false);
  });
});

describe("study plan response", () => {
  it("reads deterministic data plus the latest AI plan, and tolerates missing parts", () => {
    const d = readPlanData({
      dataLevel: "INITIAL", weakTopics: [{ topic: "Energy" }, "Cells"], strongTopics: [], notEnoughData: ["Tiny"],
      actions: [{ type: "REVIEW_NOTES", topic: "Energy", label: "Review Energy", href: "/question-bank?topic=Energy", reason: "1 of 4" }, { label: "Bad", href: "//evil.example" }],
      plan: { id: "p1", status: "READY", label: "INITIAL_SUGGESTIONS", stale: true, basis: { results: 1, topics: 2, answered: 8 }, content: { headline: "Start with Energy", focus: [{ topic: "Energy", reason: "low" }], steps: [{ type: "PRACTICE_MCQ", topic: "Energy", text: "Do 5", minutes: 10 }], caveats: ["One exam isn't proof."] } },
    });
    expect(d.weakTopics).toEqual(["Energy", "Cells"]);
    expect(d.actions[1]!.href).toBe("/question-bank");
    expect(d.plan).toMatchObject({ status: "READY", stale: true, label: "INITIAL_SUGGESTIONS" });
    expect(d.plan!.content!.steps[0]!.minutes).toBe(10);
    expect(readPlanData({}).plan).toBeNull();
    expect(readPlanData({}).dataLevel).toBe("NONE");
  });
  it("links next steps only to places inside the app", () => {
    expect(stepHref({ type: "PRACTICE_MCQ", topic: "Cell biology" })).toBe("/mcq?topic=Cell%20biology&grounding=GENERAL");
    expect(stepHref({ type: "REVIEW_NOTES", topic: null })).toBe("/question-bank");
    expect(stepHref({ type: "READ_DOCUMENT", topic: "x" })).toBe("/documents");
    expect(stepHref({ type: "COMPARE_ATTEMPTS", topic: null })).toBeNull();
    expect(stepHref({ type: "UNKNOWN", topic: "x" })).toBeNull();
  });
});

describe("assistant prompt handoff", () => {
  it("reads a session response and refuses external links", () => {
    expect(readSession({ conversationId: "c1", prompt: "Explain" })).toEqual({ conversationId: "c1", prompt: "Explain", href: null });
    expect(readSession({ href: "/mcq?topic=x" }).href).toBe("/mcq?topic=x");
    expect(readSession({ href: "https://evil.example" }).href).toBeNull();
    expect(readSession(undefined)).toEqual({ conversationId: null, prompt: null, href: null });
  });
  it("hands the prompt over exactly once", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    expect(stashPrompt("c1", "Explain question 3")).toBe(true);
    expect(takePrompt("c2")).toBeNull(); // another conversation can't take it
    expect(takePrompt("c1")).toBe("Explain question 3");
    expect(takePrompt("c1")).toBeNull(); // already consumed: a reload can't send it again
  });
  it("is safe when storage is unavailable", () => {
    vi.stubGlobal("window", { sessionStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined } });
    expect(stashPrompt("c1", "x")).toBe(false);
    expect(takePrompt("c1")).toBeNull();
  });
});
