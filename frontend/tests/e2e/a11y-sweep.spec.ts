import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, register, test } from "./fixtures";
import { publishExam, seedBank, startAttempt } from "./exam-helpers";
import { createGroup, createInvite, joinViaApi, newUser, addMember, insertUser, seedGroupExam, seedResult } from "./group-helpers";
import { configureAi } from "./questions-helpers";
import { takeExam } from "./dashboard-helpers";

/**
 * Axe (WCAG 2.0/2.1 A + AA rules) over every non-admin route a signed-in or anonymous visitor can reach, in English, with real data on the
 * data-bearing screens. Serious/critical violations fail the test. (Admin pages: admin.spec.ts. Bangla pages: i18n.spec.ts.)
 */
async function scan(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.getAnimations().forEach((a) => a.finish())); // axe must not sample a mid-fade overlay
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} (${v.nodes[0]?.target})`), label).toEqual([]);
}
async function visit(page: Page, path: string, label = path) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBeLessThan(400);
  await scan(page, label);
}

test.describe("accessibility sweep", () => {
  test("public pages: landing, sign-in, register, forgot/reset password, help, privacy, terms", async ({ page }) => {
    for (const path of ["/", "/login", "/register", "/forgot-password", "/reset-password", "/help", "/privacy", "/terms"]) await visit(page, path);
  });

  test("a brand-new account: empty workspace, dashboard, documents, chat, generators, bank, exams, study plan, groups, notifications, settings", async ({ page }) => {
    test.setTimeout(150_000);
    await register(page);
    for (const path of [
      "/workspace", "/dashboard", "/documents", "/chat", "/mcq", "/cq", "/question-bank", "/exams", "/exams/new", "/study-plan", "/groups", "/join", "/notifications",
      "/settings/profile", "/settings/privacy", "/settings/providers", "/settings/api-keys",
    ]) await visit(page, path, `${path} (new account)`);
  });

  test("an account with data: dashboard, chat, documents, bank, generators with results, exam wizard steps, attempt, result, study plan", async ({ page }) => {
    test.setTimeout(240_000);
    await register(page);
    await configureAi(page, { embedding: true }); // documents are indexed with the embedding model
    await page.goto("/documents");
    await page.waitForLoadState("networkidle");
    await page.locator("#file-input").setInputFiles({ name: "a11y-doc.txt", mimeType: "text/plain", buffer: Buffer.from("Mitochondria are the powerhouse of the cell. They produce ATP through cellular respiration.") });
    await expect(page.getByTestId("doc-a11y-doc.txt").locator("[data-status]")).toHaveAttribute("data-status", "READY", { timeout: 45_000 });
    await visit(page, "/documents", "/documents (with a document)");

    // chat: a new conversation and one with messages
    await page.goto("/chat");
    await page.getByRole("button", { name: /General question/ }).click();
    await expect(page).toHaveURL(/\/chat\/[a-z0-9]+$/);
    await page.getByRole("textbox", { name: "Message" }).fill("Hello");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("assistant-message").last()).toHaveAttribute("data-status", "COMPLETE");
    await scan(page, "/chat/:id (conversation)");
    await visit(page, "/chat", "/chat (list)");

    // generators with results, and the bank
    await page.goto("/mcq");
    await page.getByLabel("Topic", { exact: true }).fill("Cells");
    await page.locator('label[for="mcq-grounding-GENERAL"]').click();
    await page.getByLabel("Number of questions").fill("3");
    await page.getByRole("button", { name: /^Generate/ }).click();
    await expect(page.getByTestId("review-workspace")).toBeVisible({ timeout: 45_000 });
    await scan(page, "/mcq (results)");
    await page.goto("/cq");
    await page.getByLabel("Topic", { exact: true }).fill("Rivers");
    await page.getByRole("button", { name: "Generate CQs" }).click();
    await expect(page.getByTestId("review-workspace")).toBeVisible({ timeout: 45_000 });
    await scan(page, "/cq (results)");
    await visit(page, "/question-bank", "/question-bank (empty collection list)");

    // exams: wizard steps, detail, attempt, result; dashboard and study plan with a result
    const ids = await seedBank(page, 4);
    await visit(page, "/question-bank", "/question-bank (with questions)");
    await page.goto("/exams/new");
    await page.getByLabel("Title").fill("A11y exam");
    await page.getByRole("button", { name: "Continue to questions" }).click();
    await expect(page).toHaveURL(/\/exams\/[^/]+\/edit/);
    const wizardId = page.url().match(/\/exams\/([^/]+)\/edit/)![1]!;
    await scan(page, "/exams/:id/edit?step=questions");
    for (const step of ["details", "rules", "preview"]) await visit(page, `/exams/${wizardId}/edit?step=${step}`, `wizard ${step}`);
    const examId = await publishExam(page, ids, { title: "A11y published exam", durationMinutes: 20 });
    await visit(page, "/exams", "/exams (list)");
    await visit(page, `/exams/${examId}`, "/exams/:id (author)");
    const attemptId = await startAttempt(page, examId);
    await visit(page, `/attempts/${attemptId}`, "/attempts/:id (exam screen)");
    await page.locator('input[data-testid="option-A"] + label').click();
    await expect(page.getByTestId("question-save-state")).toContainText("Saved");
    await scan(page, "/attempts/:id (answered)");
    const done = await takeExam(page, ["right", "wrong", "skip"], { title: "A11y result exam" });
    await visit(page, `/attempts/${done.attemptId}/result`, "/attempts/:id/result");
    await expect(page.getByTestId("ai-ready")).toBeVisible({ timeout: 60_000 });
    await scan(page, "/attempts/:id/result (AI feedback ready)");
    await visit(page, "/dashboard", "/dashboard (with data)");
    await visit(page, "/study-plan", "/study-plan (with data)");
    await visit(page, "/notifications", "/notifications (with items)");
  });

  test("groups: list, every tab, join (valid and invalid), leaderboard", async ({ browser }) => {
    test.setTimeout(150_000);
    const a = await newUser(browser, "Owner Olivia");
    const b = await newUser(browser, "Member Mehdi");
    const gid = await createGroup(a.page, { title: "Sweep group", description: "Axe at work" });
    const invite = await createInvite(a.page, gid);
    await visit(a.page, "/groups", "/groups (list)");
    for (const tab of ["overview", "members", "invites", "exams", "settings"]) await visit(a.page, `/groups/${gid}?tab=${tab}`, `/groups/:id?tab=${tab}`);
    await visit(b.page, `/join/${invite.code}`, "/join/:code (valid)");
    await visit(b.page, "/join/NOTAREALCODE0000000000", "/join/:code (invalid)");
    await joinViaApi(b.page, invite.code);
    await visit(b.page, `/groups/${gid}`, "/groups/:id (member)");

    const exam = await seedGroupExam({ groupId: gid, ownerId: a.id, title: "Sweep exam", questionCount: 10 });
    for (const [name, score] of [["Priya Top", 1000], ["Quinn Mid", 700], ["Raj Low", 300]] as const) {
      const id = await insertUser(name);
      await addMember(gid, id);
      await seedResult(exam, id, score);
    }
    await seedResult(exam, b.id, 800);
    await visit(b.page, `/exams/${exam.examId}/leaderboard`, "leaderboard (member)");
    await visit(a.page, `/exams/${exam.examId}/leaderboard`, "leaderboard (staff)");
    await a.ctx.close();
    await b.ctx.close();
  });

  test("the skip link is the first tab stop and works; exam options show a visible keyboard focus", async ({ page }) => {
    test.setTimeout(120_000);
    await register(page);
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement?.id || document.activeElement?.closest("main")?.id || document.activeElement?.tagName)).toMatch(/main-content|MAIN/i);

    // exam screen: tabbing reaches the radio group and the focused option gets a ring (not colour alone)
    await configureAi(page);
    const ids = await seedBank(page, 2);
    const examId = await publishExam(page, ids, { title: "Focus exam" });
    const attemptId = await startAttempt(page, examId);
    await page.goto(`/attempts/${attemptId}`);
    await expect(page.getByTestId("question-stem")).toBeVisible();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid")?.startsWith("option-") ?? false);
    }
    expect(reached, "tabbing reaches an answer option").toBe(true);
    const ring = await page.evaluate(() => {
      const input = document.activeElement as HTMLElement;
      const label = input.nextElementSibling as HTMLElement;
      const cs = getComputedStyle(label);
      return { shadow: cs.boxShadow, outline: `${cs.outlineStyle} ${cs.outlineWidth}` };
    });
    expect(ring.shadow !== "none" || !/^none/.test(ring.outline), `focus ring on the focused option: ${JSON.stringify(ring)}`).toBe(true);
    await page.keyboard.press("Space"); // keyboard selection works
    await expect(page.getByTestId("question-save-state")).toContainText("Saved");
  });
});
