import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ExamTimer } from "@/components/exams/exam-timer";
import { QuestionNavigator } from "@/components/exams/question-navigator";
import { ResultView } from "@/components/exams/result-view";
import { StatusBadge } from "@/components/exams/exam-badges";
import type { AttemptQuestion, LocalAnswer, ResultView as ResultData } from "@/lib/exams";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));

const html = (el: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));

const base: ResultData = {
  status: "SUBMITTED", submittedAt: "2026-10-23T10:00:00Z", finalizedAt: "2026-10-23T10:00:00Z",
  release: { released: true, mode: "IMMEDIATE", releasesAt: null },
  score: { scoreCenti: 875, maxCenti: 1000, percentBp: 8750, correct: 8, incorrect: 1, unanswered: 1, band: "GOOD" },
  topics: [{ topic: "Cells", questions: 5, correct: 4, incorrect: 1, unanswered: 0, percentBp: 8000 }, { topic: null, questions: 5, correct: 4, incorrect: 0, unanswered: 1, percentBp: 8000 }],
  review: [
    { position: 1, questionId: "q1", stem: "What is ATP?", options: [{ id: "a", text: "Energy" }, { id: "b", text: "Protein" }], selectedOptionId: "b", outcome: "INCORRECT", awardedCenti: -25, correctOptionId: "a", explanation: "ATP carries energy.", shortNote: "ATP = energy", sources: [{ documentName: "bio.pdf", page: 3, section: null, quote: "ATP stores energy" }] },
    { position: 2, questionId: "q2", stem: "Skipped?", options: [{ id: "c", text: "Yes" }, { id: "d", text: "No" }], selectedOptionId: null, outcome: "UNANSWERED", awardedCenti: 0, correctOptionId: "c" },
  ],
  retry: { allowed: true, attemptsLeft: 2 },
};
const render = (r: ResultData) => html(createElement(ResultView, { result: r, attemptId: "att1", examId: "ex1", examTitle: "Cell biology test", attemptNo: 1 }));

describe("result page", () => {
  it("shows the server's score, percentage with two decimals, counts and band", () => {
    const out = render(base);
    expect(out).toContain("87.50%");
    expect(out).toContain("8.75");
    expect(out).toContain("out of 10 marks");
    expect(out).toContain('data-testid="count-correct">8<');
    expect(out).toContain('data-testid="count-incorrect">1<');
    expect(out).toContain('data-testid="count-unanswered">1<');
    expect(out).toMatch(/data-testid="band-chip"[^>]*>Good</);
    expect(out).toContain("Cell biology test");
  });
  it("lists the exact thresholds and marks the user's band", () => {
    const out = render(base);
    for (const t of ["90% – 100%", "80% – below 90%", "70% – below 80%", "60% – below 70%", "Below 60%"]) expect(out).toContain(t);
    expect(out).toContain("← you");
    expect(out).toContain("Not good — needs improvement");
  });
  it("renders a full review with correct answer, explanation, note and sources", () => {
    const out = render(base);
    expect(out).toContain("Correct answer");
    expect(out).toContain("Your answer");
    expect(out).toContain("ATP carries energy.");
    expect(out).toContain("ATP = energy");
    expect(out).toContain("bio.pdf, page 3");
    expect(out).toContain("You didn&#x27;t answer this question.");
    expect(out).toContain("Try again · 2 attempts left");
  });
  it("outcomes are shown as text, not colour alone", () => {
    const out = render(base);
    expect(out).toContain(">Incorrect<");
    expect(out).toContain("Not answered");
    expect(out).toContain("-0.25 marks");
  });
  it("correctness-only review shows right/wrong but no correct answers, explanations or notes", () => {
    const out = render({ ...base, review: base.review!.map(({ correctOptionId, explanation, shortNote, sources, ...r }) => { void correctOptionId; void explanation; void shortNote; void sources; return r; }) });
    expect(out).toContain("which questions were right or wrong");
    expect(out).not.toContain("Correct answer");
    expect(out).not.toContain("ATP carries energy.");
    expect(out).not.toContain("ATP = energy");
  });
  it("a score-only exam has no review at all", () => {
    const { review, ...rest } = base;
    void review;
    const out = render(rest);
    expect(out).toContain("doesn&#x27;t show a question-by-question review");
    expect(out).toContain("87.50%");
  });
  it("NOT released: no score, no counts, no review, no answers — only when it will be released", () => {
    const out = render({ ...base, release: { released: false, mode: "AT_TIME", releasesAt: "2026-12-01T10:00:00Z" }, score: undefined, topics: undefined, review: undefined, retry: undefined });
    expect(out).toContain('data-testid="not-released"');
    expect(out).toContain("results aren&#x27;t released yet");
    expect(out).not.toContain("87.50%");
    expect(out).not.toContain("score-card");
    expect(out).not.toContain("Correct answer");
    expect(out).not.toContain("ATP carries energy.");
    expect(out).not.toContain("count-correct");
  });
  it("never shows a score from a not-released payload even if the server sent score fields by mistake", () => {
    const out = render({ ...base, release: { released: false, mode: "AFTER_CLOSE", releasesAt: null } });
    expect(out).toContain('data-testid="not-released"');
    expect(out).not.toContain('data-testid="score-card"');
    expect(out).not.toContain('data-testid="review"');
  });
  it("timed-out attempts say so, kindly", () => {
    const out = render({ ...base, status: "TIMED_OUT" });
    expect(out).toContain("Time ran out");
    expect(out).toContain("Submitted automatically");
  });
  it("shows topic performance as a table too", () => {
    const out = render(base);
    expect(out).toContain('data-testid="topic-performance"');
    expect(out).toContain("General"); // null topic
    expect(out).toContain("80.00%");
  });
  it("band wording per band is constructive (very bad is still encouraging)", () => {
    const out = render({ ...base, score: { ...base.score!, percentBp: 2500, scoreCenti: 250, band: "VERY_BAD" } });
    expect(out).toContain("Very bad");
    expect(out).toMatch(/try again/i);
  });
});

describe("exam screen pieces", () => {
  it("timer shows server-derived time with role=timer and no live announcements every second", () => {
    const out = html(createElement(ExamTimer, { remainingMs: 65_000, totalMs: 600_000 }));
    expect(out).toContain('role="timer"');
    expect(out).toContain('aria-live="off"');
    expect(out).toContain("1:05");
    expect(out).toContain("Time left");
  });
  it("navigator conveys state in text and marks the current question", () => {
    const qs: AttemptQuestion[] = [1, 2, 3].map((n) => ({ id: `q${n}`, position: n, stem: `Q${n}`, options: [], marks: 1 }));
    const a = new Map<string, LocalAnswer>([["q1", { optionId: "x", marked: false, seq: 1, confirmedSeq: 1, savedAt: null }], ["q2", { optionId: null, marked: true, seq: 1, confirmedSeq: 1, savedAt: null }]]);
    const out = html(createElement(QuestionNavigator, { questions: qs, answers: a, index: 2, onGo: () => undefined }));
    expect(out).toContain("Question 1, answered");
    expect(out).toContain("Question 2, marked for review");
    expect(out).toContain("Question 3, not answered, current");
    expect(out).toContain('aria-current="true"');
  });
  it("status badges", () => {
    expect(html(createElement(StatusBadge, { status: "DRAFT" }))).toContain("Draft");
    expect(html(createElement(StatusBadge, { status: "PUBLISHED" }))).toContain("Published");
    expect(html(createElement(StatusBadge, { status: "CANCELLED" }))).toContain("Cancelled");
  });
});
