import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../../src/config/env.js";
import { db } from "../../src/lib/db.js";
import { setClock } from "../../src/lib/clock.js";
import { verifySnapshot } from "../../src/modules/exams/snapshot.js";
import { seedBankQuestions, seedGroup } from "../helpers/exam-fixtures.js";
import { draftBody, iso, publishedExam } from "../helpers/exam-api.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => setClock(null));

const newExam = async (u: Awaited<ReturnType<typeof createUser>>, body: Record<string, unknown> = {}) => {
  const res = await client(t, u).post("/api/exams", { title: "Draft exam", mode: "INDIVIDUAL", ...body });
  return { res, id: ((await res.clone().json()).exam?.id ?? "") as string };
};
const HOUR = 3_600_000;

describe("limits and authentication", () => {
  it("exposes env-derived limits to signed-in users only", async () => {
    const u = await createUser();
    const res = await (await client(t, u).get("/api/exams/limits")).json();
    expect(res.limits).toMatchObject({ examMaxQuestions: 200, examMaxDurationMinutes: 360, examMaxAttemptLimit: 10, examGraceSeconds: 5, groupMaxCapacity: 500 });
    expect(res.fields.title).toBe(120);
    expect((await client(t).get("/api/exams/limits")).status).toBe(401);
  });
  it("every exam/attempt endpoint requires a session", async () => {
    const c = client(t);
    for (const [m, p] of [["GET", "/api/exams"], ["POST", "/api/exams"], ["GET", "/api/exams/x"], ["PUT", "/api/exams/x/draft"], ["GET", "/api/exams/x/preview"], ["POST", "/api/exams/x/publish"],
      ["POST", "/api/exams/x/cancel"], ["POST", "/api/exams/x/duplicate"], ["DELETE", "/api/exams/x"], ["POST", "/api/exams/x/attempts"], ["GET", "/api/exams/x/attempts"], ["GET", "/api/attempts"],
      ["GET", "/api/attempts/x"], ["PUT", "/api/attempts/x/answers"], ["POST", "/api/attempts/x/submit"], ["GET", "/api/attempts/x/result"]] as const)
      expect((await c.raw(m, p, m === "GET" || m === "DELETE" ? undefined : {})).status, `${m} ${p}`).toBe(401);
  });
});

describe("creating and saving drafts", () => {
  it("creates an individual draft with defaults", async () => {
    const u = await createUser();
    const { res } = await newExam(u);
    expect(res.status).toBe(201);
    const exam = (await res.json()).exam;
    expect(exam).toMatchObject({ title: "Draft exam", mode: "INDIVIDUAL", status: "DRAFT", group: null, questionCount: 0, totalMarks: null, durationMinutes: 30 });
    const full = (await (await client(t, u).get(`/api/exams/${exam.id}`)).json()).exam;
    expect(full.role).toBe("AUTHOR");
    expect(full.draft).toMatchObject({ durationMinutes: 30, attemptLimit: 1, shuffleQuestions: false, reviewPolicy: "FULL", release: { mode: "IMMEDIATE" }, marks: { perQuestion: 1 }, negativeMarking: { fraction: 0 } });
  });

  it("group exams need a group where the creator is OWNER/ADMIN (404 for strangers, 403 for plain members)", async () => {
    const [owner, admin, member, stranger] = [await createUser(), await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { members: [{ user: admin, role: "ADMIN" }, { user: member }] });
    expect((await newExam(owner, { mode: "GROUP", groupId: group.id })).res.status).toBe(201);
    expect((await newExam(admin, { mode: "GROUP", groupId: group.id })).res.status).toBe(201);
    const m = await newExam(member, { mode: "GROUP", groupId: group.id });
    expect(m.res.status).toBe(403);
    expect((await m.res.json()).error.code).toBe("NOT_ELIGIBLE");
    expect((await newExam(stranger, { mode: "GROUP", groupId: group.id })).res.status).toBe(404);
    expect((await newExam(owner, { mode: "GROUP" })).res.status).toBe(422);
    expect((await newExam(owner, { mode: "INDIVIDUAL", groupId: group.id })).res.status).toBe(422);
    expect((await newExam(owner, { mode: "SOLO" })).res.status).toBe(422);
    expect((await newExam(owner, { title: "   " })).res.status).toBe(422);
  });

  it("limits the number of exams per author", async () => {
    const u = await createUser();
    process.env.EXAM_MAX_DRAFTS_PER_USER = "2";
    resetEnvCache();
    try {
      await newExam(u);
      await newExam(u);
      const third = await newExam(u);
      expect(third.res.status).toBe(429);
      expect((await third.res.json()).error.code).toBe("QUOTA_EXCEEDED");
    } finally {
      delete process.env.EXAM_MAX_DRAFTS_PER_USER;
      resetEnvCache();
    }
  });

  it("saves a valid draft (including an incomplete one) and reports totals", async () => {
    const u = await createUser();
    const bank = await seedBankQuestions(u, 3);
    const { id } = await newExam(u);
    const c = client(t, u);
    const empty = await c.put(`/api/exams/${id}/draft`, draftBody([]));
    expect(empty.status).toBe(200); // drafts may be incomplete
    const res = await c.put(`/api/exams/${id}/draft`, draftBody(bank.map((b) => b.id), { marks: { perQuestion: 2, overrides: { [bank[0]!.id]: 5 } }, title: "Renamed" }));
    const exam = (await res.json()).exam;
    expect(exam).toMatchObject({ title: "Renamed", questionCount: 3, totalMarks: 9, status: "DRAFT" });
    expect(exam.questions).toHaveLength(3);
    expect(exam.questions[0].marks).toBe(5);
    expect(exam.questions[0].correctOptionId).toBe(bank[0]!.correctId); // the author sees their own keys
  });

  it("validates ranges and shapes on the server and names the field", async () => {
    const u = await createUser();
    const bank = await seedBankQuestions(u, 2);
    const ids = bank.map((b) => b.id);
    const { id } = await newExam(u);
    const c = client(t, u);
    const bad = async (over: Record<string, unknown>, path: string) => {
      const res = await c.put(`/api/exams/${id}/draft`, draftBody(ids, over));
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect((await res.json()).error.details.fields, JSON.stringify(over)).toHaveProperty(path);
    };
    await bad({ durationMinutes: 361 }, "durationMinutes");
    await bad({ durationMinutes: 0 }, "durationMinutes");
    await bad({ durationMinutes: 1.5 }, "durationMinutes");
    await bad({ attemptLimit: 11 }, "attemptLimit");
    await bad({ attemptLimit: 0 }, "attemptLimit");
    await bad({ marks: { perQuestion: 0.1 } }, "marks.perQuestion");
    await bad({ marks: { perQuestion: 101 } }, "marks.perQuestion");
    await bad({ marks: { perQuestion: 1, overrides: { [ids[0]!]: -1 } } }, `marks.overrides.${ids[0]}`);
    await bad({ marks: { perQuestion: 1, overrides: { "not-selected": 2 } } }, "marks.overrides.not-selected");
    await bad({ negativeMarking: { fraction: 1.5 } }, "negativeMarking.fraction");
    await bad({ negativeMarking: { fraction: -0.1 } }, "negativeMarking.fraction");
    await bad({ negativeMarking: { fraction: 0.123456 } }, "negativeMarking.fraction");
    await bad({ questionIds: [ids[0], ids[0]] }, "questionIds");
    await bad({ window: { opensAt: iso(Date.now() + 2 * HOUR), closesAt: iso(Date.now() + HOUR) } }, "window.closesAt");
    await bad({ window: { opensAt: "tomorrow" } }, "window.opensAt");
    await bad({ reviewPolicy: "EVERYTHING" }, "reviewPolicy");
    await bad({ release: { mode: "NEVER" } }, "release.mode");
    await bad({ release: { mode: "IMMEDIATE", at: iso(Date.now() + HOUR) } }, "release.at");
    await bad({ lateStart: "ANYTIME" }, "lateStart");
    await bad({ title: "" }, "title");
    await bad({ title: "x".repeat(121) }, "title");
    await bad({ description: "x".repeat(1001) }, "description");
    await bad({ reminderMinutes: 0 }, "reminderMinutes");
    await bad({ score: 100 }, "_");
    await bad({ totalMarks: 100 }, "_");
    const tooMany = await c.put(`/api/exams/${id}/draft`, draftBody(Array.from({ length: 201 }, (_, i) => `q${i}`)));
    expect(tooMany.status).toBe(422);
  });

  it("only the author's own multiple-choice questions can be selected, and foreign ids reveal nothing", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const mine = await seedBankQuestions(u, 1);
    const theirs = await seedBankQuestions(other, 1);
    const cq = await db.question.create({ data: { ownerId: u.id, kind: "CQ", language: "en", stem: "A CQ", difficulty: "EASY", origin: "USER_AUTHORED", sourceSupport: "NONE", contentHash: "cq-x", marks: 5 } });
    const { id } = await newExam(u);
    const c = client(t, u);
    const res = await c.put(`/api/exams/${id}/draft`, draftBody([mine[0]!.id, theirs[0]!.id, cq.id, "does-not-exist"]));
    expect(res.status).toBe(422);
    const fields = (await res.json()).error.details.fields;
    expect(fields["questionIds.0"]).toBeUndefined();
    expect(fields["questionIds.1"]).toBe(fields["questionIds.3"]); // a foreign question looks exactly like a missing one
    expect(fields["questionIds.2"]).toMatch(/multiple-choice/);
  });

  it("another user can't read or edit the draft, and a published exam can't be edited", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const bank = await seedBankQuestions(u, 1);
    const { id } = await newExam(u);
    const co = client(t, other);
    expect((await co.get(`/api/exams/${id}`)).status).toBe(404);
    expect((await co.put(`/api/exams/${id}/draft`, draftBody([]))).status).toBe(404);
    expect((await co.get(`/api/exams/${id}/preview`)).status).toBe(404);
    expect((await co.post(`/api/exams/${id}/publish`)).status).toBe(404);
    expect((await co.delete(`/api/exams/${id}`)).status).toBe(404);
    expect((await co.post(`/api/exams/${id}/duplicate`)).status).toBe(404);
    expect((await co.post(`/api/exams/${id}/cancel`)).status).toBe(404);
    expect((await co.post(`/api/exams/${id}/attempts`)).status).toBe(404);
    const c = client(t, u);
    await c.put(`/api/exams/${id}/draft`, draftBody([bank[0]!.id]));
    expect((await c.post(`/api/exams/${id}/publish`)).status).toBe(200);
    const edit = await c.put(`/api/exams/${id}/draft`, draftBody([bank[0]!.id], { title: "Changed" }));
    expect(edit.status).toBe(409);
  });
});

describe("preview", () => {
  it("reports issues, totals and the author's key view", async () => {
    const u = await createUser();
    const bank = await seedBankQuestions(u, 2);
    const { id } = await newExam(u);
    const c = client(t, u);
    const empty = (await (await c.get(`/api/exams/${id}/preview`)).json()).preview;
    expect(empty.canPublish).toBe(false);
    expect(empty.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "questionIds", severity: "error" })]));
    await c.put(`/api/exams/${id}/draft`, draftBody(bank.map((b) => b.id), { marks: { perQuestion: 2 }, negativeMarking: { fraction: 0.25 } }));
    const p = (await (await c.get(`/api/exams/${id}/preview`)).json()).preview;
    expect(p.canPublish).toBe(true);
    expect(p.totals).toEqual({ questionCount: 2, totalMarks: 4, negativePerWrongRange: { min: 0.5, max: 0.5 } });
    expect(p.questions[0]).toMatchObject({ position: 1, marks: 2, negativeMarks: 0.5, correctOptionId: bank[0]!.correctId });
  });

  it("warns about group exams that reveal answers immediately and windows shorter than the duration", async () => {
    const owner = await createUser();
    const group = await seedGroup(owner);
    const bank = await seedBankQuestions(owner, 1);
    const { id } = await newExam(owner, { mode: "GROUP", groupId: group.id });
    const c = client(t, owner);
    await c.put(`/api/exams/${id}/draft`, draftBody([bank[0]!.id], { durationMinutes: 60, window: { opensAt: iso(Date.now() + HOUR), closesAt: iso(Date.now() + 1.5 * HOUR) }, attemptLimit: 2 }));
    const p = (await (await c.get(`/api/exams/${id}/preview`)).json()).preview;
    const warnings = p.issues.filter((i: { severity: string }) => i.severity === "warning").map((i: { path: string }) => i.path);
    expect(warnings).toEqual(expect.arrayContaining(["reviewPolicy", "window", "attemptLimit"]));
    expect(p.canPublish).toBe(true);
  });

  it("flags a question whose answer key is broken (read from the stored rows)", async () => {
    const u = await createUser();
    const bank = await seedBankQuestions(u, 2);
    await db.questionOption.updateMany({ where: { questionId: bank[1]!.id }, data: { isCorrect: false } }); // no correct option at all
    const { id } = await newExam(u);
    const c = client(t, u);
    await c.put(`/api/exams/${id}/draft`, draftBody(bank.map((b) => b.id)));
    const p = (await (await c.get(`/api/exams/${id}/preview`)).json()).preview;
    expect(p.canPublish).toBe(false);
    expect(p.issues.find((i: { path: string }) => i.path === "questionIds.1").message).toMatch(/exactly one correct/);
  });
});

describe("publishing", () => {
  const draftFor = async (u: Awaited<ReturnType<typeof createUser>>, over: Record<string, unknown> = {}, n = 2) => {
    const bank = await seedBankQuestions(u, n);
    const { id } = await newExam(u);
    const c = client(t, u);
    const res = await c.put(`/api/exams/${id}/draft`, draftBody(bank.map((b) => b.id), over));
    expect(res.status).toBe(200);
    return { id, bank, c };
  };
  const fieldsOf = async (res: Response) => (await res.json()).error.details.fields as Record<string, string>;

  it("creates an immutable versioned snapshot with marks, negative marking and the key from the stored rows", async () => {
    const u = await createUser();
    const { examId, bank, snapshot } = await publishedExam(t, u, { n: 3, draft: { marks: { perQuestion: 2, overrides: { } }, negativeMarking: { fraction: 0.25 }, durationMinutes: 45, attemptLimit: 3, shuffleQuestions: true, reviewPolicy: "CORRECTNESS" } });
    const exam = await db.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam).toMatchObject({ status: "PUBLISHED", currentVersion: 1 });
    const v = await db.examVersion.findFirstOrThrow({ where: { examId } });
    expect(v).toMatchObject({ version: 1, durationSeconds: 2700, attemptLimit: 3, questionCount: 3, totalCenti: 600, negativeMarkingBp: 2500, shuffleQuestions: true, reviewPolicy: "CORRECTNESS", releaseMode: "IMMEDIATE", mode: "INDIVIDUAL", publishedById: u.id });
    expect(v.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.questions).toHaveLength(3);
    const rows = await db.examQuestionSnapshot.findMany({ where: { examVersionId: v.id }, orderBy: { position: "asc" }, include: { options: true } });
    expect(rows.map((r) => r.sourceQuestionId)).toEqual(bank.map((b) => b.id));
    expect(rows.every((r) => r.marksCenti === 200 && r.negativeCenti === 50)).toBe(true);
    expect(rows[0]!.options.filter((o) => o.isCorrect).map((o) => o.text)).toEqual(["Option 0 of 1"]);
    expect(await verifySnapshot(v.id)).toBe("OK");
    const manage = (await (await client(t, u).get(`/api/exams/${examId}`)).json()).exam;
    expect(manage).toMatchObject({ status: "PUBLISHED", snapshotIntegrity: "OK", attemptsCount: 0 });
    expect(manage.version).toMatchObject({ totalMarks: 6, negativeMarkingFraction: 0.25, questionCount: 3 });
    expect(await db.examVersionState.count({ where: { examVersionId: v.id } })).toBe(1);
  });

  it("publishing twice is a conflict and creates no second version", async () => {
    const u = await createUser();
    const { id, c } = await draftFor(u);
    expect((await c.post(`/api/exams/${id}/publish`)).status).toBe(200);
    const again = await c.post(`/api/exams/${id}/publish`);
    expect(again.status).toBe(409);
    expect(await db.examVersion.count({ where: { examId: id } })).toBe(1);
  });

  it("concurrent publish requests produce exactly one version", async () => {
    const u = await createUser();
    const { id, c } = await draftFor(u);
    const results = await Promise.all(Array.from({ length: 5 }, () => c.post(`/api/exams/${id}/publish`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await db.examVersion.count({ where: { examId: id } })).toBe(1);
    expect(await db.examQuestionSnapshot.count({ where: { examVersion: { examId: id } } })).toBe(2);
  });

  it("rejects an empty exam, invalid keys, windows in the past and impossible time windows", async () => {
    const u = await createUser();
    const c = client(t, u);
    const { id: emptyId } = await newExam(u);
    expect((await fieldsOf(await c.post(`/api/exams/${emptyId}/publish`))).questionIds).toMatch(/at least one/);

    const broken = await draftFor(u);
    await db.questionOption.updateMany({ where: { questionId: broken.bank[0]!.id }, data: { isCorrect: false } });
    expect((await fieldsOf(await broken.c.post(`/api/exams/${broken.id}/publish`)))["questionIds.0"]).toMatch(/exactly one correct/);
    expect(await db.examVersion.count({ where: { examId: broken.id } })).toBe(0); // nothing was written

    const past = await draftFor(u, { window: { closesAt: iso(Date.now() - 1000) } });
    expect(await fieldsOf(await past.c.post(`/api/exams/${past.id}/publish`))).toHaveProperty("window.closesAt");

    const short = await draftFor(u, { durationMinutes: 60, lateStart: "FULL_TIME_ONLY", window: { closesAt: iso(Date.now() + 30 * 60_000) } });
    expect((await fieldsOf(await short.c.post(`/api/exams/${short.id}/publish`)))["window.closesAt"]).toMatch(/nobody could start/);

    const after = await draftFor(u, { release: { mode: "AFTER_CLOSE" } });
    expect(await fieldsOf(await after.c.post(`/api/exams/${after.id}/publish`))).toHaveProperty("release.mode");

    const early = await draftFor(u, { window: { closesAt: iso(Date.now() + 5 * HOUR) }, release: { mode: "AT_TIME", at: iso(Date.now() + HOUR) } });
    expect((await fieldsOf(await early.c.post(`/api/exams/${early.id}/publish`)))["release.at"]).toMatch(/before the exam closes/);

    const noTime = await draftFor(u, { release: { mode: "AT_TIME" } });
    expect(await fieldsOf(await noTime.c.post(`/api/exams/${noTime.id}/publish`))).toHaveProperty("release.at");

    const reminder = await draftFor(u, { reminderMinutes: 10 });
    expect(await fieldsOf(await reminder.c.post(`/api/exams/${reminder.id}/publish`))).toHaveProperty("reminderMinutes");
  });

  it("a question deleted or edited after the draft was saved is caught at publication", async () => {
    const u = await createUser();
    const { id, bank, c } = await draftFor(u);
    await db.question.delete({ where: { id: bank[1]!.id } });
    expect((await fieldsOf(await c.post(`/api/exams/${id}/publish`)))["questionIds.1"]).toMatch(/wasn't found/);
  });

  it("group exams: only OWNER/ADMIN of the group publish; plain members can't (even if they somehow own the draft)", async () => {
    const [owner, admin, member] = [await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { members: [{ user: admin, role: "ADMIN" }, { user: member }] });
    const a = await publishedExam(t, admin, { mode: "GROUP", groupId: group.id });
    expect(a.exam.status).toBe("PUBLISHED");
    // an owner who was demoted/removed after drafting can no longer publish
    const bank = await seedBankQuestions(admin, 1);
    const { id } = await newExam(admin, { mode: "GROUP", groupId: group.id });
    await client(t, admin).put(`/api/exams/${id}/draft`, draftBody([bank[0]!.id]));
    await db.groupMember.update({ where: { groupId_userId: { groupId: group.id, userId: admin.id } }, data: { role: "MEMBER" } });
    expect((await client(t, admin).post(`/api/exams/${id}/publish`)).status).toBe(403);
    await db.groupMember.delete({ where: { groupId_userId: { groupId: group.id, userId: admin.id } } });
    expect((await client(t, admin).post(`/api/exams/${id}/publish`)).status).toBe(404);
  });

  it("notifies group members (not the author) exactly once and normalises individual-only settings", async () => {
    const [owner, m1, m2] = [await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { members: [{ user: m1 }, { user: m2 }] });
    const { examId } = await publishedExam(t, owner, { mode: "GROUP", groupId: group.id, title: "Group quiz" });
    const notes = await db.notification.findMany({ where: { type: "exam.group_published", link: `/exams/${examId}` } });
    expect(notes.map((n) => n.userId).sort()).toEqual([m1.id, m2.id].sort());
    expect(notes[0]).toMatchObject({ link: `/exams/${examId}`, title: "New group exam" });
    expect(notes[0]!.body).toContain("Group quiz");
    const v = await db.examVersion.findFirstOrThrow({ where: { examId } });
    expect(await db.examVersionState.findUniqueOrThrow({ where: { examVersionId: v.id } })).toMatchObject({ publishNotifiedAt: expect.any(Date) });

    const solo = await publishedExam(t, owner, { draft: { leaderboardVisible: true, lateJoinGroup: true } });
    expect(await db.examVersion.findFirstOrThrow({ where: { examId: solo.examId } })).toMatchObject({ leaderboardVisible: false, lateJoinGroup: false });
  });

  it("schedules the reminder and release jobs", async () => {
    const u = await createUser();
    const opens = Date.now() + 3 * HOUR;
    const closes = opens + 2 * HOUR;
    const { examId } = await publishedExam(t, u, { draft: { window: { opensAt: iso(opens), closesAt: iso(closes) }, reminderMinutes: 30, release: { mode: "AFTER_CLOSE" } } });
    const v = await db.examVersion.findFirstOrThrow({ where: { examId } });
    const jobs = await db.job.findMany({ where: { type: { in: ["exam.reminder", "exam.release"] }, payload: { path: ["versionId"], equals: v.id } } });
    const byType = Object.fromEntries(jobs.map((j) => [j.type, j]));
    expect(byType["exam.reminder"]!.runAt.getTime()).toBe(opens - 30 * 60_000);
    expect(byType["exam.release"]!.runAt.getTime()).toBe(closes + 5000);
    expect(byType["exam.reminder"]!.dedupeKey).toBe(`exam-reminder:${v.id}`);
  });
});

describe("snapshot immutability", () => {
  it("rejects direct SQL updates of versions, snapshot questions/options and results", async () => {
    const u = await createUser();
    const { examId, snapshot } = await publishedExam(t, u);
    const q = snapshot.questions[0]!;
    await expect(db.$executeRaw`UPDATE "ExamVersion" SET "durationSeconds" = 99999 WHERE "examId" = ${examId}`).rejects.toThrow(/immutable/);
    await expect(db.$executeRaw`UPDATE "ExamQuestionSnapshot" SET "stem" = 'hacked' WHERE "id" = ${q.id}`).rejects.toThrow(/immutable/);
    await expect(db.$executeRaw`UPDATE "ExamOptionSnapshot" SET "isCorrect" = NOT "isCorrect" WHERE "questionId" = ${q.id}`).rejects.toThrow(/immutable/);
    await expect(db.examVersion.update({ where: { id: snapshot.versionId }, data: { attemptLimit: 50 } })).rejects.toThrow();
    // a second correct option is impossible too
    await expect(db.$executeRaw`INSERT INTO "ExamOptionSnapshot" ("id","questionId","position","text","isCorrect") VALUES ('dup', ${q.id}, 9, 'x', true)`).rejects.toThrow();
    expect(await verifySnapshot(snapshot.versionId)).toBe("OK");
  });

  it("editing or deleting the bank question afterwards never changes the published exam", async () => {
    const u = await createUser();
    const { examId, bank, snapshot } = await publishedExam(t, u, { n: 2 });
    const before = await db.examQuestionSnapshot.findMany({ where: { examVersionId: snapshot.versionId }, orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } });
    // edit via the real Part 3 API: change the stem and the correct answer
    const c = client(t, u);
    const detail = (await (await c.get(`/api/questions/${bank[0]!.id}`)).json()).question;
    const edited = await c.patch(`/api/questions/${bank[0]!.id}`, {
      question: { kind: "MCQ", language: "en", stem: "Completely different stem", difficulty: "HARD", options: detail.options.map((o: { id: string; text: string }) => ({ id: o.id, text: o.text })), correctOptionId: detail.options[1].id },
    });
    expect(edited.status).toBe(200);
    await c.delete(`/api/questions/${bank[1]!.id}`);
    const after = await db.examQuestionSnapshot.findMany({ where: { examVersionId: snapshot.versionId }, orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } });
    expect(after).toEqual(before);
    expect(after[0]!.stem).not.toBe("Completely different stem");
    expect(after[0]!.options.find((o) => o.isCorrect)!.position).toBe(0);
    expect(await verifySnapshot(snapshot.versionId)).toBe("OK");
    const manage = (await (await c.get(`/api/exams/${examId}`)).json()).exam;
    expect(manage.questions).toHaveLength(2);
    expect(manage.snapshotIntegrity).toBe("OK");
  });

  it("detects tampering: if a snapshot row is altered behind the trigger's back the integrity check reports MISMATCH", async () => {
    const u = await createUser();
    const { snapshot } = await publishedExam(t, u);
    try {
      await db.$executeRaw`ALTER TABLE "ExamQuestionSnapshot" DISABLE TRIGGER "ExamQuestionSnapshot_immutable"`;
      await db.$executeRaw`UPDATE "ExamQuestionSnapshot" SET "stem" = 'tampered' WHERE "id" = ${snapshot.questions[0]!.id}`;
      expect(await verifySnapshot(snapshot.versionId)).toBe("MISMATCH");
      const manage = (await (await client(t, u).get(`/api/exams/${(await db.examVersion.findUniqueOrThrow({ where: { id: snapshot.versionId } })).examId}`)).json()).exam;
      expect(manage.snapshotIntegrity).toBe("MISMATCH");
    } finally {
      await db.$executeRaw`ALTER TABLE "ExamQuestionSnapshot" ENABLE TRIGGER "ExamQuestionSnapshot_immutable"`;
    }
  });
});

describe("cancel, duplicate, delete", () => {
  it("cancelling stops new attempts; duplicating copies the configuration into a fresh draft; deleting needs no attempts", async () => {
    const u = await createUser();
    const { examId, bank } = await publishedExam(t, u, { n: 2, draft: { durationMinutes: 20, negativeMarking: { fraction: 0.5 }, window: { closesAt: iso(Date.now() + HOUR) }, release: { mode: "AFTER_CLOSE" } } });
    const c = client(t, u);
    expect((await c.post(`/api/exams/${examId}/attempts`)).status).toBe(201);

    const dup = (await (await c.post(`/api/exams/${examId}/duplicate`)).json()).exam;
    expect(dup).toMatchObject({ status: "DRAFT", title: "Midterm exam (copy)", questionCount: 2 });
    const dupFull = (await (await c.get(`/api/exams/${dup.id}`)).json()).exam;
    expect(dupFull.draft).toMatchObject({ durationMinutes: 20, negativeMarking: { fraction: 0.5 }, window: { opensAt: null, closesAt: null }, questionIds: bank.map((b) => b.id) });

    expect((await c.delete(`/api/exams/${examId}`)).status).toBe(409); // has an attempt
    const cancelled = (await (await c.post(`/api/exams/${examId}/cancel`)).json()).exam;
    expect(cancelled.status).toBe("CANCELLED");
    expect((await c.post(`/api/exams/${examId}/cancel`)).status).toBe(200); // idempotent
    const again = await c.post(`/api/exams/${examId}/attempts`);
    expect(again.status).toBe(200); // the running attempt can still be resumed…
    await db.examAttempt.deleteMany({ where: { examVersion: { examId } } });
    const denied = await c.post(`/api/exams/${examId}/attempts`);
    expect(denied.status).toBe(409); // …but no new one can be started
    expect((await denied.json()).error.code).toBe("EXAM_CLOSED");
    expect((await c.delete(`/api/exams/${examId}`)).status).toBe(200);
    expect((await c.delete(`/api/exams/${dup.id}`)).status).toBe(200);
    expect((await c.post(`/api/exams/${dup.id}/cancel`)).status).toBe(404);
  });
  it("a draft can't be cancelled (delete it instead)", async () => {
    const u = await createUser();
    const { id } = await newExam(u);
    expect((await client(t, u).post(`/api/exams/${id}/cancel`)).status).toBe(409);
  });
});

describe("listing and visibility", () => {
  it("mine / available / history scopes", async () => {
    const [owner, member, outsider] = [await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { members: [{ user: member }] });
    const own = await publishedExam(t, owner, { title: "Own solo" });
    const draft = await newExam(owner, { title: "Just a draft" });
    const shared = await publishedExam(t, owner, { mode: "GROUP", groupId: group.id, title: "Shared quiz" });
    const closed = await publishedExam(t, owner, { mode: "GROUP", groupId: group.id, title: "Closed quiz", draft: { window: { closesAt: iso(Date.now() + 5000) } } });
    const list = async (u: typeof owner, qs: string) => (await (await client(t, u).get(`/api/exams${qs}`)).json()) as { items: { id: string; title: string; status: string; myAttempts?: { used: number; limit: number } }[]; total: number };

    expect((await list(owner, "")).items.map((i) => i.title).sort()).toEqual(["Closed quiz", "Just a draft", "Own solo", "Shared quiz"]);
    expect((await list(owner, "?status=DRAFT")).items.map((i) => i.id)).toEqual([draft.id]);
    expect((await list(owner, "?scope=available")).items.map((i) => i.title).sort()).toEqual(["Closed quiz", "Own solo", "Shared quiz"].filter((x) => x !== "Shared quiz" && x !== "Closed quiz")); // authors don't take their own group exams
    expect((await list(member, "?scope=available")).items.map((i) => i.title).sort()).toEqual(["Closed quiz", "Shared quiz"]);
    expect((await list(outsider, "?scope=available")).total).toBe(0);
    expect((await list(member, "")).total).toBe(0); // "mine" = authored

    setClock(() => new Date(Date.now() + 10_000)); // the window of "Closed quiz" has passed
    expect((await list(member, "?scope=available")).items.map((i) => i.title)).toEqual(["Shared quiz"]);
    setClock(null);

    expect((await list(owner, "?scope=history")).total).toBe(0);
    await client(t, owner).post(`/api/exams/${own.examId}/attempts`);
    await client(t, member).post(`/api/exams/${shared.examId}/attempts`);
    const hist = await list(member, "?scope=history");
    expect(hist.items.map((i) => i.title)).toEqual(["Shared quiz"]);
    expect(hist.items[0]!.myAttempts).toMatchObject({ used: 1, limit: 1 });
    expect((await list(owner, "?scope=history")).items.map((i) => i.title)).toEqual(["Own solo"]);
    void closed;
    expect((await client(t, owner).get("/api/exams?scope=everything")).status).toBe(422);
    expect((await client(t, owner).get("/api/exams?pageSize=51")).status).toBe(422);
  });

  it("members see a take view with no questions or key; draft group exams are invisible to members; strangers get 404", async () => {
    const [owner, member, stranger] = [await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { members: [{ user: member }] });
    const draft = await newExam(owner, { mode: "GROUP", groupId: group.id });
    expect((await client(t, member).get(`/api/exams/${draft.id}`)).status).toBe(404);
    const { examId, snapshot } = await publishedExam(t, owner, { mode: "GROUP", groupId: group.id, draft: { negativeMarking: { fraction: 0.25 }, reviewPolicy: "FULL" } });
    const res = await client(t, member).get(`/api/exams/${examId}`);
    const body = await res.text();
    const exam = JSON.parse(body).exam;
    expect(exam).toMatchObject({ role: "PARTICIPANT", questionCount: 3, totalMarks: 3, durationMinutes: 30, negativeMarking: true, attemptLimit: 1, canStart: { allowed: true } });
    expect(exam.policies).toMatchObject({ reviewPolicy: "FULL", release: { mode: "IMMEDIATE" } });
    expect(exam).not.toHaveProperty("questions");
    expect(exam).not.toHaveProperty("draft");
    for (const q of snapshot.questions) {
      expect(body).not.toContain(q.id);
      expect(body).not.toContain(q.correctId);
    }
    expect(body).not.toMatch(/"(correctOptionId|isCorrect|explanation|shortNote|snapshotHash)"/);
    expect(body).not.toMatch(/Explanation \d|Note \d/);
    expect((await client(t, stranger).get(`/api/exams/${examId}`)).status).toBe(404);
  });
});
