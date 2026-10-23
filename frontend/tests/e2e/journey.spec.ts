import type { Browser, Page } from "@playwright/test";
import { expect, sql, test, uniqueEmail, signOut } from "./fixtures";
import { userWithRole, seedFailedJob } from "./admin-helpers";
import { takeExam } from "./dashboard-helpers";
import { publishExam } from "./exam-helpers";
import { newUser, type TestUser } from "./group-helpers";
import { answerExamViaUi, examKeyFor, loginViaUi, startAttemptViaUi } from "./journey-helpers";
import { connectViaForm } from "./connection-helpers";
import { api, VALID_KEY } from "./questions-helpers";

/**
 * The whole product, in the order a student meets it (PART5 brief §12). Mock AI provider only; everything runs against the real
 * rag_agent + backend + production frontend + Postgres. One serial describe: a failing step skips the rest, which is the honest outcome.
 */
test.describe.configure({ mode: "serial" });

const DOC_NAME = "biology-notes.txt";
const DOC_TEXT =
  "Mitochondria are the powerhouse of the cell. They produce ATP through cellular respiration. The nucleus stores genetic material and controls cell activity. " +
  "Ribosomes build proteins from amino acids. The Golgi body packages proteins for transport. Chloroplasts capture light energy during photosynthesis.";
const NOT_FOUND = /couldn.t find what you were looking for|not found|doesn.t exist/i;
const cards = (p: Page) => p.getByTestId("review-card");

let browser: Browser;
let owner: TestUser; // Aisha: student, individual exams, group owner
let member: TestUser; // Bela: group member
let member2: TestUser; // Chitra: second group member
let outsider: TestUser; // Dev: nobody's friend
let admin: TestUser; // an ADMIN account
const s = {} as {
  docId: string; conversationId: string; collectionId: string; examId: string; attemptId: string; resultId: string; groupId: string; groupExamId: string;
  memberAttemptId: string; member2AttemptId: string; questionId: string; email: string;
};

test.beforeAll(async ({ browser: b }) => {
  browser = b;
});
test.afterAll(async () => {
  for (const u of [owner, member, member2, outsider, admin]) await u?.ctx.close();
});

const count = async (query: string, params: unknown[]) => Number((await sql<{ n: string }>(query, params))[0]!.n);
const resultIdOf = async (attemptId: string) => (await sql<{ id: string }>('SELECT id FROM "ExamResult" WHERE "attemptId" = $1', [attemptId]))[0]!.id;
const analysisOf = async (resultId: string) => (await sql<{ status: string; attempts: number; updatedAt: Date }>('SELECT status::text, attempts, "updatedAt" FROM "ExamAnalysis" WHERE "resultId" = $1', [resultId]))[0];

test("1. register, sign out and sign back in", async () => {
  test.setTimeout(90_000);
  owner = await newUser(browser, "Aisha Rahman"); // registers through the real form
  s.email = owner.email;
  const p = owner.page;
  await expect(p.getByRole("heading", { name: /Welcome, Aisha/ })).toBeVisible();
  await signOut(p);
  await p.goto("/dashboard");
  await expect(p).toHaveURL(/\/login/); // protected pages need a session
  await loginViaUi(p, owner.email);
  await expect(p.getByRole("heading", { name: /Welcome, Aisha/ })).toBeVisible();
});

test("2. configure the mock provider key, the default chat model and the embedding model in Settings", async () => {
  const p = owner.page;
  await connectViaForm(p); // key + chat model + embedding model through the three inputs; the server tests all three before saving
  expect(await p.content()).not.toContain(VALID_KEY); // the key never comes back to the browser
  await expect(p.getByTestId("status-key")).toContainText("••••-key");
  await expect(p.getByTestId("status-embedding")).toHaveText("mock-embed");
  const prefs = await (await api(p, "GET", "/api/ai/preferences")).json();
  expect(prefs.default).toMatchObject({ provider: "MOCK", modelId: "mock-chat" });
  expect(prefs.tasks.EMBEDDING).toMatchObject({ modelId: "mock-embed" });
});

test("3. upload a document and wait for it to be processed", async () => {
  const p = owner.page;
  await p.goto("/documents");
  await p.waitForLoadState("networkidle"); // the file input exists before React attaches its handler
  await p.locator("#file-input").setInputFiles({ name: DOC_NAME, mimeType: "text/plain", buffer: Buffer.from(DOC_TEXT) });
  const row = p.getByTestId(`doc-${DOC_NAME}`);
  await expect(row).toBeVisible();
  await expect(row.locator("[data-status]")).toHaveAttribute("data-status", "READY", { timeout: 45_000 });
  s.docId = (await (await api(p, "GET", "/api/documents")).json()).items[0].id;
  expect(await count('SELECT count(*) n FROM "DocumentChunk" WHERE "documentId" = $1', [s.docId])).toBeGreaterThan(0);
});

test("4. a document-grounded answer cites the document; an off-topic question gets the exact fallback", async () => {
  test.setTimeout(90_000);
  const p = owner.page;
  const ask = async (text: string) => {
    await p.getByRole("textbox", { name: "Message" }).fill(text);
    await p.getByRole("button", { name: "Send message" }).click();
  };
  const fresh = async () => {
    await p.goto("/chat");
    await p.getByRole("button", { name: /Ask my documents/ }).click();
    await expect(p).toHaveURL(/\/chat\/[a-z0-9]+$/);
    await p.getByRole("button", { name: /Attach documents/ }).click();
    await p.getByRole("checkbox", { name: `Use ${DOC_NAME}` }).click();
    await p.keyboard.press("Escape");
  };
  await fresh();
  s.conversationId = p.url().split("/").pop()!;
  await ask("What do mitochondria produce through cellular respiration?");
  const answer = p.getByTestId("assistant-message").last();
  await expect(answer).toContainText("Mitochondria are the powerhouse");
  await expect(answer.getByTestId("citation-chip")).toContainText(DOC_NAME);
  await fresh();
  await ask("What is the capital of France?");
  await expect(p.getByTestId("insufficient-evidence")).toContainText(
    "Sorry, I couldn't find enough relevant information in your uploaded documents to answer this question. Please upload a relevant document or ask a question about the available content.",
  );
  await expect(p.getByText(/Paris/)).toHaveCount(0);
});

test("5. generate MCQs from the document (Source only), edit one, save to a new collection", async () => {
  test.setTimeout(120_000);
  const p = owner.page;
  await p.goto("/mcq");
  await p.getByLabel(DOC_NAME).check();
  await p.locator('label[for="mcq-grounding-SOURCE_ONLY"]').click();
  await p.getByLabel("Number of questions").fill("4");
  await p.getByRole("button", { name: /^Generate/ }).click();
  await expect(p.getByTestId("review-workspace")).toBeVisible({ timeout: 60_000 });
  await expect(cards(p)).toHaveCount(4);
  await expect(cards(p).first()).toContainText("Source-quoted"); // evidence quotes were verified against the document

  const first = cards(p).first();
  await first.getByRole("button", { name: "Edit" }).click();
  await first.getByLabel("Question", { exact: true }).fill("Which organelle is called the powerhouse of the cell?");
  await first.getByLabel("Option B text").fill("Mitochondrion");
  await first.getByLabel("Option B is the correct answer").check();
  await first.getByRole("button", { name: "Done" }).click();
  await expect(first).toContainText("Which organelle is called the powerhouse of the cell?");

  await p.getByRole("button", { name: "Save to collection" }).click();
  const dialog = p.getByRole("dialog");
  await dialog.getByText("New collection", { exact: true }).click();
  await dialog.getByLabel("Name").fill("Journey set");
  await dialog.getByRole("button", { name: /^Save \d+ questions?$/ }).click();
  await expect(p.getByTestId("save-success")).toContainText("Journey set");

  const cols = (await (await api(p, "GET", "/api/collections")).json()).items as { id: string; title: string; questionCount: number }[];
  const col = cols.find((c) => c.title === "Journey set")!;
  expect(col.questionCount).toBe(4);
  s.collectionId = col.id;
  const saved = (await (await api(p, "GET", `/api/collections/${col.id}/questions`)).json()).items as { id: string; stem: string; modifiedByUser: boolean; sourceSupport: string; correctOptionId: string; options: { id: string; text: string }[] }[];
  const edited = saved.find((q) => q.stem === "Which organelle is called the powerhouse of the cell?")!;
  expect(edited.modifiedByUser).toBe(true);
  expect(edited.options.find((o) => o.id === edited.correctOptionId)!.text).toBe("Mitochondrion");
  expect(edited.sourceSupport).toBe("SOURCE_QUOTED"); // provenance is the server's, derived from the generation, not from the edit
  s.questionId = edited.id;
});

test("6. CQs: questions-only has no model answers; with-answers shows them with their basis", async () => {
  test.setTimeout(120_000);
  const p = owner.page;
  await p.goto("/cq");
  await p.getByLabel(DOC_NAME).check();
  await p.getByRole("button", { name: "Generate CQs" }).click();
  const results = p.getByTestId("review-workspace");
  await expect(results).toBeVisible({ timeout: 60_000 });
  await expect(results.getByText("Model answer")).toHaveCount(0);
  await expect(cards(p).first().getByRole("list", { name: "Parts" }).getByRole("listitem")).toHaveCount(4);
  await p.locator('label[for="cq-mode-WITH_ANSWERS"]').click();
  await p.getByRole("button", { name: "Generate CQs" }).click();
  await expect(results.getByText("Model answer").first()).toBeVisible({ timeout: 60_000 });
  await expect(results.getByText(/Source-supported|General reasoning/).first()).toBeVisible();
  expect((await p.getByRole("main").innerText()).replace(/there is no timer/gi, "")).not.toMatch(/\b(timer|countdown|time limit|time remaining|duration|stopwatch)\b/i); // CQ is study content, never timed
});

test("7. create an individual exam from the saved collection in the wizard, publish, take it, submit", async () => {
  test.setTimeout(150_000);
  const p = owner.page;
  await p.goto("/exams/new");
  await p.getByLabel("Title").fill("Journey exam");
  await p.getByRole("button", { name: "Continue to questions" }).click();
  await p.getByLabel("Collection").selectOption({ label: "Journey set (4)" });
  await p.getByRole("button", { name: "Add the whole collection" }).click();
  await expect(p.getByTestId("selected-count")).toContainText("4/");
  await p.getByTestId("wizard-next").click();
  await p.getByLabel("Duration (minutes)").fill("20");
  await p.getByLabel("Attempts allowed per person").fill("3");
  await p.getByLabel(/Negative marking/).fill("25");
  await expect(p.getByTestId("draft-status")).toContainText("Draft saved");
  await p.getByTestId("wizard-next").click();
  await expect(p.getByTestId("pv-count")).toHaveText("4");
  await expect(p.getByTestId("preview-questions").getByText("Correct").first()).toBeVisible();
  await p.getByTestId("publish-button").click();
  await p.getByTestId("confirm-publish").click();
  await expect(p).toHaveURL(/\/exams\/[^/]+\?published=1/);
  s.examId = new URL(p.url()).pathname.split("/").pop()!;

  const key = await examKeyFor(p, s.examId);
  expect([...key.keys()]).toContain("Which organelle is called the powerhouse of the cell?"); // the edit reached the published snapshot
  s.attemptId = await startAttemptViaUi(p, s.examId);
  await answerExamViaUi(p, s.attemptId, key, ["right", "right", "wrong", "skip"]);
  expect(await count('SELECT count(*) n FROM "ExamResult" WHERE "attemptId" = $1', [s.attemptId])).toBe(1);
  expect(await count('SELECT count(*) n FROM "ExamAttempt" WHERE "examVersionId" IN (SELECT id FROM "ExamVersion" WHERE "examId" = $1)', [s.examId])).toBe(1);
  s.resultId = await resultIdOf(s.attemptId);
});

test("8. the result shows the exact score, review and AI feedback; the dashboard agrees", async () => {
  test.setTimeout(120_000);
  const p = owner.page;
  // 2 correct (+2), 1 wrong at 25 % (-0.25), 1 unanswered = 1.75 / 4 = 43.75 %
  await expect(p.getByTestId("percentage")).toHaveText("43.75%");
  await expect(p.getByTestId("score-fraction")).toContainText("1.75");
  await expect(p.getByTestId("count-correct")).toHaveText("2");
  await expect(p.getByTestId("count-incorrect")).toHaveText("1");
  await expect(p.getByTestId("count-unanswered")).toHaveText("1");
  await expect(p.getByTestId("band-chip")).toHaveText("Very bad");
  await expect(p.getByTestId("review-item")).toHaveCount(4);
  await expect(p.getByTestId("review").getByText("Correct answer").first()).toBeVisible();
  await expect(p.getByTestId("review-item").first()).toContainText(/Explanation|explanation|The correct answer/);
  await expect(p.getByTestId("ai-ready")).toBeVisible({ timeout: 60_000 }); // automatic feedback (on by default once a model is configured)
  await expect(p.getByTestId("ai-disclaimer")).toContainText("does not change your score");
  await expect(p.getByTestId("percentage")).toHaveText("43.75%"); // the AI never moves the score
  const stored = (await sql<{ scoreCenti: number; maxCenti: number; percentBp: number; band: string }>('SELECT "scoreCenti","maxCenti","percentBp",band::text FROM "ExamResult" WHERE id = $1', [s.resultId]))[0]!;
  expect(stored).toMatchObject({ scoreCenti: 175, maxCenti: 400, percentBp: 4375, band: "VERY_BAD" });

  await p.goto("/dashboard");
  await expect(p.getByTestId("exam-performance")).toContainText("43.75%");
  await expect(p.getByTestId("ai-feedback-cards")).toContainText("Journey exam");
  const me = await (await api(p, "GET", "/api/analytics/me")).json();
  expect(me.totals.completed).toBe(1);
  expect(me.trend[0]).toMatchObject({ attemptId: s.attemptId, percentBp: 4375, band: "VERY_BAD" });
});

test("9. create a group, create an invitation, two people join with the link", async () => {
  test.setTimeout(120_000);
  const p = owner.page;
  member = await newUser(browser, "Bela Member");
  member2 = await newUser(browser, "Chitra Member");
  await p.goto("/groups");
  await p.getByRole("button", { name: "New group" }).click();
  await p.getByLabel("Group name").fill("Biology batch");
  await p.getByLabel("Member capacity").fill("5");
  await p.getByRole("button", { name: "Create group" }).click();
  await expect(p).toHaveURL(/\/groups\/[^/]+$/);
  s.groupId = p.url().split("/").pop()!;
  await p.goto(`/groups/${s.groupId}?tab=invites`);
  await p.getByRole("button", { name: "New invitation" }).click();
  await p.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  const code = (await p.getByTestId("invite-code").innerText()).replace(/\s+/g, "");
  for (const m of [member, member2]) {
    await m.page.goto(`/join/${code}`);
    await expect(m.page.getByTestId("join-group-title")).toHaveText("Biology batch");
    await m.page.getByRole("button", { name: "Join group" }).click();
    await expect(m.page).toHaveURL(new RegExp(`/groups/${s.groupId}$`));
  }
  expect(await count('SELECT count(*) n FROM "GroupMember" WHERE "groupId" = $1', [s.groupId])).toBe(3);
  // the code is a bearer secret shown once: only its hash is stored
  expect(await count('SELECT count(*) n FROM "GroupInvite" WHERE "codeHash" = $1', [code])).toBe(0);
});

test("10. a group exam: same questions for everyone, individual submissions, then the leaderboard", async () => {
  test.setTimeout(240_000);
  const p = owner.page;
  const qs = (await (await api(p, "GET", `/api/collections/${s.collectionId}/questions`)).json()).items as { id: string }[];
  s.groupExamId = await publishExam(p, qs.map((q) => q.id), { title: "Group midterm", group: { id: s.groupId }, durationMinutes: 20, negativeFraction: 0, attemptLimit: 1 });
  const key = await examKeyFor(p, s.groupExamId);

  // the author doesn't compete in their own group exam
  expect((await api(p, "POST", `/api/exams/${s.groupExamId}/attempts`, {})).status()).toBe(403);

  s.memberAttemptId = await startAttemptViaUi(member.page, s.groupExamId);
  await answerExamViaUi(member.page, s.memberAttemptId, key, ["right", "right", "right", "wrong"]); // 3/4
  s.member2AttemptId = await startAttemptViaUi(member2.page, s.groupExamId);
  await answerExamViaUi(member2.page, s.member2AttemptId, key, ["right", "wrong", "wrong", "skip"]); // 1/4

  // identical canonical question set for both participants
  const stems = async (m: TestUser, id: string) => ((await (await api(m.page, "GET", `/api/attempts/${id}`)).json()).attempt ?? {}).questions?.map((q: { stem: string }) => q.stem).sort();
  const a = await stems(member, s.memberAttemptId);
  expect(a).toEqual(await stems(member2, s.member2AttemptId));
  expect(a).toHaveLength(4);

  await member.page.goto(`/exams/${s.groupExamId}/leaderboard`);
  const rows = member.page.getByTestId("leaderboard-row");
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-rank")))).toEqual(["1", "2"]);
  await expect(rows.nth(0)).toContainText("Bela Member");
  await expect(rows.nth(0)).toContainText("75.00%");
  await expect(rows.nth(1)).toContainText("25.00%");
  await expect(member.page.getByTestId("distribution-chart").locator("svg")).toBeVisible();
  await expect(member.page.getByTestId("leaderboard-stats")).toContainText("75.00%");
  // verified persisted scores: leaderboard == database
  const db = await sql<{ name: string; percentBp: number }>('SELECT u.name, r."percentBp" FROM "ExamResult" r JOIN "User" u ON u.id = r."userId" JOIN "ExamVersion" v ON v.id = r."examVersionId" JOIN "Exam" e ON e.id = v."examId" WHERE e.id = $1 ORDER BY r."percentBp" DESC', [s.groupExamId]);
  expect(db.map((r) => [r.name, r.percentBp])).toEqual([["Bela Member", 7500], ["Chitra Member", 2500]]);
  // the owner (staff) sees the board too, but a participant's dashboard is their own
  await owner.page.goto(`/exams/${s.groupExamId}/leaderboard`);
  await expect(owner.page.getByTestId("leaderboard-row")).toHaveCount(2);
});

test("11. unauthorized users (outsider, admin, fellow member) cannot reach private records", async () => {
  test.setTimeout(150_000);
  outsider = await newUser(browser, "Dev Outsider");
  admin = await userWithRole(browser, "ADMIN", "Root Admin");
  const convId = s.conversationId;
  const paths = [
    `/api/attempts/${s.attemptId}`, `/api/attempts/${s.attemptId}/result`, `/api/analysis/attempts/${s.attemptId}`,
    `/api/questions/${s.questionId}`, `/api/questions/${s.questionId}/revisions`, `/api/collections/${s.collectionId}`, `/api/collections/${s.collectionId}/questions`,
    `/api/documents/${s.docId}`, `/api/conversations/${convId}`, `/api/conversations/${convId}/messages`, `/api/exams/${s.examId}`,
    `/api/groups/${s.groupId}`, `/api/groups/${s.groupId}/members`, `/api/groups/${s.groupId}/invites`, `/api/exams/${s.groupExamId}/leaderboard`, `/api/exams/${s.groupExamId}/topics`,
    `/api/attempts/${s.member2AttemptId}`, `/api/attempts/${s.member2AttemptId}/result`,
  ];
  for (const who of [outsider, admin]) {
    for (const path of paths) expect((await api(who.page, "GET", path)).status(), `${who.name}: ${path}`).toBe(404);
    expect((await api(who.page, "POST", `/api/exams/${s.examId}/attempts`, {})).status()).toBe(404);
    // "my attempts for this exam" is scoped to the caller: someone else's exam yields an empty list, never the owner's attempts
    expect(await (await api(who.page, "GET", `/api/exams/${s.examId}/attempts`)).json()).toEqual({ items: [] });
    expect((await api(who.page, "POST", `/api/conversations/${convId}/messages`, { content: "hi" })).status()).toBe(404);
    expect((await api(who.page, "DELETE", `/api/documents/${s.docId}`)).status()).toBe(404);
    expect((await api(who.page, "PATCH", `/api/questions/${s.questionId}`, { markReviewed: true })).status()).toBe(404);
    const creds = await (await api(who.page, "GET", "/api/ai/credentials")).text();
    expect(creds).not.toContain(VALID_KEY);
    expect(creds).not.toContain("••••-key"); // not even the owner's masked key
    expect(JSON.parse(creds)).toEqual(expect.objectContaining({ items: [] }));
  }
  // a fellow member cannot read another member's attempt, answers or result either
  expect((await api(member.page, "GET", `/api/attempts/${s.member2AttemptId}`)).status()).toBe(404);
  expect((await api(member.page, "GET", `/api/attempts/${s.member2AttemptId}/result`)).status()).toBe(404);
  expect((await api(member.page, "PUT", `/api/attempts/${s.member2AttemptId}/answers`, { answers: [{ questionId: "nope", optionId: null, seq: 1 }] })).status()).toBe(404);
  expect((await api(member.page, "POST", `/api/exams/${s.examId}/attempts`, {})).status()).toBe(404); // the owner's individual exam is not theirs
  // non-members can't see the leaderboard; an unauthenticated visitor gets 401
  const anon = await (await browser.newContext({ extraHTTPHeaders: { origin: "http://localhost:3100" } })).request.get("http://localhost:3100/api/attempts/" + s.attemptId);
  expect(anon.status()).toBe(401);
  // the UI treats the same ids as nonexistent
  for (const path of [`/attempts/${s.attemptId}/result`, `/exams/${s.examId}`, `/exams/${s.groupExamId}/leaderboard`, `/groups/${s.groupId}`, `/chat/${convId}`, `/question-bank?question=${s.questionId}`, `/question-bank?collection=${s.collectionId}`]) {
    await outsider.page.goto(path);
    await expect(outsider.page.getByText(NOT_FOUND).first(), path).toBeVisible();
  }
  await outsider.page.goto("/documents");
  await expect(outsider.page.getByText(DOC_NAME)).toHaveCount(0);
  // the admin console has no door to user content (ADMIN is least-privilege, no break-glass)
  const users = await (await api(admin.page, "GET", "/api/admin/users?q=Aisha")).text();
  expect(users).not.toContain(DOC_NAME);
  expect(users).not.toContain("Journey set");
  // ... and the owner's own data is untouched
  expect((await api(owner.page, "GET", `/api/attempts/${s.attemptId}/result`)).status()).toBe(200);
});

test("12a. recovery: an AI provider failure never touches the verified result, and Retry never duplicates rows", async () => {
  test.setTimeout(240_000);
  const p = owner.page;
  const { attemptId } = await takeExam(p, ["right", "wrong"], { title: "[[fail]] Provider outage" });
  const resultId = await resultIdOf(attemptId);
  await p.goto(`/attempts/${attemptId}/result`);
  await expect(p.getByTestId("percentage")).toHaveText("50.00%");
  await expect(p.getByTestId("band-chip")).toBeVisible();
  await expect(p.getByTestId("ai-failed")).toBeVisible({ timeout: 90_000 }); // automatic job: bounded retries, then FAILED
  await expect(p.getByTestId("ai-failed")).toContainText("unaffected");
  await expect(p.getByTestId("percentage")).toHaveText("50.00%");
  await expect(p.getByTestId("band-chip")).toBeVisible();
  await p.goto("/dashboard");
  await expect(p.getByTestId("exam-performance")).toBeVisible(); // the dashboard still has the result
  expect((await analysisOf(resultId))?.status).toBe("FAILED");

  const before = (await analysisOf(resultId))!;
  await p.goto(`/attempts/${attemptId}/result`);
  await p.getByTestId("ai-failed").getByRole("button", { name: "Retry" }).click();
  await expect.poll(async () => { const a = await analysisOf(resultId); return a && a.updatedAt > before.updatedAt && a.status === "FAILED"; }, { timeout: 90_000 }).toBe(true);
  await expect(p.getByTestId("ai-failed")).toBeVisible({ timeout: 30_000 });
  expect(await count('SELECT count(*) n FROM "ExamResult" WHERE "attemptId" = $1', [attemptId])).toBe(1);
  expect(await count('SELECT count(*) n FROM "ExamAnalysis" WHERE "resultId" = $1', [resultId])).toBe(1);
  expect(await count('SELECT count(*) n FROM "ExamAttempt" WHERE id = $1', [attemptId])).toBe(1);
  const r = (await sql<{ scoreCenti: number; percentBp: number }>('SELECT "scoreCenti","percentBp" FROM "ExamResult" WHERE id = $1', [resultId]))[0]!;
  expect(r).toMatchObject({ scoreCenti: 100, percentBp: 5000 });
});

test("12b. recovery: deleting the API key shows 'not configured' with a Settings link; re-adding it and retrying works", async () => {
  test.setTimeout(150_000);
  const p = owner.page;
  expect((await api(p, "DELETE", "/api/ai/credentials/mock")).ok()).toBe(true); // the key is removed (API; the connection form has no delete action)
  await p.goto("/settings/providers");
  await expect(p.getByTestId("status-key")).toContainText("No key");

  const { attemptId } = await takeExam(p, ["right", "wrong", "wrong"], { title: "Recovery without a key" });
  const resultId = await resultIdOf(attemptId);
  await p.goto(`/attempts/${attemptId}/result`);
  await expect(p.getByTestId("percentage")).toHaveText("33.33%");
  await p.getByRole("button", { name: "Get AI feedback" }).or(p.getByTestId("ai-not-configured")).first().waitFor();
  if (await p.getByRole("button", { name: "Get AI feedback" }).count()) await p.getByRole("button", { name: "Get AI feedback" }).click();
  const nc = p.getByTestId("ai-not-configured");
  await expect(nc).toBeVisible({ timeout: 60_000 });
  await expect(nc.getByRole("link", { name: "AI connection" })).toHaveAttribute("href", "/settings/providers"); // CTA into Settings
  await expect(p.getByTestId("percentage")).toHaveText("33.33%");
  expect((await analysisOf(resultId))?.status).toBe("NOT_CONFIGURED");

  // recover: enter the key and both model ids again in the connection form, then Retry
  await connectViaForm(p);
  await p.goto(`/attempts/${attemptId}/result`);
  await p.getByTestId("ai-not-configured").getByRole("button", { name: "Try again" }).click();
  await expect(p.getByTestId("ai-ready")).toBeVisible({ timeout: 60_000 });
  expect(await count('SELECT count(*) n FROM "ExamAnalysis" WHERE "resultId" = $1', [resultId])).toBe(1);
  expect(await count('SELECT count(*) n FROM "ExamResult" WHERE "attemptId" = $1', [attemptId])).toBe(1);
});

test("12c. recovery: a failed background job is visible to an admin, can be retried, and ends without duplicate rows", async () => {
  test.setTimeout(180_000);
  const p = owner.page;
  // a result whose AI feedback was never produced (automatic feedback off), plus a FAILED queue row as the worker would leave it
  expect((await api(p, "PATCH", "/api/preferences", { theme: "SYSTEM", locale: "en", emailNotifications: true, autoAiFeedback: false })).ok()).toBe(true);
  const { attemptId } = await takeExam(p, ["right", "right", "wrong", "skip"], { title: "Queue recovery exam" });
  const resultId = await resultIdOf(attemptId);
  expect(await analysisOf(resultId)).toBeUndefined();
  const tag = `JOURNEY-${uniqueEmail("x").slice(2, 10)}`;
  const jobId = await seedFailedJob("exam.analysis", `PROVIDER_UNAVAILABLE after 3 attempts ${tag}`);
  await sql(`UPDATE "Job" SET payload = $1::jsonb WHERE id = $2`, [JSON.stringify({ resultId }), jobId]);

  const a = admin.page;
  await a.goto("/admin/jobs");
  const failure = a.getByTestId("failure-row").filter({ hasText: tag });
  await expect(failure).toBeVisible();
  await failure.getByRole("button", { name: /Retry/ }).click();
  await a.getByRole("dialog").getByRole("button", { name: "Retry job" }).click();
  await expect(a.getByText("Job queued for another attempt")).toBeVisible();

  // the worker picks it up: the feedback is produced exactly once and the job finishes cleanly
  await expect.poll(async () => (await analysisOf(resultId))?.status, { timeout: 90_000 }).toBe("READY");
  await expect.poll(async () => (await sql<{ status: string }>('SELECT status::text FROM "Job" WHERE id = $1', [jobId]))[0]?.status, { timeout: 30_000 }).toBe("SUCCEEDED");
  expect(await count('SELECT count(*) n FROM "ExamAnalysis" WHERE "resultId" = $1', [resultId])).toBe(1);
  expect(await count('SELECT count(*) n FROM "ExamResult" WHERE "attemptId" = $1', [attemptId])).toBe(1);
  await p.goto(`/attempts/${attemptId}/result`);
  await expect(p.getByTestId("ai-ready")).toBeVisible({ timeout: 30_000 });
  await expect(p.getByTestId("percentage")).toHaveText("50.00%"); // 2 of 4 correct, no negative marking
  await api(p, "PATCH", "/api/preferences", { theme: "SYSTEM", locale: "en", emailNotifications: true, autoAiFeedback: true });
});
