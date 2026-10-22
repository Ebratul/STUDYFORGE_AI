import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, register, sql, test } from "./fixtures";
import { publishExam, seedBank, startAttempt } from "./exam-helpers";
import { api } from "./questions-helpers";

async function a11y(page: Page, path: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${path}: ${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
}
/** Picks option A/B/C/D on the exam screen by clicking its visible label. */
const choose = (page: Page, letter: "A" | "B" | "C" | "D") => page.locator(`input[data-testid="option-${letter}"] + label`).click();
const savedState = (page: Page) => page.getByTestId("question-save-state");
const timerSeconds = async (page: Page) => {
  const [m, s] = ((await page.getByTestId("exam-timer").innerText()).split(":").slice(-2)).map(Number);
  return m! * 60 + s!;
};

test.describe("creating and publishing an exam", () => {
  test("wizard: details → questions → rules → preview → publish; then take it, submit and read the server's result", async ({ page }) => {
    await register(page);
    await seedBank(page, 4);

    await page.goto("/exams/new");
    await page.getByLabel("Title").fill("Cell biology test");
    await page.getByRole("button", { name: "Continue to questions" }).click();
    await expect(page).toHaveURL(/\/exams\/[^/]+\/edit\?step=questions/);

    await page.getByRole("button", { name: "Add all on this page" }).click();
    await expect(page.getByTestId("selected-count")).toContainText("4/");
    await expect(page.getByTestId("selected-row")).toHaveCount(4);

    await page.getByTestId("wizard-next").click(); // Rules
    await page.getByLabel("Duration (minutes)").fill("20");
    await page.getByLabel("Attempts allowed per person").fill("2");
    await page.getByLabel(/Negative marking/).fill("25");
    await expect(page.getByTestId("draft-status")).toContainText("Draft saved");

    await page.getByTestId("wizard-next").click(); // Preview
    await expect(page.getByTestId("publish-button")).toBeVisible();
    await expect(page.getByTestId("pv-count")).toHaveText("4");
    await expect(page.getByTestId("pv-marks")).toHaveText("4");
    await expect(page.getByTestId("preview-questions").getByText("Correct").first()).toBeVisible(); // the author sees the key
    await page.getByTestId("publish-button").click();
    await page.getByTestId("confirm-publish").click();
    await expect(page).toHaveURL(/\/exams\/[^/]+\?published=1/);
    await expect(page.getByTestId("published-banner")).toBeVisible();
    await expect(page.getByTestId("rules-list")).toContainText("20 min");

    await page.getByTestId("start-exam").click();
    await expect(page).toHaveURL(/\/attempts\/[^/]+$/);
    await expect(page.getByTestId("exam-timer")).toBeVisible();

    await choose(page, "A"); // Q1: correct
    await expect(savedState(page)).toContainText("Saved");
    await page.getByTestId("next-question").click();
    await choose(page, "B"); // Q2: wrong
    await expect(savedState(page)).toContainText("Saved");
    await page.getByTestId("next-question").click(); // Q3: skipped
    await page.getByTestId("next-question").click();
    await choose(page, "A"); // Q4: correct
    await expect(savedState(page)).toContainText("Saved");
    await expect(page.getByTestId("save-indicator")).toContainText("All changes saved");
    await expect(page.getByTestId("progress-text")).toHaveText("3/4 answered");

    await page.getByTestId("submit-exam").click();
    await expect(page.getByRole("dialog")).toContainText("1 question is unanswered");
    await page.getByTestId("confirm-submit").click();
    await expect(page).toHaveURL(/\/attempts\/[^/]+\/result/);

    // 2 correct (+2), 1 wrong at 25 % (−0.25), 1 unanswered: 1.75 / 4 = 43.75 %
    await expect(page.getByTestId("percentage")).toHaveText("43.75%");
    await expect(page.getByTestId("score-fraction")).toContainText("1.75");
    await expect(page.getByTestId("count-correct")).toHaveText("2");
    await expect(page.getByTestId("count-incorrect")).toHaveText("1");
    await expect(page.getByTestId("count-unanswered")).toHaveText("1");
    await expect(page.getByTestId("band-chip")).toHaveText("Very bad");
    await expect(page.getByTestId("review-item")).toHaveCount(4);
    await expect(page.getByTestId("review").getByText("Correct answer").first()).toBeVisible();
    await expect(page.getByText(/Because option A is right/).first()).toBeVisible();
    await expect(page.getByTestId("topic-performance")).toBeVisible();

    await page.goto("/dashboard");
    await expect(page.getByTestId("exam-performance")).toContainText("43.75%");
  });

  test("an exam that isn't open yet can't be started and says why", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 2);
    const opens = new Date(Date.now() + 3 * 3600_000).toISOString();
    const closes = new Date(Date.now() + 6 * 3600_000).toISOString();
    const id = await publishExam(page, ids, { window: { opensAt: opens, closesAt: closes }, durationMinutes: 30 });
    await page.goto(`/exams/${id}`);
    await expect(page.getByTestId("rules-list")).toContainText("Opens");
    // The author's view carries no precomputed eligibility, so the server answers when Start is pressed.
    await page.getByTestId("start-exam").click();
    await expect(page.locator('[data-slot="alert"][role="alert"]')).toContainText("hasn't opened yet");
    await expect(page).toHaveURL(new RegExp(`/exams/${id}`));
    const res = await api(page, "POST", `/api/exams/${id}/attempts`, {});
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("EXAM_NOT_OPEN");
  });
});

test.describe("taking an exam", () => {
  test("the countdown comes from the server: a device clock 2 hours ahead changes nothing", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 2);
    const examId = await publishExam(page, ids, { durationMinutes: 20 });
    const attemptId = await startAttempt(page, examId);
    await page.addInitScript(() => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + 2 * 3600_000;
      const RealDate = Date;
      // @ts-expect-error test shim: shift `new Date()` too
      window.Date = class extends RealDate { constructor(...a: unknown[]) { if (a.length === 0) super(realNow() + 2 * 3600_000); else super(...(a as [string])); } };
    });
    await page.goto(`/attempts/${attemptId}`);
    await expect(page.getByTestId("exam-timer")).toBeVisible();
    const s = await timerSeconds(page);
    expect(s).toBeGreaterThan(19 * 60 + 30);
    expect(s).toBeLessThanOrEqual(20 * 60);
    expect(await page.getByTestId("exam-timer").innerText()).not.toBe("0:00");
  });

  test("answers survive a reload (restored from the server) and the server never sends the key while taking", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 3);
    const examId = await publishExam(page, ids);
    const attemptId = await startAttempt(page, examId);
    await page.goto(`/attempts/${attemptId}`);
    await choose(page, "C");
    await expect(savedState(page)).toContainText("Saved");
    await page.reload();
    await expect(page.getByTestId("option-C")).toBeChecked();

    const body = await (await api(page, "GET", `/api/attempts/${attemptId}`)).text();
    for (const forbidden of ["isCorrect", "correctOptionId", "explanation", "Because option A is right", "shortNote"]) expect(body).not.toContain(forbidden);
  });

  test("offline: nothing is called saved; a banner explains; reconnecting saves and restores", async ({ page, context }) => {
    await register(page);
    const ids = await seedBank(page, 3);
    const attemptId = await startAttempt(page, await publishExam(page, ids));
    await page.goto(`/attempts/${attemptId}`);
    await expect(page.getByTestId("save-indicator")).toContainText("All changes saved");
    await context.setOffline(true);
    await choose(page, "B");
    await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("save-indicator")).toContainText("Not saved");
    await expect(savedState(page)).not.toContainText("Saved");
    await context.setOffline(false);
    // Coming back online retries by itself; the button is only needed if that hasn't happened yet.
    const retry = page.getByRole("button", { name: "Retry now" }).first();
    if (await retry.isVisible().catch(() => false)) await retry.click({ timeout: 2000 }).catch(() => undefined);
    await expect(page.getByTestId("offline-banner")).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId("save-indicator")).toContainText("All changes saved");
    await page.reload();
    await expect(page.getByTestId("option-B")).toBeChecked();
  });

  test("keyboard: A–D choose, N/P move, M marks; focus stays visible and operable", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 3);
    const attemptId = await startAttempt(page, await publishExam(page, ids));
    await page.goto(`/attempts/${attemptId}`);
    await expect(page.getByTestId("question-card")).toBeVisible();
    await page.keyboard.press("b");
    await expect(page.getByTestId("option-B")).toBeChecked();
    await page.keyboard.press("n");
    await expect(page.locator("#question-pill")).toContainText("Question 2");
    await page.keyboard.press("3");
    await expect(page.getByTestId("option-C")).toBeChecked();
    await page.keyboard.press("m");
    await expect(page.getByTestId("mark-review")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("p");
    await expect(page.locator("#question-pill")).toContainText("Question 1");
    await expect(page.getByTestId("option-B")).toBeChecked();
    await expect(page.getByRole("button", { name: /Question 2, answered, marked for review/ })).toBeVisible();
  });

  test("time expiry is decided by the server: late answers are not counted and the attempt is finalized with the saved ones", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 3);
    const attemptId = await startAttempt(page, await publishExam(page, ids));
    await page.goto(`/attempts/${attemptId}`);
    await choose(page, "A"); // Q1 correct, saved before the deadline
    await expect(savedState(page)).toContainText("Saved");
    // The server-side deadline passes (well beyond the grace period) while the page is still open.
    await sql(`UPDATE "ExamAttempt" SET "startedAt" = now() - interval '2 hours', "deadlineAt" = now() - interval '1 hour' WHERE id = $1`, [attemptId]);
    await page.getByTestId("next-question").click();
    await choose(page, "B"); // too late: the server must refuse this one
    // (the "Time is up" card is brief: the server already knows the attempt ended, so we move straight to the outcome)
    await expect(page).toHaveURL(/\/attempts\/[^/]+\/result/, { timeout: 30_000 });
    await expect(page.getByText("Time ran out", { exact: true })).toBeVisible();
    await expect(page.getByTestId("count-correct")).toHaveText("1");
    await expect(page.getByTestId("count-incorrect")).toHaveText("0"); // the late Q2 answer was not counted
    const [row] = await sql<{ status: string }>(`SELECT status FROM "ExamAttempt" WHERE id = $1`, [attemptId]);
    expect(row!.status).toBe("TIMED_OUT");
  });

  test("reopening an attempt whose deadline passed finalizes it and shows the outcome", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 2);
    const attemptId = await startAttempt(page, await publishExam(page, ids));
    await sql(`UPDATE "ExamAttempt" SET "startedAt" = now() - interval '2 hours', "deadlineAt" = now() - interval '1 hour' WHERE id = $1`, [attemptId]);
    await page.goto(`/attempts/${attemptId}`);
    await expect(page).toHaveURL(/\/attempts\/[^/]+\/result/, { timeout: 20_000 });
    await expect(page.getByText("Time ran out", { exact: true })).toBeVisible();
    await expect(page.getByTestId("count-unanswered")).toHaveText("2");
  });
});

test.describe("results are released by policy", () => {
  test("not released: no score, no answers, in the page or in the API", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 2);
    const examId = await publishExam(page, ids, { release: { mode: "AT_TIME", at: new Date(Date.now() + 24 * 3600_000).toISOString() } });
    const attemptId = await startAttempt(page, examId);
    await page.goto(`/attempts/${attemptId}`);
    await choose(page, "A");
    await expect(savedState(page)).toContainText("Saved");
    await page.getByTestId("submit-exam").click();
    await page.getByTestId("confirm-submit").click();
    await expect(page).toHaveURL(/\/result/);
    await expect(page.getByTestId("not-released")).toBeVisible();
    await expect(page.getByTestId("score-card")).toHaveCount(0);
    await expect(page.getByTestId("review")).toHaveCount(0);
    const raw = await (await api(page, "GET", `/api/attempts/${attemptId}/result`)).text();
    for (const forbidden of ["scoreCenti", "percentBp", "correctOptionId", "explanation", "Because option A is right"]) expect(raw).not.toContain(forbidden);
  });

  test("score-only exams show the score but no review", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 2);
    const attemptId = await startAttempt(page, await publishExam(page, ids, { reviewPolicy: "NONE" }));
    await page.goto(`/attempts/${attemptId}`);
    await page.getByTestId("submit-exam").click();
    await page.getByTestId("confirm-submit").click();
    await expect(page.getByTestId("percentage")).toBeVisible();
    await expect(page.getByTestId("no-review")).toBeVisible();
    await expect(page.getByText("Correct answer")).toHaveCount(0);
  });

  test("submitting twice is safe", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 2);
    const attemptId = await startAttempt(page, await publishExam(page, ids));
    const a = await api(page, "POST", `/api/attempts/${attemptId}/submit`, {});
    const b = await api(page, "POST", `/api/attempts/${attemptId}/submit`, {});
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    const rows = await sql<{ n: string }>(`SELECT count(*) AS n FROM "ExamResult" WHERE "attemptId" = $1`, [attemptId]);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

test.describe("access control", () => {
  test("another user cannot open your attempt, result or exam", async ({ browser, page }) => {
    await register(page);
    const ids = await seedBank(page, 2);
    const examId = await publishExam(page, ids);
    const attemptId = await startAttempt(page, examId);

    const other = await (await browser.newContext()).newPage();
    await register(other);
    for (const path of [`/attempts/${attemptId}`, `/attempts/${attemptId}/result`, `/exams/${examId}`, `/exams/${examId}/edit`]) {
      await other.goto(path);
      await expect(other.getByText(/couldn.t find|not found/i).first()).toBeVisible({ timeout: 15_000 });
    }
    expect((await api(other, "GET", `/api/attempts/${attemptId}`)).status()).toBe(404);
    expect((await api(other, "PUT", `/api/attempts/${attemptId}/answers`, { answers: [] })).status()).toBeGreaterThanOrEqual(400);
    await other.context().close();
  });
});

test.describe("accessibility and layout", () => {
  test("exam pages have no serious axe violations", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 3);
    const examId = await publishExam(page, ids);
    await page.goto("/exams");
    await expect(page.getByTestId("exam-list-mine")).toBeVisible();
    await a11y(page, "/exams");
    await page.goto("/exams/new");
    await a11y(page, "/exams/new");
    await page.goto(`/exams/${examId}`);
    await a11y(page, "/exams/:id");
    const attemptId = await startAttempt(page, examId);
    await page.goto(`/attempts/${attemptId}`);
    await expect(page.getByTestId("question-card")).toBeVisible();
    await a11y(page, "/attempts/:id");
    await page.getByTestId("submit-exam").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(600); // let the dialog's fade-in finish (axe would otherwise sample mid-animation colours)
    await a11y(page, "/attempts/:id (submit dialog)");
    await page.getByTestId("confirm-submit").click();
    await expect(page.getByTestId("score-card")).toBeVisible();
    await a11y(page, "/attempts/:id/result");
  });

  test("the wizard steps have no serious axe violations", async ({ page }) => {
    await register(page);
    await seedBank(page, 3);
    await page.goto("/exams/new");
    await page.getByLabel("Title").fill("A11y exam");
    await page.getByRole("button", { name: "Continue to questions" }).click();
    await page.getByRole("button", { name: "Add all on this page" }).click();
    await a11y(page, "wizard questions");
    await page.getByTestId("wizard-next").click();
    await a11y(page, "wizard rules");
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("publish-button")).toBeVisible();
    await a11y(page, "wizard preview");
  });

  test("no horizontal scroll on a phone for the exam screen and the result", async ({ page }) => {
    await register(page);
    const ids = await seedBank(page, 3);
    const attemptId = await startAttempt(page, await publishExam(page, ids));
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`/attempts/${attemptId}`);
    await expect(page.getByTestId("question-card")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByTestId("submit-exam").click();
    await page.getByTestId("confirm-submit").click();
    await expect(page.getByTestId("score-card")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
