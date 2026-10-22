import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClock } from "../../src/lib/clock.js";
import { db } from "../../src/lib/db.js";
import { seedFinalResult, seedGradedResult, seedGroup, seedPublishedExam } from "../helpers/exam-fixtures.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, makeAdmin, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => setClock(null));

type Me = {
  dataLevel: string;
  totals: { completed: number; average: number | null; highest: number | null; lowest: number | null; correct: number; incorrect: number; unanswered: number };
  bandCounts: Record<string, number>;
  trend: { attemptId: string; examId: string; examTitle: string; finalizedAt: string; percentBp: number; band: string }[];
  topics: { topic: string; questions: number; correct: number; incorrect: number; unanswered: number; accuracyBp: number; sufficient: boolean }[];
  weakTopics: { topic: string }[]; strongTopics: { topic: string }[];
  recentFeedback: { attemptId: string; examTitle: string; status: string; summary: string | null; generatedAt: string | null }[];
  suggestions: { type: string; topic: string | null; label: string; href: string; reason: string }[];
  saved: { collections: number; mcqQuestions: number; cqQuestions: number; questionsWithNotes: number; recentCollections: { id: string; title: string; questionCount: number }[] };
  groups: { id: string; title: string; role: string; nextExam: { examId: string; title: string; opensAt: string | null; closesAt: string | null } | null }[];
  unreadNotifications: number;
};
const me = async (u: TestUser): Promise<Me> => {
  const res = await client(t, u).get("/api/analytics/me");
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};
type ResultsPage = { items: { attemptId: string; examId: string; examTitle: string; finalizedAt: string; scoreCenti: number; maxCenti: number; percentBp: number; band: string; correct: number; incorrect: number; unanswered: number }[]; total: number; page: number; pageSize: number };
const results = async (u: TestUser, qs = ""): Promise<ResultsPage> => {
  const res = await client(t, u).get(`/api/analytics/me/results${qs}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};
const summary = async (u: TestUser) => (await (await client(t, u).get("/api/dashboard/summary")).json()).exams;

/** One 100-mark question: a score in centi-marks equals the percentage in basis points. */
const hundred = (owner: TestUser, extra: Record<string, unknown> = {}) => seedPublishedExam({ owner, questionCount: 1, marksCenti: 10000, attemptLimit: 100, ...extra });

describe("access", () => {
  it("requires authentication", async () => {
    expect((await client(t).get("/api/analytics/me")).status).toBe(401);
    expect((await client(t).get("/api/analytics/me/results")).status).toBe(401);
  });
});

describe("no data is not a zero score", () => {
  it("a new user has null figures and an explicit NONE data level", async () => {
    const u = await createUser();
    const a = await me(u);
    expect(a.dataLevel).toBe("NONE");
    expect(a.totals).toEqual({ completed: 0, average: null, highest: null, lowest: null, correct: 0, incorrect: 0, unanswered: 0 });
    expect(a.trend).toEqual([]);
    expect(a.topics).toEqual([]);
    expect(a.suggestions).toEqual([]);
    expect(a.bandCounts).toEqual({ EXCELLENT: 0, GOOD: 0, NEEDS_IMPROVEMENT: 0, BAD: 0, VERY_BAD: 0 });
    const s = await summary(u);
    expect(s).toMatchObject({ averagePercentBp: null, best: null, recent: [], attempts: 0, finalized: 0 });
    expect(await results(u)).toMatchObject({ items: [], total: 0 });
  });

  it("a real 0 % result is the number 0, not null", async () => {
    const u = await createUser();
    const e = await hundred(u);
    await seedFinalResult({ version: e.version, user: u, scoreCenti: 0 });
    const a = await me(u);
    expect(a.dataLevel).toBe("INITIAL");
    expect(a.totals).toMatchObject({ completed: 1, average: 0, highest: 0, lowest: 0 });
    expect(a.bandCounts.VERY_BAD).toBe(1);
    expect(a.trend[0]).toMatchObject({ percentBp: 0, band: "VERY_BAD" });
    expect(await summary(u)).toMatchObject({ averagePercentBp: 0, best: 0 });
  });
});

describe("only released results are visible", () => {
  it("hides held results from analytics, trend, topics, results list and the dashboard until the release time", async () => {
    const u = await createUser();
    const later = new Date(Date.now() + 3_600_000);
    const e = await seedPublishedExam({ owner: u, questionCount: 4, releaseMode: "AT_TIME", releaseAt: later });
    await seedGradedResult({ version: e.version, questions: e.questions, user: u, outcomes: ["CORRECT", "CORRECT", "INCORRECT", "INCORRECT"] });
    const before = await me(u);
    expect(before.dataLevel).toBe("NONE");
    expect(before.totals.completed).toBe(0);
    expect(before.totals.average).toBeNull();
    expect(before.trend).toEqual([]);
    expect(before.topics).toEqual([]);
    expect((await results(u)).total).toBe(0);
    expect(await summary(u)).toMatchObject({ averagePercentBp: null, recent: [], finalized: 1 });
    setClock(() => new Date(later.getTime() + 1000));
    const after = await me(u);
    expect(after.totals).toMatchObject({ completed: 1, average: 5000 });
    expect(after.topics.reduce((n, x) => n + x.questions, 0)).toBe(4);
    expect((await results(u)).total).toBe(1);
  });
});

describe("isolation", () => {
  it("never mixes users' data, and an admin sees only their own analytics", async () => {
    const [a, b, admin] = [await createUser(), await createUser(), await createUser()];
    await makeAdmin(admin.id);
    const ea = await hundred(a);
    const eb = await hundred(b);
    await seedFinalResult({ version: ea.version, user: a, scoreCenti: 9100 });
    await seedFinalResult({ version: eb.version, user: b, scoreCenti: 2000 });
    expect((await me(a)).totals).toMatchObject({ completed: 1, highest: 9100 });
    expect((await me(b)).totals).toMatchObject({ completed: 1, highest: 2000 });
    expect((await me(admin)).totals.completed).toBe(0);
    expect((await results(admin)).items).toEqual([]);
    expect(JSON.stringify(await results(a))).not.toContain(b.id);
  });
});

describe("trend, results list and pagination", () => {
  it("returns the last 50 results chronologically; the list is newest-first and paginated with a cap of 50", async () => {
    const u = await createUser();
    const e = await hundred(u);
    const base = Date.now() - 100 * 3_600_000;
    for (let i = 1; i <= 55; i++) await seedFinalResult({ version: e.version, user: u, scoreCenti: i * 100, attemptNo: i, finalizedAt: new Date(base + i * 3_600_000) });
    const a = await me(u);
    expect(a.totals.completed).toBe(55);
    expect(a.trend).toHaveLength(50);
    expect(a.trend[0]!.percentBp).toBe(600); // results 1-5 fall outside the last 50
    expect(a.trend.at(-1)!.percentBp).toBe(5500);
    expect(a.trend.map((x) => x.percentBp)).toEqual([...a.trend.map((x) => x.percentBp)].sort((x, y) => x - y));
    const p1 = await results(u, "?pageSize=20");
    const p3 = await results(u, "?pageSize=20&page=3");
    expect(p1).toMatchObject({ total: 55, page: 1, pageSize: 20 });
    expect(p1.items[0]!.percentBp).toBe(5500);
    expect(p3.items).toHaveLength(15);
    expect(p3.items.at(-1)!.percentBp).toBe(100);
    const c = client(t, u);
    expect((await c.get("/api/analytics/me/results?pageSize=51")).status).toBe(422);
    expect((await c.get("/api/analytics/me/results?page=0")).status).toBe(422);
    expect((await c.get("/api/analytics/me/results?pageSize=abc")).status).toBe(422);
  });
});

describe("topics, weak/strong and suggestions", () => {
  async function twoExams(u: TestUser) {
    // 10 questions: topics "Cells" (5), "Energy & Light" (3), General (2: null topic)
    const topics = ["Cells", "Cells", "Cells", "Cells", "Cells", "Energy & Light", "Energy & Light", "Energy & Light", null, null];
    const e1 = await seedPublishedExam({ owner: u, questionCount: 10, topics, attemptLimit: 5 });
    const e2 = await seedPublishedExam({ owner: u, questionCount: 10, topics, attemptLimit: 5 });
    const mix = (cells: "CORRECT" | "INCORRECT", energy: "CORRECT" | "INCORRECT") => [cells, cells, cells, cells, cells, energy, energy, energy, "CORRECT", "UNANSWERED"] as ("CORRECT" | "INCORRECT" | "UNANSWERED")[];
    await seedGradedResult({ version: e1.version, questions: e1.questions, user: u, outcomes: mix("INCORRECT", "CORRECT"), finalizedAt: new Date(Date.now() - 7200_000) });
    await seedGradedResult({ version: e2.version, questions: e2.questions, user: u, outcomes: mix("INCORRECT", "CORRECT"), finalizedAt: new Date(Date.now() - 3600_000) });
    return { e1, e2 };
  }

  it("aggregates by topic across results, flags sufficiency and separates weak from strong", async () => {
    const u = await createUser();
    await twoExams(u);
    const a = await me(u);
    const by = (n: string) => a.topics.find((x) => x.topic === n)!;
    expect(by("Cells")).toMatchObject({ questions: 10, correct: 0, incorrect: 10, unanswered: 0, accuracyBp: 0, sufficient: true });
    expect(by("Energy & Light")).toMatchObject({ questions: 6, correct: 6, accuracyBp: 10000, sufficient: true });
    expect(by("General")).toMatchObject({ questions: 4, correct: 2, unanswered: 2, accuracyBp: 5000, sufficient: true });
    expect(a.topics.map((x) => x.topic)).toEqual(["Cells", "General", "Energy & Light"]); // weakest first
    expect(a.weakTopics.map((x) => x.topic)).toEqual(["Cells", "General"]);
    expect(a.strongTopics.map((x) => x.topic)).toEqual(["Energy & Light"]);
    expect(a.dataLevel).toBe("INITIAL"); // only two results
  });

  it("needs three results and a topic with five answers for BASED_ON_HISTORY; thin topics are never labelled", async () => {
    const u = await createUser();
    const { e1 } = await twoExams(u);
    await seedGradedResult({ version: e1.version, questions: e1.questions, user: u, outcomes: Array(10).fill("CORRECT"), attemptNo: 2 });
    expect((await me(u)).dataLevel).toBe("BASED_ON_HISTORY");
    const v = await createUser();
    const e = await seedPublishedExam({ owner: v, questionCount: 2, topics: ["Tiny", "Tiny"] });
    await seedGradedResult({ version: e.version, questions: e.questions, user: v, outcomes: ["INCORRECT", "INCORRECT"] });
    const a = await me(v);
    expect(a.topics[0]).toMatchObject({ topic: "Tiny", sufficient: false, accuracyBp: 0 });
    expect(a.weakTopics).toEqual([]);
    expect(a.suggestions).toEqual([]);
  });

  it("builds deterministic, capped suggestions with encoded links", async () => {
    const u = await createUser();
    await twoExams(u);
    const a = await me(u);
    const b = await me(u);
    expect(a.suggestions).toEqual(b.suggestions);
    expect(a.suggestions.length).toBeLessThanOrEqual(6);
    expect(a.suggestions.map((s) => s.type)).toEqual(["REVIEW_NOTES", "PRACTICE_MCQ", "REVIEW_NOTES", "PRACTICE_MCQ", "PRACTICE_CQ", "ASK_ASSISTANT"]);
    expect(a.suggestions[0]).toMatchObject({ topic: "Cells", href: "/question-bank?topic=Cells", reason: "0 of 10 correct (0%)" });
    expect(a.suggestions[1]!.href).toBe("/mcq?topic=Cells&grounding=GENERAL");
    expect(a.suggestions[2]).toMatchObject({ topic: "General", href: "/question-bank" }); // the catch-all bucket has no topic filter
    expect(a.suggestions[4]!.href).toBe("/cq?topic=Cells");
    expect(a.suggestions[5]!.href).toBe("/chat");
  });

  it("suggests comparing attempts when one exam has two results", async () => {
    const u = await createUser();
    const e = await seedPublishedExam({ owner: u, questionCount: 4, attemptLimit: 3, topics: ["A", "A", "A", "A"] });
    await seedGradedResult({ version: e.version, questions: e.questions, user: u, outcomes: ["CORRECT", "CORRECT", "CORRECT", "CORRECT"], attemptNo: 1 });
    await seedGradedResult({ version: e.version, questions: e.questions, user: u, outcomes: ["CORRECT", "CORRECT", "CORRECT", "INCORRECT"], attemptNo: 2 });
    const s = (await me(u)).suggestions;
    expect(s.map((x) => x.type)).toEqual(["COMPARE_ATTEMPTS"]);
    expect(s[0]!.href).toBe(`/exams/${e.exam.id}`);
  });
});

describe("classification boundaries through the API", () => {
  it.each([
    [5999, "VERY_BAD"], [6000, "BAD"], [6999, "BAD"], [7000, "NEEDS_IMPROVEMENT"], [7999, "NEEDS_IMPROVEMENT"], [8000, "GOOD"], [8999, "GOOD"], [9000, "EXCELLENT"], [10000, "EXCELLENT"],
  ])("%i basis points is %s", async (bp, band) => {
    const u = await createUser();
    const e = await hundred(u);
    await seedFinalResult({ version: e.version, user: u, scoreCenti: bp });
    expect((await results(u)).items[0]).toMatchObject({ percentBp: bp, band });
    expect((await me(u)).trend[0]).toMatchObject({ percentBp: bp, band });
    expect((await summary(u)).recent[0]).toMatchObject({ percentBp: bp, band });
  });

  it("derives bands with the single classifier, not from a stored value", async () => {
    const u = await createUser();
    const e = await hundred(u);
    await seedFinalResult({ version: e.version, user: u, scoreCenti: 5999, bandOverride: "EXCELLENT" });
    expect((await results(u)).items[0]!.band).toBe("VERY_BAD");
    expect((await me(u)).bandCounts).toMatchObject({ VERY_BAD: 1, EXCELLENT: 0 });
    expect((await summary(u)).byBand).toMatchObject({ VERY_BAD: 1, EXCELLENT: 0 });
  });
});

describe("recent AI feedback (read-only)", () => {
  it("lists only the caller's own analyses with a short summary", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const e = await hundred(u);
    const o = await hundred(other);
    const a1 = await seedFinalResult({ version: e.version, user: u, scoreCenti: 7000 });
    const a2 = await seedFinalResult({ version: e.version, user: u, scoreCenti: 8000, attemptNo: 2 });
    const a3 = await seedFinalResult({ version: o.version, user: other, scoreCenti: 9000 });
    const rid = async (attemptId: string) => (await db.examResult.findUniqueOrThrow({ where: { attemptId } })).id;
    await db.examAnalysis.create({ data: { resultId: await rid(a1.id), userId: u.id, status: "READY", content: { summary: "x".repeat(400) }, generatedAt: new Date(Date.now() - 5000) } });
    await db.examAnalysis.create({ data: { resultId: await rid(a2.id), userId: u.id, status: "FAILED", content: { summary: "should not show" }, errorCode: "PROVIDER_UNAVAILABLE" } });
    await db.examAnalysis.create({ data: { resultId: await rid(a3.id), userId: other.id, status: "READY", content: { summary: "other user's feedback" }, generatedAt: new Date() } });
    const f = (await me(u)).recentFeedback;
    expect(f).toHaveLength(2);
    expect(f.find((x) => x.status === "READY")!.summary).toHaveLength(240);
    expect(f.find((x) => x.status === "FAILED")).toMatchObject({ summary: null, generatedAt: null });
    expect(JSON.stringify(f)).not.toContain("other user");
  });
});

describe("saved content, groups and notifications", () => {
  it("counts the caller's collections, MCQ/CQ questions and notes, and shows the next group exam", async () => {
    const [u, owner] = [await createUser(), await createUser()];
    const c = client(t, u);
    const mcq = (stem: string, note: string | null) => ({ kind: "MCQ", language: "en", stem, difficulty: "EASY", options: [{ text: `${stem} A` }, { text: `${stem} B` }], correctOptionId: "#0", shortNote: note });
    const cq = { kind: "CQ", language: "en", stem: "Discuss rivers", difficulty: "EASY", marks: 5, answerText: "Because." };
    const saved = await c.post("/api/questions", { questions: [mcq("What is one?", "A note"), mcq("What is two?", null), cq], collection: { create: { title: "Week 1" } } });
    expect(saved.status).toBe(201);
    await c.post("/api/collections", { title: "Week 2" });
    const group = await seedGroup(owner, { members: [{ user: u }] });
    const later = new Date(Date.now() + 3 * 86_400_000);
    await seedPublishedExam({ owner, group, opensAt: new Date(Date.now() + 3_600_000), closesAt: later, title: "Group midterm" });
    const a = await me(u);
    expect(a.saved).toMatchObject({ collections: 2, mcqQuestions: 2, cqQuestions: 1, questionsWithNotes: 1 });
    expect(a.saved.recentCollections.map((x) => x.title)).toEqual(["Week 2", "Week 1"]);
    expect(a.saved.recentCollections.find((x) => x.title === "Week 1")!.questionCount).toBe(3);
    expect(a.groups).toEqual([{ id: group.id, title: "Study group", role: "MEMBER", nextExam: expect.objectContaining({ title: "Group midterm", closesAt: later.toISOString() }) }]);
    // the author doesn't get their own exam as "next"; a taken exam disappears
    expect((await me(owner)).groups[0]!.nextExam).toBeNull();
    const base = (await me(u)).unreadNotifications; // sign-up creates a welcome notification
    await db.notification.create({ data: { userId: u.id, type: "x", title: "t", body: "b" } });
    expect((await me(u)).unreadNotifications).toBe(base + 1);
    await db.notification.updateMany({ where: { userId: u.id }, data: { readAt: new Date() } });
    expect((await me(u)).unreadNotifications).toBe(0);
  });
});

describe("one score everywhere: analytics, dashboard and leaderboard agree", () => {
  it("reports identical score, percentage and band for the same finalized results", async () => {
    const owner = await createUser({ name: "Olivia Owner" });
    const people = await Promise.all([1, 2, 3, 4].map((i) => createUser({ name: `Member ${i} Name` })));
    const group = await seedGroup(owner, { capacity: 50, members: people.map((user) => ({ user })) });
    const e = await seedPublishedExam({ owner, group, questionCount: 1, marksCenti: 10000, attemptLimit: 5 });
    const scores = [9050, 7500, 7500, 4321];
    for (const [i, p] of people.entries()) await seedFinalResult({ version: e.version, user: p, scoreCenti: scores[i]! });
    // a second, lower attempt for member 1: the leaderboard ranks the best, the list shows both
    await seedFinalResult({ version: e.version, user: people[0]!, scoreCenti: 3000, attemptNo: 2, finalizedAt: new Date(Date.now() + 1000) });
    for (const [i, p] of people.entries()) {
      const a = await me(p);
      const list = await results(p);
      const sum = await summary(p);
      const lb = await (await client(t, p).get(`/api/exams/${e.exam.id}/leaderboard`)).json();
      const mine = lb.myEntry;
      const best = list.items.reduce((m, x) => (x.percentBp > m.percentBp ? x : m));
      expect(best.percentBp).toBe(scores[i]);
      expect(mine).toMatchObject({ scoreCenti: scores[i], percentBp: scores[i], band: best.band });
      expect(a.totals.highest).toBe(scores[i]);
      expect(sum.best).toBe(scores[i]);
      expect(a.trend.map((x) => x.percentBp).sort((x, y) => x - y)).toEqual(list.items.map((x) => x.percentBp).sort((x, y) => x - y));
      expect(sum.recent.map((x: { percentBp: number }) => x.percentBp).sort((x: number, y: number) => x - y)).toEqual(list.items.map((x) => x.percentBp).sort((x, y) => x - y));
      expect(sum.averagePercentBp).toBe(a.totals.average);
      expect(sum.byBand).toEqual(a.bandCounts);
    }
    expect((await summary(people[0]!)).averagePercentBp).toBe(Math.floor((9050 + 3000) / 2 + 0.5));
  });
});

describe("dashboard summary keeps its shape", () => {
  it("still exposes the Part 4 keys", async () => {
    const u = await createUser();
    const s = await summary(u);
    expect(Object.keys(s).sort()).toEqual(["attempts", "averagePercentBp", "best", "byBand", "finalized", "groups", "recent", "upcoming"]);
    expect(randomUUID()).toBeTruthy();
  });
});
