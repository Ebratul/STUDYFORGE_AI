import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { setClock } from "../../src/lib/clock.js";
import { examHandlers, sweepOnce } from "../../src/modules/exams/jobs.js";
import { RetryableJobError, type JobRow } from "../../src/modules/jobs/queue.js";
import { seedGroup } from "../helpers/exam-fixtures.js";
import { ans, iso, paper, publishedExam, result, save, startAttempt, started, submit } from "../helpers/exam-api.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
let nowMs: number;
const MIN = 60_000;
const GRACE = 5000;
beforeEach(() => {
  t = makeApp();
  nowMs = Date.now();
  setClock(() => new Date(nowMs));
});
afterEach(() => setClock(null));

const fire = (handler: string, payload: Record<string, unknown>) =>
  examHandlers()[handler]!({ id: "job", type: handler, payload, attempts: 1, maxAttempts: 3 } as unknown as JobRow, new AbortController().signal);
const LEAK_KEYS = /"(isCorrect|correctOptionId|explanation|shortNote|sources|score|scoreCenti|percentBp|band|review|topics|outcome|awardedCenti)"/;
/** The bank fixtures write 'Explanation N' / 'Note N'; these texts must never appear before release. */
const LEAK_TEXT = /Explanation \d|Note \d/;

/** Runs one individual exam to completion through the API and returns the submit response. */
async function grade(opts: { n?: number; correct: number; wrong?: number; draft?: Record<string, unknown> }) {
  const u = await createUser();
  const ex = await publishedExam(t, u, { n: opts.n ?? 10, draft: opts.draft ?? {} });
  const a = await started(t, u, ex.examId);
  const res = await submit(t, u, a.id, { answers: paper(ex.snapshot, opts.correct, opts.wrong ?? 0) });
  expect(res.status).toBe(200);
  return { u, a, ...ex, body: await res.json() };
}

async function groupExam(members: number, draft: Record<string, unknown>, n = 3) {
  const owner = await createUser();
  const users: TestUser[] = [];
  for (let i = 0; i < members; i++) users.push(await createUser());
  const group = await seedGroup(owner, { members: users.map((user) => ({ user })) });
  nowMs = Date.now();
  const ex = await publishedExam(t, owner, { mode: "GROUP", groupId: group.id, n, draft });
  return { owner, users, group, ...ex };
}

describe("grading through the API", () => {
  it.each([
    [10, 0, 10_000, "EXCELLENT"], [9, 0, 9000, "EXCELLENT"], [8, 0, 8000, "GOOD"], [7, 0, 7000, "NEEDS_IMPROVEMENT"], [6, 0, 6000, "BAD"], [5, 0, 5000, "VERY_BAD"], [0, 0, 0, "VERY_BAD"],
  ])("%i correct of 10 (%i wrong) → %i bp, %s", async (correct, wrong, bp, band) => {
    const { body } = await grade({ correct, wrong });
    expect(body.score).toMatchObject({ percentBp: bp, band, scoreCenti: correct * 100, maxCenti: 1000, correct, incorrect: wrong, unanswered: 10 - correct - wrong });
    expect(body.score.feedback.label).toBeTruthy();
    expect(body.score.feedback.message.length).toBeGreaterThan(20);
  });

  it("negative marking: a quarter of each question's marks is lost per wrong answer", async () => {
    const { body } = await grade({ correct: 8, wrong: 2, draft: { negativeMarking: { fraction: 0.25 } } });
    expect(body.score).toMatchObject({ scoreCenti: 750, maxCenti: 1000, percentBp: 7500, band: "NEEDS_IMPROVEMENT", correct: 8, incorrect: 2 });
    const wrongItems = body.review.filter((r: { outcome: string }) => r.outcome === "INCORRECT");
    expect(wrongItems.map((r: { awardedCenti: number }) => r.awardedCenti)).toEqual([-25, -25]);
  });

  it("a negative total is shown as zero", async () => {
    const { body } = await grade({ n: 4, correct: 1, wrong: 3, draft: { negativeMarking: { fraction: 1 } } });
    const r = await db.examResult.findFirstOrThrow({ where: { attempt: { id: body.attemptId } } });
    expect(r).toMatchObject({ rawScoreCenti: -200, scoreCenti: 0, percentBp: 0, band: "VERY_BAD" });
    expect(body.score).toMatchObject({ scoreCenti: 0, percentBp: 0 });
  });

  it("custom marks per question and rounding: 2 of 3 equal questions = 66.67 % (Bad)", async () => {
    const { body } = await grade({ n: 3, correct: 2 });
    expect(body.score).toMatchObject({ percentBp: 6667, band: "BAD" });
    const per = await grade({ n: 3, correct: 1, draft: { marks: { perQuestion: 1.5 } } });
    expect(per.body.score).toMatchObject({ scoreCenti: 150, maxCenti: 450, percentBp: 3333 });
  });

  it("per-question mark overrides count toward the total and the score", async () => {
    const u = await createUser();
    const ex = await publishedExam(t, u, { n: 3 });
    // republish as a fresh exam with an override on the first question
    const c = client(t, u);
    const created = (await (await c.post("/api/exams", { title: "Override", mode: "INDIVIDUAL" })).json()).exam.id as string;
    await c.put(`/api/exams/${created}/draft`, { title: "Override", questionIds: ex.bank.map((b) => b.id), marks: { perQuestion: 1, overrides: { [ex.bank[0]!.id]: 3 } } });
    await c.post(`/api/exams/${created}/publish`);
    const snap = (await import("../helpers/exam-api.js")).snapshotOf;
    const s = await snap(created);
    expect(s.questions.map((q) => q.marksCenti)).toEqual([300, 100, 100]);
    const a = await started(t, u, created);
    const body = await (await submit(t, u, a.id, { answers: [ans(s.questions[0]!.id, s.questions[0]!.correctId, 1)] })).json();
    expect(body.score).toMatchObject({ scoreCenti: 300, maxCenti: 500, percentBp: 6000, band: "BAD" });
  });

  it("is deterministic: identical answers always score identically, regardless of option order shuffling", async () => {
    const g = await groupExam(2, { shuffleQuestions: true, shuffleOptions: true }, 6);
    const scores = [];
    for (const u of g.users) {
      const a = await started(t, u, g.examId);
      scores.push((await (await submit(t, u, a.id, { answers: paper(g.snapshot, 4, 1) })).json()).score);
    }
    expect(scores[0]).toEqual(scores[1]);
    expect(scores[0]).toMatchObject({ correct: 4, incorrect: 1, unanswered: 1 });
  });
});

describe("result content (released)", () => {
  it("FULL review: choices, correct answers, explanations, notes and sources, in the participant's order", async () => {
    const g = await groupExam(1, { shuffleQuestions: true, reviewPolicy: "FULL" }, 4);
    const u = g.users[0]!;
    const a = await started(t, u, g.examId);
    const body = await (await submit(t, u, a.id, { answers: paper(g.snapshot, 2, 1) })).json();
    expect(body.reviewPolicy).toBe("FULL");
    expect(body.review).toHaveLength(4);
    const order = (await db.examAttempt.findUniqueOrThrow({ where: { id: a.id } })).questionOrder as string[];
    expect(body.review.map((r: { questionId: string }) => r.questionId)).toEqual(order);
    expect(body.review.map((r: { position: number }) => r.position)).toEqual([1, 2, 3, 4]);
    for (const r of body.review) {
      const q = g.snapshot.questions.find((x) => x.id === r.questionId)!;
      expect(r.correctOptionId).toBe(q.correctId);
      expect(r.explanation).toMatch(/^Explanation \d+$/);
      expect(r.shortNote).toMatch(/^Note \d+$/);
      expect(r.sources).toEqual([]);
      expect(r.options).toHaveLength(4);
      if (r.outcome === "CORRECT") expect(r.selectedOptionId).toBe(q.correctId);
      if (r.outcome === "INCORRECT") expect(r.selectedOptionId).toBe(q.wrongId);
      if (r.outcome === "UNANSWERED") expect(r.selectedOptionId).toBeNull();
    }
  });

  it("CORRECTNESS review shows right/wrong but never the key, explanation or notes; NONE shows the score only", async () => {
    const c = await grade({ n: 3, correct: 1, wrong: 1, draft: { reviewPolicy: "CORRECTNESS" } });
    const raw = JSON.stringify(c.body);
    expect(c.body.review.map((r: { outcome: string }) => r.outcome)).toEqual(["CORRECT", "INCORRECT", "UNANSWERED"]);
    expect(raw).not.toMatch(/"(correctOptionId|explanation|shortNote|sources|isCorrect)"/);
    expect(raw).not.toMatch(LEAK_TEXT);
    const n = await grade({ n: 3, correct: 1, draft: { reviewPolicy: "NONE" } });
    expect(n.body.score.scoreCenti).toBe(100);
    expect(n.body).not.toHaveProperty("review");
    expect(JSON.stringify(n.body)).not.toMatch(LEAK_TEXT);
    // the standalone result endpoint behaves the same
    const again = await (await result(t, n.u, n.a.id)).json();
    expect(again).not.toHaveProperty("review");
    expect(again.release).toMatchObject({ released: true, mode: "IMMEDIATE", releasesAt: null });
  });

  it("topic-level performance, weakest first, with a 'General' bucket", async () => {
    const u = await createUser();
    const ex = await publishedExam(t, u, { n: 4 });
    const a = await started(t, u, ex.examId);
    const [q1, q2, q3, q4] = ex.snapshot.questions; // topics: A, B, A, B
    const body = await (await submit(t, u, a.id, { answers: [ans(q1!.id, q1!.correctId, 1), ans(q2!.id, q2!.correctId, 1), ans(q3!.id, q3!.wrongId, 1), ans(q4!.id, q4!.correctId, 1)] })).json();
    expect(body.topics).toEqual([
      { topic: "Topic A", questions: 2, correct: 1, incorrect: 1, unanswered: 0, percentBp: 5000 },
      { topic: "Topic B", questions: 2, correct: 2, incorrect: 0, unanswered: 0, percentBp: 10_000 },
    ]);
    await db.$executeRaw`ALTER TABLE "ExamQuestionSnapshot" DISABLE TRIGGER "ExamQuestionSnapshot_immutable"`;
    try {
      await db.$executeRaw`UPDATE "ExamQuestionSnapshot" SET "topic" = NULL WHERE "id" = ${q1!.id}`;
      const general = await (await result(t, u, a.id)).json();
      expect(general.topics.map((x: { topic: string }) => x.topic).sort()).toEqual(["General", "Topic A", "Topic B"]);
    } finally {
      await db.$executeRaw`ALTER TABLE "ExamQuestionSnapshot" ENABLE TRIGGER "ExamQuestionSnapshot_immutable"`;
    }
  });

  it("retry information follows the attempt limit and the exam's availability", async () => {
    const u = await createUser();
    const ex = await publishedExam(t, u, { n: 2, draft: { attemptLimit: 2 } });
    const a1 = await started(t, u, ex.examId);
    expect((await (await submit(t, u, a1.id)).json()).retry).toEqual({ allowed: true, attemptsLeft: 1 });
    const a2 = (await (await startAttempt(t, u, ex.examId)).json()).attempt;
    expect((await (await submit(t, u, a2.id)).json()).retry).toEqual({ allowed: false, attemptsLeft: 0 });
    expect((await (await result(t, u, a1.id)).json()).retry.attemptsLeft).toBe(0);
  });

  it("an attempt that is still running has no result (409)", async () => {
    const u = await createUser();
    const ex = await publishedExam(t, u);
    const a = await started(t, u, ex.examId);
    const res = await result(t, u, a.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("only the participant can read a result; not other members, not the exam's author", async () => {
    const g = await groupExam(2, {});
    const [a, b] = g.users;
    const at = await started(t, a!, g.examId);
    await submit(t, a!, at.id, { answers: paper(g.snapshot, 3) });
    expect((await result(t, a!, at.id)).status).toBe(200);
    expect((await result(t, b!, at.id)).status).toBe(404);
    expect((await result(t, g.owner, at.id)).status).toBe(404);
    expect((await client(t, g.owner).get(`/api/attempts/${at.id}`)).status).toBe(404);
  });
});

describe("release policies", () => {
  async function windowed(mode: "AFTER_CLOSE" | "AT_TIME", reviewPolicy = "FULL") {
    const closes = nowMs + 60 * MIN;
    const releaseAt = closes + 30 * MIN;
    const g = await groupExam(2, { window: { closesAt: iso(closes) }, release: mode === "AT_TIME" ? { mode, at: iso(releaseAt) } : { mode }, reviewPolicy, leaderboardVisible: true });
    const [u, v] = g.users;
    const a = await started(t, u!, g.examId);
    await save(t, u!, a.id, paper(g.snapshot, 2, 1));
    nowMs += 5 * MIN;
    const sub = await submit(t, u!, a.id, { answers: [ans(g.snapshot.questions[0]!.id, g.snapshot.questions[0]!.correctId, 2)] });
    return { g, u: u!, v: v!, a, sub, closes, releaseAt, releasesAt: mode === "AT_TIME" ? releaseAt : closes + GRACE };
  }

  it("AFTER_CLOSE: nothing about the score or the key is returned until closing time + grace", async () => {
    const { g, u, a, sub, closes } = await windowed("AFTER_CLOSE");
    const body = await sub.json();
    expect(body).toMatchObject({ status: "SUBMITTED", alreadyFinalized: false, release: { released: false, mode: "AFTER_CLOSE", releasesAt: iso(closes + GRACE) } });
    expect(JSON.stringify(body)).not.toMatch(LEAK_KEYS);
    expect(JSON.stringify(body)).not.toMatch(LEAK_TEXT);
    // the stored result exists, but no payload shows it
    expect(await db.examResult.count({ where: { attemptId: a.id } })).toBe(1);
    nowMs = closes + GRACE - 1;
    const early = await (await result(t, u, a.id)).text();
    expect(early).not.toMatch(LEAK_KEYS);
    expect(JSON.parse(early).release.released).toBe(false);
    // other surfaces too
    const list = await (await client(t, u).get("/api/attempts")).text();
    expect(list).not.toMatch(/"(scoreCenti|percentBp|band)"/);
    expect(JSON.parse(list).items[0].result.released).toBe(false);
    const exams = await (await client(t, u).get("/api/exams?scope=history")).json();
    expect(exams.items[0].myAttempts.bestPercentBp).toBeNull();
    const view = await (await client(t, u).get(`/api/attempts/${a.id}`)).text();
    expect(view).not.toMatch(LEAK_KEYS);
    expect((await client(t, u).get(`/api/exams/${g.examId}`).then((r) => r.text()))).not.toMatch(LEAK_KEYS);

    nowMs = closes + GRACE;
    const full = await (await result(t, u, a.id)).json();
    expect(full.release.released).toBe(true);
    expect(full.score).toMatchObject({ correct: 2, incorrect: 1 });
    expect(full.review[0]).toHaveProperty("correctOptionId");
    expect((await (await client(t, u).get("/api/attempts")).json()).items[0].result).toMatchObject({ released: true, scoreCenti: 200 });
    expect((await (await client(t, u).get("/api/exams?scope=history")).json()).items[0].myAttempts.bestPercentBp).toBe(6667);
  });

  it("AT_TIME: released exactly at the stated time, independent of the closing time", async () => {
    const { u, a, releaseAt, closes } = await windowed("AT_TIME", "CORRECTNESS");
    nowMs = closes + 10 * MIN;
    expect((await (await result(t, u, a.id)).json()).release).toMatchObject({ released: false, releasesAt: iso(releaseAt) });
    nowMs = releaseAt - 1;
    expect(JSON.parse(await (await result(t, u, a.id)).text()).release.released).toBe(false);
    nowMs = releaseAt;
    const r = await (await result(t, u, a.id)).json();
    expect(r.release.released).toBe(true);
    expect(r.review[0]).not.toHaveProperty("correctOptionId"); // CORRECTNESS review even after release
  });

  it("release notices: sent once at release time by the job or the sweeper, never early, never twice", async () => {
    const { g, u, v, a, releasesAt } = await windowed("AT_TIME", "FULL");
    const b = await started(t, v, g.examId);
    nowMs = releasesAt - 20 * MIN;
    await submit(t, v, b.id);
    const ofVersion = () => db.notification.findMany({ where: { type: "exam.results_available", dedupeKey: { startsWith: `results:${g.snapshot.versionId}` } } });
    expect(await ofVersion()).toHaveLength(0);
    await expect(fire("exam.release", { versionId: g.snapshot.versionId })).rejects.toBeInstanceOf(RetryableJobError);
    await sweepOnce();
    expect(await ofVersion()).toHaveLength(0); // not early, by any path
    nowMs = releasesAt;
    await fire("exam.release", { versionId: g.snapshot.versionId });
    await fire("exam.release", { versionId: g.snapshot.versionId });
    await sweepOnce();
    const notes = await ofVersion();
    expect(notes.map((n) => n.userId).sort()).toEqual([u.id, v.id].sort());
    expect(notes.find((n) => n.userId === u.id)!.link).toBe(`/attempts/${a.id}/result`);
    expect((await db.examVersionState.findUniqueOrThrow({ where: { examVersionId: g.snapshot.versionId } })).resultsNotifiedAt).not.toBeNull();
  });

  it("IMMEDIATE: results_available is sent at submission and a replay creates nothing new", async () => {
    const { u, a } = await grade({ n: 2, correct: 1 });
    const count = () => db.notification.count({ where: { userId: u.id, type: { in: ["exam.submitted", "exam.results_available"] } } });
    expect(await count()).toBe(2);
    const note = await db.notification.findFirstOrThrow({ where: { userId: u.id, type: "exam.submitted" } });
    expect(note).toMatchObject({ title: "Submission received", link: `/attempts/${a.id}/result` });
    await submit(t, u, a.id);
    await sweepOnce();
    expect(await count()).toBe(2);
  });

  it("a timed-out attempt gets its own notification wording", async () => {
    const u = await createUser();
    const ex = await publishedExam(t, u, { draft: { durationMinutes: 10 } });
    const a = await started(t, u, ex.examId);
    nowMs += 10 * MIN + GRACE + 1;
    await client(t, u).get(`/api/attempts/${a.id}`);
    const note = await db.notification.findFirstOrThrow({ where: { userId: u.id, type: "exam.submitted" } });
    expect(note.body).toMatch(/Time ran out/);
  });
});

describe("no answer key before release (every payload a participant can reach)", () => {
  it("take view, attempt view, autosave and submit/result responses never carry the key, explanations, notes, sources or scores", async () => {
    const closes = nowMs + 3 * 60 * MIN;
    const g = await groupExam(2, { window: { closesAt: iso(closes) }, release: { mode: "AFTER_CLOSE" }, reviewPolicy: "FULL", negativeMarking: { fraction: 0.25 } }, 4);
    const [u, v] = g.users;
    const payloads: [string, string][] = [];
    const grab = async (label: string, res: Response) => {
      expect(res.status, label).toBeLessThan(500);
      payloads.push([label, await res.text()]);
    };
    await grab("exam take view", await client(t, u!).get(`/api/exams/${g.examId}`));
    await grab("exam list", await client(t, u!).get("/api/exams?scope=available"));
    const start = await startAttempt(t, u!, g.examId);
    const a = (await start.clone().json()).attempt;
    await grab("start attempt", start);
    await grab("get attempt", await client(t, u!).get(`/api/attempts/${a.id}`));
    await grab("autosave", await save(t, u!, a.id, paper(g.snapshot, 2, 1)));
    await grab("autosave (invalid)", await save(t, u!, a.id, [ans("zzz", null, 1)]));
    await grab("early result (409)", await result(t, u!, a.id));
    await grab("attempts list", await client(t, u!).get("/api/attempts"));
    await grab("exam attempts", await client(t, u!).get(`/api/exams/${g.examId}/attempts`));
    await grab("submit", await submit(t, u!, a.id));
    await grab("submit again", await submit(t, u!, a.id));
    await grab("result", await result(t, u!, a.id));
    await grab("autosave after submit (409)", await save(t, u!, a.id, [ans(g.snapshot.questions[0]!.id, null, 50)]));
    await grab("get attempt (finalized)", await client(t, u!).get(`/api/attempts/${a.id}`));
    await grab("attempts list (finalized)", await client(t, u!).get("/api/attempts"));
    await grab("exam list (history)", await client(t, u!).get("/api/exams?scope=history"));
    // a second member's expired, never-submitted attempt
    const b = await started(t, v!, g.examId);
    nowMs += 4 * 60 * MIN; // after closing, but results released only at closes + grace
    nowMs = closes + GRACE - 1;
    await grab("expired attempt (lazy)", await client(t, v!).get(`/api/attempts/${b.id}`));
    await grab("expired attempt result", await result(t, v!, b.id));
    for (const [label, body] of payloads) {
      expect(body, label).not.toMatch(LEAK_KEYS);
      expect(body, label).not.toMatch(LEAK_TEXT);
    }
    // and the same scans have teeth: after release the data IS there
    nowMs = closes + GRACE;
    const released = await (await result(t, u!, a.id)).text();
    expect(released).toMatch(LEAK_KEYS);
    expect(released).toMatch(LEAK_TEXT);
  });
});

describe("dashboard summary", () => {
  it("counts released results only and reports real figures", async () => {
    const u = await createUser();
    const ex1 = await publishedExam(t, u, { n: 10 });
    const a1 = await started(t, u, ex1.examId);
    await submit(t, u, a1.id, { answers: paper(ex1.snapshot, 8) }); // 80 %: Good
    const ex2 = await publishedExam(t, u, { n: 4, title: "Later release", draft: { window: { closesAt: iso(nowMs + 120 * MIN) }, release: { mode: "AFTER_CLOSE" } } });
    const a2 = await started(t, u, ex2.examId);
    await submit(t, u, a2.id, { answers: paper(ex2.snapshot, 4) }); // 100 %, but not released
    const g = await groupExam(0, {});
    await db.groupMember.create({ data: { groupId: g.group.id, userId: u.id } });
    const upcomingExam = await groupExam(0, { window: { opensAt: iso(nowMs + 60 * MIN), closesAt: iso(nowMs + 180 * MIN) } });
    await db.groupMember.create({ data: { groupId: upcomingExam.group.id, userId: u.id } });

    const sum = await (await client(t, u).get("/api/dashboard/summary")).json();
    expect(sum.exams).toMatchObject({ attempts: 2, finalized: 2, averagePercentBp: 8000, best: 8000, groups: 2 });
    expect(sum.exams.byBand).toEqual({ EXCELLENT: 0, GOOD: 1, NEEDS_IMPROVEMENT: 0, BAD: 0, VERY_BAD: 0 });
    expect(sum.exams.recent).toEqual([expect.objectContaining({ attemptId: a1.id, examId: ex1.examId, percentBp: 8000, band: "GOOD" })]);
    expect(sum.exams.upcoming.map((x: { examId: string }) => x.examId)).toContain(upcomingExam.examId);
    expect(sum.exams.recent.map((x: { title: string }) => x.title)).not.toContain("Later release"); // its result is not released yet
    nowMs += 130 * MIN;
    const later = await (await client(t, u).get("/api/dashboard/summary")).json();
    expect(later.exams).toMatchObject({ averagePercentBp: 9000, best: 10_000 });
    expect(later.exams.byBand).toMatchObject({ EXCELLENT: 1, GOOD: 1 });
    const fresh = await createUser();
    expect((await (await client(t, fresh).get("/api/dashboard/summary")).json()).exams).toMatchObject({ attempts: 0, finalized: 0, averagePercentBp: null, best: null, recent: [], upcoming: [], groups: 0 });
  });
});

describe("attempt history", () => {
  it("lists my attempts newest first with status filter and pagination", async () => {
    const u = await createUser();
    const ex = await publishedExam(t, u, { n: 2, draft: { attemptLimit: 3 } });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const a = i === 0 ? await started(t, u, ex.examId) : (await (await startAttempt(t, u, ex.examId)).json()).attempt;
      await submit(t, u, a.id, { answers: paper(ex.snapshot, i + 1) });
      ids.push(a.id);
      nowMs += 1000;
    }
    const third = (await (await startAttempt(t, u, ex.examId)).json()).attempt;
    const all = (await (await client(t, u).get("/api/attempts")).json()) as { items: { id: string; status: string; attemptNo: number; result: { released: boolean; percentBp?: number } }[]; total: number };
    expect(all.total).toBe(3);
    expect(all.items.map((i) => i.id)).toEqual([third.id, ids[1], ids[0]]);
    expect(all.items[1]!.result).toMatchObject({ released: true, percentBp: 10_000 });
    expect(all.items[0]!.result.released).toBe(true);
    expect((await (await client(t, u).get("/api/attempts?status=IN_PROGRESS")).json()).items.map((i: { id: string }) => i.id)).toEqual([third.id]);
    expect((await (await client(t, u).get("/api/attempts?pageSize=2&page=2")).json()).items).toHaveLength(1);
    expect((await (await client(t, u).get(`/api/exams/${ex.examId}/attempts`)).json()).items).toHaveLength(3);
    expect((await client(t, u).get("/api/attempts?status=DONE")).status).toBe(422);
  });
});
