import { describe, expect, it } from "vitest";
import {
  answeredTotal, breakdown, formatAccuracy, hasResults, readAnalytics, readResultsPage, safeInternalHref, topicChartData, topicIsWeak, trendChartData,
  type TopicStat,
} from "@/lib/analytics";

const topic = (name: string, correct: number, total: number, sufficient = total >= 3): TopicStat => ({
  topic: name, questions: total, correct, incorrect: total - correct, unanswered: 0, accuracyBp: total ? Math.round((correct / total) * 10000) : 0, sufficient,
});

describe("no data is not zero", () => {
  it("formats null as 'No data yet' and a real zero as 0.00%", () => {
    expect(formatAccuracy(null)).toBe("No data yet");
    expect(formatAccuracy(undefined)).toBe("No data yet");
    expect(formatAccuracy(0)).toBe("0.00%");
    expect(formatAccuracy(8750)).toBe("87.50%");
    expect(formatAccuracy(10000)).toBe("100.00%");
  });
  it("reads an empty server response as NONE with null figures, and a 0 score as a number", () => {
    const empty = readAnalytics({ dataLevel: "NONE", totals: { completed: 0, average: null, highest: null, lowest: null, correct: 0, incorrect: 0, unanswered: 0 } });
    expect(empty.totals.average).toBeNull();
    expect(hasResults(empty)).toBe(false);
    const zero = readAnalytics({ dataLevel: "INITIAL", totals: { completed: 1, average: 0, highest: 0, lowest: 0, correct: 0, incorrect: 4, unanswered: 1 } });
    expect(zero.totals.average).toBe(0);
    expect(zero.totals.highest).toBe(0);
    expect(hasResults(zero)).toBe(true);
  });
  it("survives garbage without throwing", () => {
    const a = readAnalytics("nonsense");
    expect(a.dataLevel).toBe("NONE");
    expect(a.trend).toEqual([]);
    expect(a.saved.collections).toBe(0);
    expect(readResultsPage(null).items).toEqual([]);
  });
});

describe("reading the analytics response", () => {
  const raw = {
    dataLevel: "BASED_ON_HISTORY",
    totals: { completed: 3, average: 7250, highest: 9000, lowest: 5000, correct: 21, incorrect: 6, unanswered: 3 },
    bandCounts: { GOOD: 1, VERY_BAD: 1, BOGUS: 5 },
    trend: [{ attemptId: "a1", examId: "e1", examTitle: "Cells", finalizedAt: "2026-01-02T10:00:00Z", percentBp: 5000, band: "VERY_BAD" }],
    topics: [topic("Cells", 2, 5), { topic: null, questions: 2, correct: 1 }],
    weakTopics: ["Cells", { topic: "Energy" }],
    recentFeedback: [{ attemptId: "a1", examTitle: "Cells", status: "READY", summary: "Nice work", generatedAt: "2026-01-02T11:00:00Z" }, { attemptId: "a2", status: "WEIRD" }],
    suggestions: [{ type: "PRACTICE_MCQ", topic: "Cells", label: "Practise Cells", href: "/mcq?topic=Cells", reason: "2 of 5" }, { type: "X", label: "Evil", href: "https://evil.example/x", reason: "" }, { label: "" }],
    saved: { collections: 2, mcqQuestions: 10, cqQuestions: 3, questionsWithNotes: 4, recentCollections: [{ id: "c1", title: "Week 1", questionCount: 5 }, { title: "no id" }] },
    groups: [{ id: "g1", title: "Batch", role: "MEMBER", nextExam: { examId: "e2", title: "Midterm", opensAt: null, closesAt: "2026-03-01T00:00:00Z" } }],
    unreadNotifications: 4,
  };
  const a = readAnalytics(raw);
  it("keeps real values and drops unknown bands, rows without ids and empty suggestions", () => {
    expect(a.bandCounts).toEqual({ GOOD: 1, VERY_BAD: 1 });
    expect(a.topics[1]!.topic).toBe("General");
    expect(a.topics[1]!.sufficient).toBe(false);
    expect(a.weakTopics).toEqual(["Cells", "Energy"]);
    expect(a.recentFeedback[1]!.status).toBe("NONE");
    expect(a.suggestions).toHaveLength(2);
    expect(a.saved.recentCollections).toEqual([{ id: "c1", title: "Week 1", questionCount: 5 }]);
    expect(a.groups[0]!.nextExam?.closesAt).toBe("2026-03-01T00:00:00Z");
    expect(a.unreadNotifications).toBe(4);
  });
  it("never links to an external address from a server-provided href", () => {
    expect(a.suggestions[1]!.href).toBe("/dashboard");
    expect(safeInternalHref("//evil.example")).toBe("/dashboard");
    expect(safeInternalHref("javascript:alert(1)")).toBe("/dashboard");
    expect(safeInternalHref("/\\evil")).toBe("/dashboard");
    expect(safeInternalHref("/mcq?topic=x", "/")).toBe("/mcq?topic=x");
    expect(safeInternalHref(42)).toBe("/dashboard");
  });
});

describe("chart and breakdown mapping", () => {
  it("counts unanswered as not correct in the breakdown, with whole-number shares", () => {
    const t = { completed: 2, average: 5000, highest: 6000, lowest: 4000, correct: 5, incorrect: 3, unanswered: 2 };
    expect(answeredTotal(t)).toBe(10);
    expect(breakdown(t).map((p) => [p.key, p.count, p.pct])).toEqual([["correct", 5, 50], ["incorrect", 3, 30], ["unanswered", 2, 20]]);
    expect(breakdown({ ...t, correct: 0, incorrect: 0, unanswered: 0 }).every((p) => p.pct === 0)).toBe(true);
  });
  it("maps the trend in order with percentages and readable dates", () => {
    const d = trendChartData([
      { attemptId: "a", examId: "e", examTitle: "One", finalizedAt: "2026-01-02T10:00:00Z", percentBp: 4375, band: "VERY_BAD" },
      { attemptId: "b", examId: "e", examTitle: "Two", finalizedAt: "garbage", percentBp: 9000, band: "EXCELLENT" },
    ]);
    expect(d.map((x) => x.pct)).toEqual([43.75, 90]);
    expect(d[0]!.x).toBe(1);
    expect(d[1]!.label).toBe("#2");
    expect(d[0]!.examTitle).toBe("One");
  });
  it("orders topics weakest first but keeps 'not enough data' topics out of the weak group", () => {
    const rows = topicChartData([topic("Tiny", 0, 1), topic("Strong", 9, 10), topic("Weak", 1, 5), topic("Mid", 4, 5)]);
    expect(rows.map((r) => r.name)).toEqual(["Weak", "Mid", "Strong", "Tiny"]);
    expect(rows.find((r) => r.name === "Tiny")!.sufficient).toBe(false);
    expect(topicIsWeak(topic("Tiny", 0, 1))).toBe(false);
    expect(topicIsWeak(topic("Weak", 1, 5))).toBe(true);
    expect(topicIsWeak({ ...topic("Edge", 7, 10), accuracyBp: 7000 })).toBe(false); // exactly 70% is not weak
  });
  it("reads a results page and keeps the server's paging numbers", () => {
    const p = readResultsPage({ items: [{ attemptId: "a1", examTitle: "X", percentBp: 8000, band: "GOOD", scoreCenti: 800, maxCenti: 1000, correct: 8, incorrect: 2, unanswered: 0, finalizedAt: "2026-01-01T00:00:00Z" }, { nothing: true }], total: 12, page: 2, pageSize: 5 });
    expect(p.items).toHaveLength(1);
    expect(p).toMatchObject({ total: 12, page: 2, pageSize: 5 });
  });
});
