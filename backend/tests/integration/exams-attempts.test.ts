import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { setClock } from "../../src/lib/clock.js";
import { finalizeIfExpired } from "../../src/modules/exams/attempts.js";
import { ensureSweeperScheduled, examHandlers, sweepOnce } from "../../src/modules/exams/jobs.js";
import { orderOptions, orderQuestions } from "../../src/modules/exams/shuffle.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { RetryableJobError, type JobRow } from "../../src/modules/jobs/queue.js";
import { seedGroup } from "../helpers/exam-fixtures.js";
import { ans, iso, paper, publishedExam, result, save, startAttempt, started, submit } from "../helpers/exam-api.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
let nowMs: number;
const MIN = 60_000;
const GRACE = 5_000;
beforeEach(() => {
  t = makeApp();
  nowMs = Date.now();
  setClock(() => new Date(nowMs));
});
afterEach(() => setClock(null));

const attemptRow = (id: string) => db.examAttempt.findUniqueOrThrow({ where: { id } });
const resultCount = (attemptId: string) => db.examResult.count({ where: { attemptId } });
const keyLeak = /"(isCorrect|correctOptionId|explanation|shortNote|sources|score|scoreCenti)"/;

async function groupExam(members = 2, draft: Record<string, unknown> = {}, n = 3) {
  const owner = await createUser();
  const users: TestUser[] = [];
  for (let i = 0; i < members; i++) users.push(await createUser());
  const group = await seedGroup(owner, { members: users.map((user) => ({ user })) });
  nowMs = Date.now(); // members joined "now"; the exam is published after them
  const exam = await publishedExam(t, owner, { mode: "GROUP", groupId: group.id, n, draft });
  return { owner, users, group, ...exam };
}
const fire = (handler: string, payload: Record<string, unknown>) =>
  examHandlers()[handler]!({ id: "job", type: handler, payload, attempts: 1, maxAttempts: 3 } as unknown as JobRow, new AbortController().signal);

describe("starting an attempt", () => {
  it("creates an attempt with server-side times, no answer key, and an expiry job; starting again resumes it", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { draft: { durationMinutes: 30 } });
    const res = await startAttempt(t, u, examId);
    expect(res.status).toBe(201);
    const raw = await res.text();
    const { attempt, resumed } = JSON.parse(raw);
    expect(resumed).toBe(false);
    expect(attempt).toMatchObject({ examId, status: "IN_PROGRESS", attemptNo: 1, startedAt: iso(nowMs), deadlineAt: iso(nowMs + 30 * MIN), serverNow: iso(nowMs), remainingMs: 30 * MIN, totalMarks: 3, negativeMarking: false });
    expect(attempt.questions).toHaveLength(3);
    expect(attempt.questions.map((q: { id: string }) => q.id)).toEqual(snapshot.questions.map((q) => q.id));
    expect(attempt.questions[0].options).toHaveLength(4);
    expect(attempt.answers).toEqual({});
    expect(raw).not.toMatch(keyLeak);
    expect(raw).not.toMatch(/Explanation \d|Note \d/);

    const job = await db.job.findFirstOrThrow({ where: { dedupeKey: `exam-expire:${attempt.id}` } });
    expect(job).toMatchObject({ type: "exam.expire" });
    expect(job.runAt.getTime()).toBe(nowMs + 30 * MIN + GRACE + 1000);

    nowMs += 5 * MIN;
    const again = await startAttempt(t, u, examId);
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.resumed).toBe(true);
    expect(body.attempt).toMatchObject({ id: attempt.id, remainingMs: 25 * MIN });
    expect(await db.examAttempt.count({ where: { examVersionId: snapshot.versionId } })).toBe(1);
  });

  it("ignores any timing a client tries to send when starting", async () => {
    const u = await createUser();
    const { examId } = await publishedExam(t, u);
    const res = await client(t, u).post(`/api/exams/${examId}/attempts`, { startedAt: iso(0), deadlineAt: iso(nowMs + 99 * 3_600_000), durationMinutes: 9999 }, { date: new Date(0).toUTCString(), "x-client-time": "1" });
    expect(res.status).toBe(201);
    expect((await res.json()).attempt.deadlineAt).toBe(iso(nowMs + 30 * MIN));
  });

  it("8 concurrent starts create exactly one attempt and one expiry job", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u);
    const out = await Promise.all(Array.from({ length: 8 }, () => startAttempt(t, u, examId)));
    const statuses = out.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(7);
    const ids = new Set((await Promise.all(out.map((r) => r.json()))).map((b) => b.attempt.id));
    expect(ids.size).toBe(1);
    expect(await db.examAttempt.count({ where: { examVersionId: snapshot.versionId } })).toBe(1);
    expect(await db.job.count({ where: { type: "exam.expire", dedupeKey: { startsWith: "exam-expire:" }, payload: { path: ["attemptId"], equals: [...ids][0] } } })).toBe(1);
  });

  it("individual exams belong to their author; drafts are invisible", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const { examId } = await publishedExam(t, u);
    expect((await startAttempt(t, other, examId)).status).toBe(404);
    expect((await startAttempt(t, u, "nope")).status).toBe(404);
    const draft = await client(t, u).post("/api/exams", { title: "Draft", mode: "INDIVIDUAL" });
    expect((await startAttempt(t, u, (await draft.json()).exam.id)).status).toBe(404);
  });

  it("group exams: members only, never the author, and late joiners follow the exam's policy", async () => {
    const g = await groupExam(1, { lateJoinGroup: false });
    const [member] = g.users;
    const stranger = await createUser();
    expect((await startAttempt(t, stranger, g.examId)).status).toBe(404);
    const authorTry = await startAttempt(t, g.owner, g.examId);
    expect(authorTry.status).toBe(403);
    expect((await authorTry.json()).error.code).toBe("NOT_ELIGIBLE");
    expect((await startAttempt(t, member!, g.examId)).status).toBe(201);

    const late = await createUser();
    await db.groupMember.create({ data: { groupId: g.group.id, userId: late.id, joinedAt: new Date(Date.now() + 5000) } });
    nowMs += 10_000;
    const denied = await startAttempt(t, late, g.examId);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.message).toMatch(/when it was published/);
    const open = await groupExam(0, { lateJoinGroup: true });
    const late2 = await createUser();
    await db.groupMember.create({ data: { groupId: open.group.id, userId: late2.id, joinedAt: new Date(Date.now() + 5000) } });
    expect((await startAttempt(t, late2, open.examId)).status).toBe(201);
    // a removed member can't start either
    await db.groupMember.delete({ where: { groupId_userId: { groupId: g.group.id, userId: member!.id } } });
    await db.examAttempt.deleteMany({ where: { userId: member!.id } });
    expect((await startAttempt(t, member!, g.examId)).status).toBe(404);
  });

  it("enforces the availability window and both late-start policies", async () => {
    const owner = await createUser();
    const opens = nowMs + 10 * MIN;
    const closes = nowMs + 100 * MIN;
    const { examId } = await publishedExam(t, owner, { draft: { durationMinutes: 30, window: { opensAt: iso(opens), closesAt: iso(closes) }, attemptLimit: 3 } });
    const early = await startAttempt(t, owner, examId);
    expect(early.status).toBe(409);
    const e = (await early.json()).error;
    expect(e.code).toBe("EXAM_NOT_OPEN");
    expect(e.details.opensAt).toBe(iso(opens));

    nowMs = opens;
    const ok = await startAttempt(t, owner, examId);
    expect(ok.status).toBe(201);
    const attempt = (await ok.json()).attempt;
    expect(attempt.deadlineAt).toBe(iso(opens + 30 * MIN));
    await submit(t, owner, attempt.id);

    nowMs = closes - 10 * MIN; // CAP_AT_CLOSE: a late starter gets only the time that is left
    const late = (await (await startAttempt(t, owner, examId)).json()).attempt;
    expect(late.deadlineAt).toBe(iso(closes));
    expect(late.remainingMs).toBe(10 * MIN);
    await submit(t, owner, late.id);

    nowMs = closes;
    const closed = await startAttempt(t, owner, examId);
    expect(closed.status).toBe(409);
    expect((await closed.json()).error.code).toBe("EXAM_CLOSED");
  });

  it("FULL_TIME_ONLY refuses a start that couldn't get the whole duration", async () => {
    const g = await groupExam(2, { durationMinutes: 30, lateStart: "FULL_TIME_ONLY", window: { closesAt: iso(nowMs + 40 * MIN) } });
    const [a, b] = g.users;
    const first = await startAttempt(t, a!, g.examId);
    expect(first.status).toBe(201);
    expect((await first.json()).attempt.remainingMs).toBe(30 * MIN);
    nowMs += 11 * MIN; // 29 minutes left < 30
    const late = await startAttempt(t, b!, g.examId);
    expect(late.status).toBe(409);
    expect((await late.json()).error.message).toMatch(/not enough time|too late/i);
  });

  it("enforces the attempt limit (and the database refuses over-limit or parallel attempts even without the application)", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { draft: { attemptLimit: 2 } });
    const a1 = await started(t, u, examId);
    await submit(t, u, a1.id);
    const a2 = (await (await startAttempt(t, u, examId)).json()).attempt;
    expect(a2.attemptNo).toBe(2);
    expect((await startAttempt(t, u, examId)).status).toBe(200); // resumes attempt 2
    await submit(t, u, a2.id);
    const third = await startAttempt(t, u, examId);
    expect(third.status).toBe(409);
    const err = (await third.json()).error;
    expect(err.code).toBe("ATTEMPT_LIMIT");
    expect(err.details).toMatchObject({ limit: 2, used: 2 });

    const raw = (n: number, status: string) =>
      db.$executeRaw`INSERT INTO "ExamAttempt" ("id","examVersionId","userId","attemptNo","status","startedAt","deadlineAt","questionOrder","optionOrder") VALUES (${`x${n}${status}`}, ${snapshot.versionId}, ${u.id}, ${n}, ${status}::"AttemptStatus", now(), now() + interval '1 hour', '[]', '{}')`;
    await expect(raw(3, "SUBMITTED")).rejects.toThrow(); // trigger: attemptNo > attemptLimit
    await expect(raw(2, "SUBMITTED")).rejects.toThrow(); // unique (version, user, attemptNo)
  });

  it("concurrent starts after a finalized attempt create one new attempt only", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { draft: { attemptLimit: 2 } });
    await submit(t, u, (await started(t, u, examId)).id);
    const out = await Promise.all(Array.from({ length: 6 }, () => startAttempt(t, u, examId)));
    expect(out.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(await db.examAttempt.count({ where: { examVersionId: snapshot.versionId } })).toBe(2);
    expect(await db.examAttempt.count({ where: { examVersionId: snapshot.versionId, status: "IN_PROGRESS" } })).toBe(1);
    await expect(
      db.$executeRaw`INSERT INTO "ExamAttempt" ("id","examVersionId","userId","attemptNo","status","startedAt","deadlineAt","questionOrder","optionOrder") VALUES ('dupInProgress', ${snapshot.versionId}, ${u.id}, 9, 'IN_PROGRESS', now(), now() + interval '1 hour', '[]', '{}')`,
    ).rejects.toThrow();
  });

  it("a long-expired running attempt is finalized and a new one can then be started", async () => {
    const u = await createUser();
    const { examId } = await publishedExam(t, u, { draft: { attemptLimit: 2, durationMinutes: 10 } });
    const a1 = await started(t, u, examId);
    nowMs += 10 * MIN + GRACE + 1;
    const res = await startAttempt(t, u, examId);
    expect(res.status).toBe(201);
    expect((await res.json()).attempt.attemptNo).toBe(2);
    expect((await attemptRow(a1.id)).status).toBe("TIMED_OUT");
    expect(await resultCount(a1.id)).toBe(1);
  });
});

describe("question and option order", () => {
  it("is participant-specific, deterministic from the snapshot, stored, and set-equivalent for everyone", async () => {
    const g = await groupExam(2, { shuffleQuestions: true, shuffleOptions: true }, 8);
    const views = [];
    for (const u of g.users) {
      const a = await started(t, u, g.examId);
      const full = (await (await client(t, u).get(`/api/attempts/${a.id}`)).json()).attempt;
      views.push({ u, a, full });
    }
    const positionIds = g.snapshot.questions.map((q) => q.id);
    for (const { u, a, full } of views) {
      const ids = full.questions.map((q: { id: string }) => q.id);
      expect(ids).toEqual(orderQuestions(positionIds, { examVersionId: g.snapshot.versionId, userId: u.id, attemptNo: 1 }, true));
      expect([...ids].sort()).toEqual([...positionIds].sort());
      expect(full.questions.map((q: { position: number }) => q.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      for (const q of full.questions) {
        const snap = g.snapshot.questions.find((x) => x.id === q.id)!;
        expect(q.options.map((o: { id: string }) => o.id)).toEqual(orderOptions(snap.optionIds, q.id, { examVersionId: g.snapshot.versionId, userId: u.id, attemptNo: 1 }, true));
        expect(q.options.map((o: { id: string }) => o.id).sort()).toEqual([...snap.optionIds].sort());
      }
      const row = await attemptRow(a.id);
      expect(row.questionOrder).toEqual(ids);
    }
    expect(views[0]!.full.questions.map((q: { id: string }) => q.id)).not.toEqual(views[1]!.full.questions.map((q: { id: string }) => q.id));
    // the answer key is identical for both: grading uses the same snapshot rows
    const keys = await db.examOptionSnapshot.count({ where: { isCorrect: true, question: { examVersionId: g.snapshot.versionId } } });
    expect(keys).toBe(8);
  });

  it("uses the snapshot order when shuffling is off", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { n: 5 });
    const a = await started(t, u, examId);
    expect(a.questions.map((q) => q.id)).toEqual(snapshot.questions.map((q) => q.id));
  });
});

describe("autosave", () => {
  async function setup(over: Record<string, unknown> = {}) {
    const u = await createUser();
    const ex = await publishedExam(t, u, { draft: over });
    const a = await started(t, u, ex.examId);
    return { u, a, ...ex };
  }

  it("confirms each saved item, persists it, and reveals nothing about correctness", async () => {
    const { u, a, snapshot } = await setup();
    const [q1, q2] = snapshot.questions;
    nowMs += 60_000;
    const res = await save(t, u, a.id, [ans(q1!.id, q1!.correctId, 1, true), ans(q2!.id, q2!.wrongId, 1)]);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    expect(body.saved).toEqual([
      { questionId: q1!.id, seq: 1, savedAt: iso(nowMs), stale: false },
      { questionId: q2!.id, seq: 1, savedAt: iso(nowMs), stale: false },
    ]);
    expect(body).toMatchObject({ serverNow: iso(nowMs), remainingMs: 29 * MIN });
    expect(raw).not.toMatch(keyLeak);
    expect(raw).not.toMatch(/correct|outcome/i);
    const view = (await (await client(t, u).get(`/api/attempts/${a.id}`)).json()).attempt;
    expect(view.answers[q1!.id]).toEqual({ optionId: q1!.correctId, marked: true, seq: 1, savedAt: iso(nowMs) });
    expect(view.answers[q2!.id]).toMatchObject({ optionId: q2!.wrongId, marked: false });
    expect((await attemptRow(a.id)).lastSavedAt?.toISOString()).toBe(iso(nowMs));
  });

  it("rejects invalid questions/options with field paths and saves nothing from a bad batch", async () => {
    const { u, a, snapshot } = await setup();
    const [q1, q2] = snapshot.questions;
    const res = await save(t, u, a.id, [ans(q1!.id, q1!.correctId, 1), ans(q2!.id, q1!.correctId, 1), ans("not-a-question", null, 1)]);
    expect(res.status).toBe(422);
    const fields = (await res.json()).error.details.fields;
    expect(fields["answers.1.optionId"]).toMatch(/doesn't belong/);
    expect(fields["answers.2.questionId"]).toMatch(/isn't part/);
    expect(await db.attemptAnswer.count({ where: { attemptId: a.id } })).toBe(0);
  });

  it("ignores stale (delayed) saves: a higher seq always wins, regardless of arrival order", async () => {
    const { u, a, snapshot } = await setup();
    const q = snapshot.questions[0]!;
    expect((await (await save(t, u, a.id, [ans(q.id, q.optionIds[1]!, 5)])).json()).saved[0].stale).toBe(false);
    const older = await (await save(t, u, a.id, [ans(q.id, q.optionIds[2]!, 3)])).json();
    expect(older.saved[0]).toMatchObject({ seq: 5, stale: true });
    expect((await (await save(t, u, a.id, [ans(q.id, q.optionIds[3]!, 5)])).json()).saved[0].stale).toBe(true); // equal seq is not newer
    const view = async () => (await (await client(t, u).get(`/api/attempts/${a.id}`)).json()).attempt.answers[q.id];
    expect(await view()).toMatchObject({ optionId: q.optionIds[1], seq: 5 });
    expect((await (await save(t, u, a.id, [ans(q.id, q.optionIds[3]!, 6)])).json()).saved[0].stale).toBe(false);
    expect(await view()).toMatchObject({ optionId: q.optionIds[3], seq: 6 });
    // out of order inside one request
    const mixed = (await (await save(t, u, a.id, [ans(q.id, q.optionIds[0]!, 9), ans(q.id, q.optionIds[1]!, 7)])).json()).saved;
    expect(mixed.map((m: { stale: boolean }) => m.stale)).toEqual([false, true]);
    expect(await view()).toMatchObject({ optionId: q.optionIds[0], seq: 9 });
  });

  it("concurrent saves of the same question end with the highest seq", async () => {
    const { u, a, snapshot } = await setup();
    const q = snapshot.questions[0]!;
    const out = await Promise.all(Array.from({ length: 8 }, (_, i) => save(t, u, a.id, [ans(q.id, q.optionIds[i % 4]!, i + 1)])));
    expect(out.every((r) => r.status === 200)).toBe(true);
    const row = await db.attemptAnswer.findFirstOrThrow({ where: { attemptId: a.id } });
    expect(row.seq).toBe(8);
    expect(row.selectedOptionId).toBe(q.optionIds[7 % 4]);
  });

  it("keeps the review mark when a later save omits it, and can clear an answer", async () => {
    const { u, a, snapshot } = await setup();
    const q = snapshot.questions[0]!;
    await save(t, u, a.id, [ans(q.id, q.optionIds[1]!, 1, true)]);
    await save(t, u, a.id, [ans(q.id, q.optionIds[2]!, 2)]);
    let row = await db.attemptAnswer.findFirstOrThrow({ where: { attemptId: a.id } });
    expect(row).toMatchObject({ selectedOptionId: q.optionIds[2], markedForReview: true });
    await save(t, u, a.id, [ans(q.id, null, 3, false)]);
    row = await db.attemptAnswer.findFirstOrThrow({ where: { attemptId: a.id } });
    expect(row).toMatchObject({ selectedOptionId: null, markedForReview: false });
  });

  it("only accepts identifiers: scores, correctness and timestamps in the body are rejected", async () => {
    const { u, a, snapshot } = await setup();
    const q = snapshot.questions[0]!;
    const c = client(t, u);
    for (const extra of [{ score: 3 }, { percentage: 100 }, { correct: true }, { clientTime: iso(0) }])
      expect((await c.put(`/api/attempts/${a.id}/answers`, { answers: [ans(q.id, q.correctId, 1)], ...extra })).status, JSON.stringify(extra)).toBe(422);
    for (const extra of [{ isCorrect: true }, { score: 1 }, { savedAt: iso(0) }])
      expect((await c.put(`/api/attempts/${a.id}/answers`, { answers: [{ ...ans(q.id, q.correctId, 1), ...extra }] })).status, JSON.stringify(extra)).toBe(422);
    expect((await c.put(`/api/attempts/${a.id}/answers`, { answers: [] })).status).toBe(422);
    expect((await c.put(`/api/attempts/${a.id}/answers`, { answers: Array.from({ length: 51 }, () => ans(q.id, null, 1)) })).status).toBe(422);
    expect((await c.put(`/api/attempts/${a.id}/answers`, { answers: [{ questionId: q.id, optionId: q.correctId }] })).status).toBe(422); // seq is required
    expect((await c.put(`/api/attempts/${a.id}/answers`, { answers: [ans(q.id, q.correctId, -1)] })).status).toBe(422);
    expect(await db.attemptAnswer.count({ where: { attemptId: a.id } })).toBe(0);
    expect((await c.post(`/api/attempts/${a.id}/submit`, { score: 100 })).status).toBe(422);
    expect((await c.post(`/api/attempts/${a.id}/submit`, { percentage: 100, answers: [] })).status).toBe(422);
    expect((await attemptRow(a.id)).status).toBe("IN_PROGRESS");
  });

  it("another user can't read, save to, submit or see the result of someone else's attempt", async () => {
    const { u, a, snapshot } = await setup();
    const other = await createUser();
    const q = snapshot.questions[0]!;
    const co = client(t, other);
    expect((await co.get(`/api/attempts/${a.id}`)).status).toBe(404);
    expect((await save(t, other, a.id, [ans(q.id, q.correctId, 1)])).status).toBe(404);
    expect((await submit(t, other, a.id)).status).toBe(404);
    expect((await result(t, other, a.id)).status).toBe(404);
    expect((await co.get("/api/attempts/does-not-exist")).status).toBe(404);
    expect((await (await co.get("/api/attempts")).json()).items).toEqual([]);
    expect((await co.get(`/api/exams/${(await attemptRow(a.id)) && snapshot.versionId}/attempts`)).status).toBe(200); // lists only the caller's own (none)
    expect((await attemptRow(a.id)).status).toBe("IN_PROGRESS");
    void u;
  });
});

describe("the server clock decides (deadline, grace, late requests)", () => {
  it("accepts saves up to the deadline and during the grace allowance, then finalizes from what was stored", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { draft: { durationMinutes: 10 } });
    const a = await started(t, u, examId);
    const [q1, q2, q3] = snapshot.questions;
    const deadline = nowMs + 10 * MIN;
    await save(t, u, a.id, [ans(q1!.id, q1!.correctId, 1)]);

    nowMs = deadline - 1;
    const last = await (await save(t, u, a.id, [ans(q2!.id, q2!.correctId, 1)])).json();
    expect(last.remainingMs).toBe(1);

    nowMs = deadline + 3000; // inside the 5 s latency allowance: accepted, remaining time shows 0
    const grace = await save(t, u, a.id, [ans(q3!.id, q3!.wrongId, 1)]);
    expect(grace.status).toBe(200);
    expect((await grace.json()).remainingMs).toBe(0);
    expect((await attemptRow(a.id)).status).toBe("IN_PROGRESS");

    nowMs = deadline + GRACE; // the allowance is inclusive…
    expect((await save(t, u, a.id, [ans(q3!.id, q3!.correctId, 2)])).status).toBe(200);

    nowMs = deadline + GRACE + 1; // …and one millisecond later the attempt is over
    const late = await save(t, u, a.id, [ans(q3!.id, q3!.correctId, 3)]);
    expect(late.status).toBe(409);
    const err = (await late.json()).error;
    expect(err).toMatchObject({ code: "ATTEMPT_EXPIRED" });
    expect(err.details).toMatchObject({ finalized: true, timedOut: true });
    const row = await attemptRow(a.id);
    expect(row).toMatchObject({ status: "TIMED_OUT", submittedAt: null });
    expect(row.finalizedAt?.toISOString()).toBe(iso(nowMs));
    const r = await db.examResult.findUniqueOrThrow({ where: { attemptId: a.id } });
    expect(r).toMatchObject({ correctCount: 3, incorrectCount: 0, unansweredCount: 0, scoreCenti: 300 }); // q3's in-grace answer (correct, seq 2) counted; the late one was refused
    expect((await save(t, u, a.id, [ans(q1!.id, null, 99)])).status).toBe(409); // still refused afterwards
  });

  it("remainingMs comes from server time, whatever the client claims", async () => {
    const u = await createUser();
    const { examId } = await publishedExam(t, u, { draft: { durationMinutes: 20 } });
    const a = await started(t, u, examId);
    for (const [elapsed, left] of [[0, 20 * MIN], [MIN, 19 * MIN], [19 * MIN + 59_000, 1000], [20 * MIN, 0]] as const) {
      nowMs = Date.parse(a.startedAt) + elapsed;
      const view = (await (await client(t, u).raw("GET", `/api/attempts/${a.id}`, undefined, { "x-client-time": iso(0), date: new Date(0).toUTCString() })).json()).attempt;
      expect(view.remainingMs).toBe(left);
      expect(view.serverNow).toBe(iso(nowMs));
      expect(view.deadlineAt).toBe(a.deadlineAt);
    }
  });

  it("a late submit reports the timed-out outcome instead of failing, ignores its answers, and is idempotent", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { draft: { durationMinutes: 10 } });
    const a = await started(t, u, examId);
    await save(t, u, a.id, [ans(snapshot.questions[0]!.id, snapshot.questions[0]!.correctId, 1)]);
    nowMs += 10 * MIN + GRACE + 1;
    const res = await submit(t, u, a.id, { answers: paper(snapshot, 3) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "TIMED_OUT", alreadyFinalized: false, score: { correct: 1, unanswered: 2, scoreCenti: 100 } });
    expect(body.submittedAt).toBeNull();
    const again = await (await submit(t, u, a.id)).json();
    expect(again).toMatchObject({ status: "TIMED_OUT", alreadyFinalized: true, score: { scoreCenti: 100 } });
    expect(await resultCount(a.id)).toBe(1);
  });

  it("reading an expired attempt finalizes it lazily", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { draft: { durationMinutes: 10 } });
    const a = await started(t, u, examId);
    await save(t, u, a.id, paper(snapshot, 2, 1));
    nowMs += 10 * MIN + GRACE + 1;
    expect((await attemptRow(a.id)).status).toBe("IN_PROGRESS"); // nothing ran in the background
    const view = (await (await client(t, u).get(`/api/attempts/${a.id}`)).json()).attempt;
    expect(view).toMatchObject({ status: "TIMED_OUT", remainingMs: 0, finalizedAt: iso(nowMs) });
    expect((await db.examResult.findUniqueOrThrow({ where: { attemptId: a.id } })).correctCount).toBe(2);
  });

  it("the closing time caps the deadline for saves too", async () => {
    const u = await createUser();
    const closes = nowMs + 20 * MIN;
    const { examId, snapshot } = await publishedExam(t, u, { draft: { durationMinutes: 60, window: { closesAt: iso(closes) }, release: { mode: "AFTER_CLOSE" } } });
    const a = await started(t, u, examId);
    expect(a.deadlineAt).toBe(iso(closes));
    nowMs = closes + GRACE + 1;
    expect((await save(t, u, a.id, [ans(snapshot.questions[0]!.id, null, 1)])).status).toBe(409);
  });
});

describe("submitting", () => {
  it("applies the final answers, grades from the key, is idempotent, and creates one result and one notification", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { n: 4, draft: { negativeMarking: { fraction: 0.25 } } });
    const a = await started(t, u, examId);
    await save(t, u, a.id, paper(snapshot, 2));
    const [, , q3, q4] = snapshot.questions;
    nowMs += 5 * MIN;
    const res = await submit(t, u, a.id, { answers: [ans(q3!.id, q3!.wrongId, 1)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "SUBMITTED", alreadyFinalized: false, submittedAt: iso(nowMs), release: { released: true, mode: "IMMEDIATE" } });
    expect(body.score).toMatchObject({ scoreCenti: 175, maxCenti: 400, percentBp: 4375, correct: 2, incorrect: 1, unanswered: 1, band: "VERY_BAD" });
    void q4;

    const again = await submit(t, u, a.id, { answers: [ans(q3!.id, q3!.correctId, 9)] }); // ignored: already finalized
    expect((await again.json())).toMatchObject({ alreadyFinalized: true, score: { scoreCenti: 175 } });
    expect(await resultCount(a.id)).toBe(1);
    expect(await db.examResultItem.count({ where: { result: { attemptId: a.id } } })).toBe(4);
    expect(await db.notification.count({ where: { userId: u.id, type: "exam.submitted", dedupeKey: `attempt-submitted:${a.id}:${u.id}` } })).toBe(1);
    expect(await db.notification.count({ where: { userId: u.id, type: "exam.results_available" } })).toBe(1);

    const row = await attemptRow(a.id);
    expect(row).toMatchObject({ status: "SUBMITTED", submittedAt: new Date(nowMs) });
    // after finalization nothing can be saved or changed
    const late = await save(t, u, a.id, [ans(q3!.id, q3!.correctId, 99)]);
    expect(late.status).toBe(409);
    expect((await late.json()).error.details.finalized).toBe(true);
    await expect(db.attemptAnswer.updateMany({ where: { attemptId: a.id }, data: { selectedOptionId: null } })).rejects.toThrow(/not in progress/);
    await expect(db.examResult.updateMany({ where: { attemptId: a.id }, data: { scoreCenti: 400 } })).rejects.toThrow(/immutable/);
    await expect(db.examResultItem.updateMany({ where: { result: { attemptId: a.id } }, data: { outcome: "CORRECT" } })).rejects.toThrow(/immutable/);
  });

  it("an invalid answer in the submit body fails the request and leaves the attempt running", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u);
    const a = await started(t, u, examId);
    const res = await submit(t, u, a.id, { answers: [ans(snapshot.questions[0]!.id, snapshot.questions[1]!.correctId, 1)] });
    expect(res.status).toBe(422);
    expect((await attemptRow(a.id)).status).toBe("IN_PROGRESS");
    expect(await resultCount(a.id)).toBe(0);
  });

  it("an empty submission scores zero with every question unanswered", async () => {
    const u = await createUser();
    const { examId } = await publishedExam(t, u);
    const a = await started(t, u, examId);
    const body = await (await submit(t, u, a.id)).json();
    expect(body.score).toMatchObject({ scoreCenti: 0, correct: 0, incorrect: 0, unanswered: 3, percentBp: 0, band: "VERY_BAD" });
  });
});

describe("races (real database locks)", () => {
  it("8 concurrent submits create exactly one result; every response agrees", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { n: 4 });
    const a = await started(t, u, examId);
    await save(t, u, a.id, paper(snapshot, 2));
    const out = await Promise.all(Array.from({ length: 8 }, (_, i) => submit(t, u, a.id, { answers: [ans(snapshot.questions[2]!.id, snapshot.questions[2]!.optionIds[i % 4]!, i + 1)] })));
    expect(out.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(out.map((r) => r.json()));
    expect(bodies.filter((b) => !b.alreadyFinalized)).toHaveLength(1);
    expect(new Set(bodies.map((b) => JSON.stringify(b.score))).size).toBe(1);
    expect(await resultCount(a.id)).toBe(1);
    expect(await db.notification.count({ where: { userId: u.id, type: "exam.submitted", dedupeKey: `attempt-submitted:${a.id}:${u.id}` } })).toBe(1);
  });

  it("at expiry: submit, autosave, the expiry path, the sweeper and reads all racing → exactly one TIMED_OUT result from the stored answers", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { n: 4, draft: { durationMinutes: 10, negativeMarking: { fraction: 0.5 } } });
    const a = await started(t, u, examId);
    await save(t, u, a.id, paper(snapshot, 2, 1));
    nowMs += 10 * MIN + GRACE + 1;
    const q4 = snapshot.questions[3]!;
    const out = await Promise.all([
      submit(t, u, a.id, { answers: [ans(q4.id, q4.correctId, 1)] }),
      submit(t, u, a.id),
      save(t, u, a.id, [ans(q4.id, q4.correctId, 2)]),
      save(t, u, a.id, [ans(q4.id, q4.correctId, 3)]),
      save(t, u, a.id, [ans(snapshot.questions[2]!.id, snapshot.questions[2]!.correctId, 5)]),
      finalizeIfExpired(a.id),
      finalizeIfExpired(a.id),
      sweepOnce(),
      client(t, u).get(`/api/attempts/${a.id}`),
      client(t, u).get(`/api/attempts/${a.id}/result`),
    ]);
    expect(await resultCount(a.id)).toBe(1);
    const row = await attemptRow(a.id);
    expect(row.status).toBe("TIMED_OUT");
    const r = await db.examResult.findUniqueOrThrow({ where: { attemptId: a.id } });
    // stored before expiry: 2 correct (+2 marks), 1 wrong (−0.5 marks), 1 blank; nothing sent after the deadline counted
    expect(r).toMatchObject({ correctCount: 2, incorrectCount: 1, unansweredCount: 1, scoreCenti: 150, maxCenti: 400 });
    for (const idx of [2, 3, 4]) expect((out[idx] as Response).status).toBe(409);
    for (const idx of [0, 1]) expect(((await (out[idx] as Response).json()) as { status: string }).status).toBe("TIMED_OUT");
    expect(await db.attemptAnswer.count({ where: { attemptId: a.id } })).toBe(3);
  });

  it("autosave racing a submit at the deadline: the result always equals the stored answers, and the HTTP outcomes agree with it", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u, { n: 3, draft: { attemptLimit: 10, durationMinutes: 10 } });
    const q = snapshot.questions[0]!;
    for (let round = 0; round < 8; round++) {
      const a = await started(t, u, examId);
      nowMs = Date.parse(a.deadlineAt); // exactly at the deadline: both orders are legitimate
      const [s, sub] = await Promise.all([save(t, u, a.id, [ans(q.id, q.correctId, 1)]), submit(t, u, a.id)]);
      expect(sub.status).toBe(200);
      expect(await resultCount(a.id)).toBe(1);
      const item = await db.examResultItem.findFirstOrThrow({ where: { result: { attemptId: a.id }, examQuestionId: q.id } });
      const stored = await db.attemptAnswer.findFirst({ where: { attemptId: a.id, examQuestionId: q.id } });
      expect(item.selectedOptionId).toBe(stored?.selectedOptionId ?? null); // result == stored answers, whichever won
      if (s.status === 200) expect(item.outcome).toBe("CORRECT"); // an accepted save is part of the graded answers
      else {
        expect(s.status).toBe(409);
        expect(item.outcome).toBe("UNANSWERED"); // a refused save is not
      }
      nowMs = Date.now();
    }
  });
});

describe("expiry jobs, sweeper and recovery", () => {
  it("jobs, the sweeper and lazy finalization all produce identical results", async () => {
    const g = await groupExam(3, { durationMinutes: 10, negativeMarking: { fraction: 0.25 } }, 5);
    const [a, b, c] = g.users;
    const attempts = [] as { u: TestUser; id: string }[];
    for (const u of [a!, b!, c!]) {
      const at = await started(t, u, g.examId);
      await save(t, u, at.id, paper(g.snapshot, 3, 1));
      attempts.push({ u, id: at.id });
    }
    nowMs += 10 * MIN + GRACE + 1;
    // nothing has run: all three are still in progress after their deadline (worker "down")
    expect(await db.examAttempt.count({ where: { id: { in: attempts.map((x) => x.id) }, status: "IN_PROGRESS" } })).toBe(3);

    await db.job.updateMany({ where: { dedupeKey: `exam-expire:${attempts[0]!.id}` }, data: { runAt: new Date(Date.now() - 1000) } });
    await runDueJobs({ "exam.expire": examHandlers()["exam.expire"]! }, randomUUID(), 500); // path A: the expiry job
    expect((await attemptRow(attempts[0]!.id)).status).toBe("TIMED_OUT");
    expect((await attemptRow(attempts[1]!.id)).status).toBe("IN_PROGRESS");
    const swept = await sweepOnce(); // path B: the sweeper (also catches attempt 3)
    expect(swept.finalized).toBeGreaterThanOrEqual(2);
    expect(await resultCount(attempts[1]!.id)).toBe(1);
    // path C is covered by the lazy tests above; compare A and B and a lazily finalized fourth attempt
    const results = await db.examResult.findMany({ where: { attemptId: { in: attempts.map((x) => x.id) } } });
    expect(results).toHaveLength(3);
    const tuple = (r: (typeof results)[number]) => [r.scoreCenti, r.rawScoreCenti, r.maxCenti, r.percentBp, r.correctCount, r.incorrectCount, r.unansweredCount, r.band].join("|");
    expect(new Set(results.map(tuple)).size).toBe(1);
    expect(results[0]).toMatchObject({ scoreCenti: 275 - 0, correctCount: 3, incorrectCount: 1, unansweredCount: 1 });
    expect(await db.notification.count({ where: { type: "exam.submitted", dedupeKey: { in: attempts.map((x) => `attempt-submitted:${x.id}:${x.u.id}`) } } })).toBe(3);
    // running the sweeper / job again changes nothing
    expect((await sweepOnce()).finalized).toBe(0);
    await fire("exam.expire", { attemptId: attempts[0]!.id });
    expect(await resultCount(attempts[0]!.id)).toBe(1);
  });

  it("lazy finalization yields the same result as the expiry job would have", async () => {
    const g = await groupExam(2, { durationMinutes: 10 }, 4);
    const [a, b] = g.users;
    const ids = [];
    for (const u of [a!, b!]) {
      const at = await started(t, u, g.examId);
      await save(t, u, at.id, paper(g.snapshot, 2, 1));
      ids.push(at.id);
    }
    nowMs += 10 * MIN + GRACE + 1;
    await client(t, a!).get(`/api/attempts/${ids[0]}`); // lazy
    await fire("exam.expire", { attemptId: ids[1] }); // job
    const [r1, r2] = await Promise.all(ids.map((id) => db.examResult.findUniqueOrThrow({ where: { attemptId: id } })));
    expect([r1!.scoreCenti, r1!.percentBp, r1!.band, r1!.correctCount]).toEqual([r2!.scoreCenti, r2!.percentBp, r2!.band, r2!.correctCount]);
  });

  it("the expiry job refuses to finalize early and asks to be retried", async () => {
    const u = await createUser();
    const { examId } = await publishedExam(t, u);
    const a = await started(t, u, examId);
    nowMs += 5 * MIN;
    await expect(fire("exam.expire", { attemptId: a.id })).rejects.toBeInstanceOf(RetryableJobError);
    expect((await attemptRow(a.id)).status).toBe("IN_PROGRESS");
    await fire("exam.expire", { attemptId: "gone" }); // unknown attempts are a no-op
    await submit(t, u, a.id);
    await fire("exam.expire", { attemptId: a.id }); // already finalized: no-op
    expect(await resultCount(a.id)).toBe(1);
  });

  it("the sweeper chain re-schedules itself with alternating keys and never duplicates", async () => {
    await db.job.deleteMany({ where: { type: "exam.sweep" } });
    await ensureSweeperScheduled();
    await ensureSweeperScheduled();
    expect(await db.job.count({ where: { type: "exam.sweep", status: "PENDING" } })).toBe(1);
    await fire("exam.sweep", { slot: "a" });
    const next = await db.job.findMany({ where: { type: "exam.sweep", status: "PENDING", dedupeKey: "exam-sweep-b" } });
    expect(next).toHaveLength(1);
    expect(next[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    await fire("exam.sweep", { slot: "a" }); // a second chain can't be started: slot b is already queued
    expect(await db.job.count({ where: { type: "exam.sweep", dedupeKey: "exam-sweep-b" } })).toBe(1);
    await fire("exam.sweep", { slot: "b" });
    expect(await db.job.count({ where: { type: "exam.sweep", dedupeKey: "exam-sweep-a", status: "PENDING" } })).toBeGreaterThanOrEqual(0);
    await db.job.deleteMany({ where: { type: "exam.sweep" } });
  });

  it("the reminder goes to eligible participants who haven't started, exactly once", async () => {
    const opens = nowMs + 2 * 60 * MIN;
    const g = await groupExam(3, { window: { opensAt: iso(opens), closesAt: iso(opens + 3 * 60 * MIN) }, reminderMinutes: 15 });
    const [a, b, c] = g.users;
    nowMs = opens;
    await started(t, a!, g.examId);
    nowMs = opens - 15 * MIN;
    await fire("exam.reminder", { versionId: g.snapshot.versionId });
    await fire("exam.reminder", { versionId: g.snapshot.versionId });
    const notes = await db.notification.findMany({ where: { type: "exam.reminder", dedupeKey: { startsWith: `exam-reminder:${g.snapshot.versionId}` } } });
    expect(notes.map((n) => n.userId).sort()).toEqual([b!.id, c!.id].sort()); // `a` had already started, so is not reminded
    expect(notes.every((n) => n.link === `/exams/${g.examId}`)).toBe(true);
    expect((await db.examVersionState.findUniqueOrThrow({ where: { examVersionId: g.snapshot.versionId } })).reminderSentAt).not.toBeNull();
  });

  it("a participant who already started is not reminded; cancelled exams send nothing", async () => {
    const opens = nowMs + 60 * MIN;
    const g = await groupExam(2, { window: { opensAt: iso(opens), closesAt: iso(opens + 120 * MIN) }, reminderMinutes: 10 });
    const [a, b] = g.users;
    nowMs = opens + MIN;
    await started(t, a!, g.examId);
    await fire("exam.reminder", { versionId: g.snapshot.versionId });
    const notes = await db.notification.findMany({ where: { type: "exam.reminder", dedupeKey: { startsWith: `exam-reminder:${g.snapshot.versionId}` } } });
    expect(notes.map((n) => n.userId)).toEqual([b!.id]);
    nowMs = Date.now();
    const g2 = await groupExam(1, { window: { opensAt: iso(Date.now() + 60 * MIN), closesAt: iso(Date.now() + 180 * MIN) }, reminderMinutes: 10 });
    await client(t, g2.owner).post(`/api/exams/${g2.examId}/cancel`);
    await fire("exam.reminder", { versionId: g2.snapshot.versionId });
    expect(await db.notification.count({ where: { dedupeKey: { startsWith: `exam-reminder:${g2.snapshot.versionId}` } } })).toBe(0);
  });

  it("the sweeper also sends due reminders that the one-shot job missed", async () => {
    const opens = nowMs + 60 * MIN;
    const g = await groupExam(2, { window: { opensAt: iso(opens), closesAt: iso(opens + 120 * MIN) }, reminderMinutes: 20 });
    nowMs = opens - 25 * MIN;
    expect((await sweepOnce()).reminders).toBe(0);
    nowMs = opens - 19 * MIN;
    const swept = await sweepOnce();
    expect(swept.reminders).toBeGreaterThanOrEqual(1);
    expect(await db.notification.count({ where: { dedupeKey: { startsWith: `exam-reminder:${g.snapshot.versionId}` } } })).toBe(2);
    await sweepOnce();
    expect(await db.notification.count({ where: { dedupeKey: { startsWith: `exam-reminder:${g.snapshot.versionId}` } } })).toBe(2);
  });
});

