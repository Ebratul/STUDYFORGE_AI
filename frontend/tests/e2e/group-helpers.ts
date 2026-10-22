import { randomInt, randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { expect, PASSWORD, register, sql, uniqueEmail } from "./fixtures";

/** Authenticated same-origin API call (the browser context already carries the session cookie). */
export async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.request.fetch(path, {
    method,
    headers: { origin: "http://localhost:3100", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A signed-in user in their own browser context (own cookies and client IP, so per-IP rate limits don't leak between users). */
export async function newUser(browser: Browser, name = "Ayesha Rahman") {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `198.51.${randomInt(1, 250)}.${randomInt(1, 250)}` } });
  const page = await ctx.newPage();
  const email = uniqueEmail("grp");
  await register(page, { name, email });
  const [row] = await sql<{ id: string }>('SELECT id FROM "User" WHERE email = $1', [email]);
  return { page, ctx, email, name, id: row!.id };
}
export type TestUser = Awaited<ReturnType<typeof newUser>>;

export async function createGroup(page: Page, body: { title: string; description?: string; capacity?: number }) {
  const res = await api(page, "POST", "/api/groups", body);
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()).group as { id: string }).id;
}

/** Creates an invitation through the API and returns the one-time code. */
export async function createInvite(page: Page, groupId: string, body: Record<string, unknown> = { expiresInHours: 24, maxUses: 10 }) {
  const res = await api(page, "POST", `/api/groups/${groupId}/invites`, body);
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { code: string; link: string; invite: { id: string } };
}

export async function joinViaApi(page: Page, code: string) {
  const res = await api(page, "POST", "/api/groups/join", { code });
  expect(res.status(), await res.text()).toBe(200);
}

// ------------------------------------------------------------------------------------------------ direct database seeding
// Group exams are created by their own UI/API elsewhere; these helpers insert already-published exams and finalized results so the
// leaderboard UI can be tested against real rows (same columns and constraints the backend uses).

export async function insertUser(name: string): Promise<string> {
  const id = `u${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  await sql('INSERT INTO "User" ("id","name","email","updatedAt") VALUES ($1,$2,$3,now())', [id, name, `${id}@example.test`]);
  return id;
}

export async function addMember(groupId: string, userId: string, opts: { showName?: boolean; role?: "MEMBER" | "ADMIN" } = {}) {
  await sql('INSERT INTO "GroupMember" ("groupId","userId","role","showNameOnLeaderboard") VALUES ($1,$2,$3::"GroupRole",$4)', [groupId, userId, opts.role ?? "MEMBER", opts.showName ?? true]);
}

export type SeededExam = { examId: string; versionId: string; totalCenti: number; questionCount: number };

export async function seedGroupExam(opts: {
  groupId: string; ownerId: string; title?: string; questionCount?: number; releaseMode?: "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME"; releaseAt?: Date | null; closesAt?: Date | null; leaderboardVisible?: boolean;
}): Promise<SeededExam> {
  const n = opts.questionCount ?? 10;
  const examId = `e${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const versionId = `v${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const title = opts.title ?? "Seeded group exam";
  await sql(
    `INSERT INTO "Exam" ("id","ownerId","groupId","mode","status","title","draft","currentVersion","publishedAt","updatedAt") VALUES ($1,$2,$3,'GROUP','PUBLISHED',$4,'{}'::jsonb,1,now(),now())`,
    [examId, opts.ownerId, opts.groupId, title],
  );
  await sql(
    `INSERT INTO "ExamVersion" ("id","examId","version","title","mode","groupId","durationSeconds","attemptLimit","closesAt","shuffleQuestions","shuffleOptions","reviewPolicy","releaseMode","releaseAt","lateStart","lateJoinGroup","leaderboardVisible","negativeMarkingBp","questionCount","totalCenti","snapshotHash","publishedById")
     VALUES ($1,$2,1,$3,'GROUP',$4,3600,1,$5,false,false,'FULL',$6::"ReleaseMode",$7,'CAP_AT_CLOSE',true,$8,0,$9,$10,'seeded',$11)`,
    [versionId, examId, title, opts.groupId, opts.closesAt ?? null, opts.releaseMode ?? "IMMEDIATE", opts.releaseAt ?? null, opts.leaderboardVisible ?? true, n, n * 100, opts.ownerId],
  );
  await sql('INSERT INTO "ExamVersionState" ("examVersionId") VALUES ($1)', [versionId]);
  return { examId, versionId, totalCenti: n * 100, questionCount: n };
}

const bandOf = (bp: number) => (bp >= 9000 ? "EXCELLENT" : bp >= 8000 ? "GOOD" : bp >= 7000 ? "NEEDS_IMPROVEMENT" : bp >= 6000 ? "BAD" : "VERY_BAD");

/** Inserts a finalized attempt + result (status SUBMITTED or TIMED_OUT). */
export async function seedResult(exam: SeededExam, userId: string, scoreCenti: number, status: "SUBMITTED" | "TIMED_OUT" = "SUBMITTED") {
  const attemptId = `a${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const finalized = new Date(Date.now() - 3_600_000);
  const started = new Date(finalized.getTime() - 600_000);
  await sql(
    `INSERT INTO "ExamAttempt" ("id","examVersionId","userId","attemptNo","status","startedAt","deadlineAt","submittedAt","finalizedAt","questionOrder","optionOrder")
     VALUES ($1,$2,$3,1,$4::"AttemptStatus",$5,$6,$7,$8,'[]'::jsonb,'{}'::jsonb)`,
    [attemptId, exam.versionId, userId, status, started, new Date(started.getTime() + 3_600_000), status === "SUBMITTED" ? finalized : null, finalized],
  );
  const percentBp = Math.floor((scoreCenti * 10000 * 2 + exam.totalCenti) / (2 * exam.totalCenti));
  const correct = Math.round(scoreCenti / 100);
  await sql(
    `INSERT INTO "ExamResult" ("id","attemptId","examVersionId","userId","rawScoreCenti","scoreCenti","maxCenti","percentBp","correctCount","incorrectCount","unansweredCount","band","finalizedAt")
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,0,$9,$10::"FeedbackBand",$11)`,
    [`r${randomUUID().replaceAll("-", "").slice(0, 22)}`, attemptId, exam.versionId, userId, scoreCenti, exam.totalCenti, percentBp, correct, exam.questionCount - correct, bandOf(percentBp), finalized],
  );
}

/** An in-progress attempt (unranked on the leaderboard). */
export async function seedInProgress(exam: SeededExam, userId: string) {
  const started = new Date();
  await sql(
    `INSERT INTO "ExamAttempt" ("id","examVersionId","userId","attemptNo","status","startedAt","deadlineAt","questionOrder","optionOrder") VALUES ($1,$2,$3,1,'IN_PROGRESS',$4,$5,'[]'::jsonb,'{}'::jsonb)`,
    [`a${randomUUID().replaceAll("-", "").slice(0, 22)}`, exam.versionId, userId, started, new Date(started.getTime() + 3_600_000)],
  );
}

export const LOGIN_PASSWORD = PASSWORD;
