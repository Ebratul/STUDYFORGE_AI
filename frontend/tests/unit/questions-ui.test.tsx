import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { CqWorkspace } from "@/components/questions/cq-workspace";
import { McqWorkspace } from "@/components/questions/mcq-workspace";
import { QuestionBody } from "@/components/questions/question-view";
import { blankMcq, type QuestionContent, type QuestionLimitsResponse } from "@/lib/questions";

const limits: QuestionLimitsResponse = { limits: {}, models: { MCQ: { provider: "mock", modelId: "mock-chat" }, CQ: { provider: "mock", modelId: "mock-chat" }, EMBEDDING: null } };
const html = (el: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));
const TIMER = /\b(timer|countdown|count-down|time limit|time remaining|duration|stopwatch)\b/i;
/** The only time-related wording allowed is the explicit statement that CQ sets have no timer. */
const timerWording = (out: string) => out.replace(/there is no timer/g, "").match(TIMER)?.[0] ?? null;

const cq: QuestionContent = {
  ...blankMcq("bn"), kind: "CQ", stem: "উদ্দীপকটি পড়ো।", stimulus: "একটি উদ্দীপক।", options: [], correctOptionId: null, marks: 3,
  parts: [
    { id: "p1", label: "ক", level: "KNOWLEDGE", prompt: "সংজ্ঞা দাও।", marks: 1, answer: { text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] } },
    { id: "p2", label: "খ", level: "HIGHER_ORDER", prompt: "ব্যাখ্যা করো।", marks: 2, answer: { text: "উত্তর।", basis: "SOURCE_SUPPORTED", sources: [] } },
  ],
};

describe("CQ workspace has no timer", () => {
  it("renders no timer, countdown or duration wording or controls", () => {
    const out = html(createElement(CqWorkspace, { limitsResponse: limits }));
    expect(timerWording(out)).toBeNull();
    expect(/type="time"|role="timer"/.test(out)).toBe(false);
    expect(out).toContain("there is no timer");
  });
  it("renders CQ questions with Bangla labels and levels but no time fields", () => {
    const out = html(createElement(QuestionBody, { q: cq }));
    expect(out).toContain("জ্ঞানমূলক");
    expect(out).toContain("উচ্চতর দক্ষতামূলক");
    expect(timerWording(out)).toBeNull();
  });
  it("shows insufficient evidence explicitly instead of an invented answer", () => {
    const out = html(createElement(QuestionBody, { q: cq }));
    expect(out).toContain("Insufficient evidence in your sources");
    expect(out).toContain("No answer was written");
  });
});

describe("generator forms", () => {
  it("MCQ form offers every setting from the brief", () => {
    const out = html(createElement(McqWorkspace, { limitsResponse: limits }));
    for (const text of ["Number of questions", "Answer options", "Marks per question", "Negative marks", "Easy", "Medium", "Hard", "Mixed", "English", "বাংলা", "Explanations", "Related short notes", "Double-check answer keys", "Source only", "Source preferred", "General AI", "Pasted text", "Topic"]) {
      expect(out).toContain(text);
    }
    expect(out).toContain("mock-chat");
  });
  it("disables generation and explains when no model is configured", () => {
    const out = html(createElement(McqWorkspace, { limitsResponse: { ...limits, models: { MCQ: null, CQ: null, EMBEDDING: null } } }));
    expect(out).toContain("No model chosen for MCQ generation");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/);
  });
  it("CQ form offers both modes and the Bangla 4-part structure", () => {
    const out = html(createElement(CqWorkspace, { limitsResponse: limits }));
    for (const text of ["Questions only", "Questions with answers", "Stimulus-based, 4 parts", "Descriptive / short answer", "Multi-part", "Total marks"]) expect(out).toContain(text);
  });
});
