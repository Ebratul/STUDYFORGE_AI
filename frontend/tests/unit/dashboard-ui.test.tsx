import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AiFeedbackBody } from "@/components/analysis/ai-feedback-card";
import { UsageCard } from "@/components/ai/usage-card";
import { AnalyticsBody, DashboardSkeleton } from "@/components/dashboard/dashboard-analytics";
import { StatTiles } from "@/components/dashboard/stat-tiles";
import { TopicBars } from "@/components/dashboard/topic-bars";
import { PlanCardBody } from "@/components/study-plan/study-plan-view";
import { readAnalysis, readPlanView } from "@/lib/analysis";
import { readAnalytics, type AnalyticsMe } from "@/lib/analytics";
import { readUsage } from "@/lib/usage";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
const html = (el: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));

const base = (o: Record<string, unknown> = {}): AnalyticsMe => readAnalytics({ dataLevel: "NONE", totals: { completed: 0, average: null, highest: null, lowest: null, correct: 0, incorrect: 0, unanswered: 0 }, ...o });
const withData = (o: Record<string, unknown> = {}) => base({
  dataLevel: "INITIAL", totals: { completed: 2, average: 6000, highest: 7500, lowest: 4500, correct: 12, incorrect: 6, unanswered: 2 },
  trend: [{ attemptId: "a1", examId: "e1", examTitle: "Cells test", finalizedAt: "2026-01-02T10:00:00Z", percentBp: 4500, band: "VERY_BAD" }, { attemptId: "a2", examId: "e1", examTitle: "Cells retake", finalizedAt: "2026-01-09T10:00:00Z", percentBp: 7500, band: "NEEDS_IMPROVEMENT" }],
  topics: [{ topic: "Energy", questions: 5, correct: 1, incorrect: 4, unanswered: 0, accuracyBp: 2000, sufficient: true }, { topic: "Tiny", questions: 1, correct: 0, incorrect: 1, unanswered: 0, accuracyBp: 0, sufficient: false }],
  bandCounts: { VERY_BAD: 1, NEEDS_IMPROVEMENT: 1 },
  recentFeedback: [{ attemptId: "a2", examTitle: "Cells retake", status: "READY", summary: "You improved on Energy.", generatedAt: "2026-01-09T11:00:00Z" }],
  suggestions: [{ type: "PRACTICE_MCQ", topic: "Energy", label: "Practise Energy", href: "/mcq?topic=Energy&grounding=GENERAL", reason: "1 of 5 correct" }],
  saved: { collections: 1, mcqQuestions: 8, cqQuestions: 2, questionsWithNotes: 3, recentCollections: [{ id: "c1", title: "Week 1", questionCount: 8 }] },
  groups: [{ id: "g1", title: "Batch 24", role: "MEMBER", nextExam: null }], unreadNotifications: 2, ...o,
});

describe("stat tiles: no data is not zero", () => {
  const empty = html(createElement(StatTiles, { a: base() }));
  it("shows 'No data yet' (dashed, different state) for average, highest and answers when there are no results", () => {
    expect(empty.match(/data-state="empty"/g)).toHaveLength(3);
    expect(empty).toContain("No data yet");
    expect(empty).not.toContain("0.00%");
    expect(empty).toMatch(/data-testid="stat-completed"[^>]*>|data-state="value"[^>]*data-testid="stat-completed"/);
  });
  it("shows a genuine 0.00% as a value, not as 'No data'", () => {
    const zero = html(createElement(StatTiles, { a: base({ dataLevel: "INITIAL", totals: { completed: 1, average: 0, highest: 0, lowest: 0, correct: 0, incorrect: 5, unanswered: 0 } }) }));
    expect(zero).toContain("0.00%");
    expect(zero).not.toContain("No data yet");
  });
  it("formats real percentages from basis points with two decimals", () => {
    const out = html(createElement(StatTiles, { a: withData() }));
    expect(out).toContain("60.00%");
    expect(out).toContain("75.00%");
    expect(out).toContain("12");
  });
});

describe("dashboard body", () => {
  it("has an explicit empty state for every block when there are no results", () => {
    const out = html(createElement(AnalyticsBody, { a: base() }));
    expect(out).toContain("No exam results yet");
    expect(out).toContain('data-testid="trend-empty"');
    expect(out).toContain('data-testid="topics-empty"');
    expect(out).toContain('data-testid="feedback-empty"');
    expect(out).toContain("Nothing saved yet");
    expect(out).toContain("not in a group yet");
    expect(out).toContain("different from a score of zero");
    expect(out).not.toContain("Planned analytics");
  });
  it("renders trend table, topic states, breakdown, feedback, suggestions, saved content and groups from real data", () => {
    const out = html(createElement(AnalyticsBody, { a: withData() }));
    expect(out).toContain("Cells retake");
    expect(out).toContain("Show the data as a table");
    expect(out).toContain('data-testid="breakdown"');
    expect(out).toContain("You improved on Energy.");
    expect(out).toContain("Practise Energy");
    expect(out).toContain("Initial suggestions");
    expect(out).toContain("Week 1");
    expect(out).toContain("Batch 24");
    expect(out).toContain('aria-label="2 unread"');
  });
  it("labels the data level honestly and never claims history for a few results", () => {
    const out = html(createElement(AnalyticsBody, { a: withData() }));
    expect(out).toContain("Initial picture");
    expect(out).toContain("one exam can&#x27;t show how well you know a topic");
    expect(out).not.toContain("Based on your history.");
  });
  it("renders a loading skeleton with an accessible label", () => {
    const out = html(createElement(DashboardSkeleton));
    expect(out).toContain('role="status"');
    expect(out).toContain("Loading your dashboard");
  });
});

describe("topic bars", () => {
  const out = html(createElement(TopicBars, { topics: withData().topics }));
  it("marks a weak topic in words and a thin topic as 'Not enough data' — never as weak", () => {
    const li = out.split("<li").slice(1);
    expect(li[0]).toContain('data-state="weak"');
    expect(li[0]).toContain("Needs work");
    expect(li[1]).toContain('data-state="unknown"');
    expect(li[1]).toContain("Not enough data");
    expect(li[1]).not.toContain("Needs work");
  });
  it("shows the real numbers as text", () => {
    expect(out).toContain("20.00%");
    expect(out).toContain("1 of 5 correct");
  });
});

describe("AI feedback card states", () => {
  const view = (o: Record<string, unknown>) => readAnalysis({ attemptId: "a1", dataLevel: "INITIAL", canRetry: true, ...o });
  const render = (v: ReturnType<typeof view>) => html(createElement(AiFeedbackBody, { view: v, busy: false, onRequest: () => undefined, onRegenerate: () => undefined }));
  it("offers to request feedback when none exists", () => expect(render(view({ status: "NONE" }))).toContain("Get AI feedback"));
  it("announces progress politely while pending", () => {
    const out = render(view({ status: "PENDING" }));
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain("already final");
  });
  it("shows a retry and reassures that the score is unaffected when it failed", () => {
    const out = render(view({ status: "FAILED", errorCode: "PROVIDER_RATE_LIMITED" }));
    expect(out).toContain("rate-limiting");
    expect(out).toContain("Retry");
  });
  it("points to settings when no model is configured", () => {
    const out = render(view({ status: "NOT_CONFIGURED" }));
    expect(out).toContain("/settings/providers");
    expect(out).toContain("/settings/api-keys");
  });
  it("renders ready feedback with evidence, next-step links, caveats and the disclaimer; AI text is escaped", () => {
    const out = render(view({ status: "READY", content: { summary: "Good effort.", strengths: [{ topic: "Cells", detail: "6 of 6" }], weaknesses: [{ topic: "Energy", detail: "needs practice", evidence: "1 of 5 correct" }], nextSteps: [{ type: "PRACTICE_MCQ", topic: "Energy", text: "Try <script>alert(1)</script> 5 MCQs" }], caveats: ["One exam only."] }, disclaimer: "AI-generated from your verified results. It does not change your score." }));
    expect(out).toContain("1 of 5 correct");
    expect(out).toContain('href="/mcq?topic=Energy&amp;grounding=GENERAL"');
    expect(out).toContain("One exam only.");
    expect(out).toContain("does not change your score");
    expect(out).not.toContain("<script>");
  });
});

describe("study plan card states", () => {
  const render = (plan: ReturnType<typeof readPlanView>) => html(createElement(PlanCardBody, { plan, busy: false, onGenerate: () => undefined }));
  it("offers to write a plan when none exists", () => expect(render(null)).toContain("Write my plan"));
  it("labels the plan from the server's label and flags a stale plan", () => {
    const out = render(readPlanView({ id: "p1", status: "READY", label: "INITIAL_SUGGESTIONS", stale: true, basis: { results: 1, topics: 2, answered: 8 }, content: { headline: "Start with Energy", focus: [{ topic: "Energy", reason: "low" }], steps: [{ type: "PRACTICE_MCQ", topic: "Energy", text: "Do five", minutes: 10 }], caveats: ["One exam isn't proof of mastery."] } }));
    expect(out).toContain("Initial suggestions");
    expect(out).toContain("plan-stale");
    expect(out).toContain("about 10 min");
    expect(out).toContain("proof of mastery");
  });
  it("handles failed and pending plans", () => {
    expect(render(readPlanView({ id: "p", status: "FAILED", errorCode: "QUOTA_EXCEEDED", basis: {} }))).toContain("limit");
    expect(render(readPlanView({ id: "p", status: "PENDING", basis: {} }))).toContain("being written");
  });
});

describe("usage card", () => {
  it("shows unlimited windows and the by-task table with the no-cost note", () => {
    const u = readUsage({ daily: { tokens: 1000, requests: 3, tokenLimit: 0, requestLimit: 300, resetsAt: "2026-01-02T00:00:00Z" }, monthly: { tokens: 5000, requests: 20, tokenLimit: 100000, requestLimit: 0, resetsAt: null }, byTask: [{ task: "CHAT", requests: 20, tokens: 4000 }, { task: "ANALYSIS", requests: 2, tokens: 1000 }] })!;
    const out = html(createElement(UsageCard, { usage: u }));
    expect(out).toContain("no limit");
    expect(out).toContain("1,000");
    expect(out).toContain("AI feedback and plans");
    expect(out).toContain("5,000");
    expect(out).toContain("no cost estimate");
  });
  it("says so when there was no AI use", () => {
    const u = readUsage({ daily: { tokens: 0, requests: 0, tokenLimit: 0, requestLimit: 0 }, byTask: [] })!;
    expect(html(createElement(UsageCard, { usage: u }))).toContain("No AI requests in the last 30 days");
  });
});
