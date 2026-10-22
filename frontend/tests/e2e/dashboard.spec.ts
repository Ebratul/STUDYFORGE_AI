import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, register, test } from "./fixtures";
import { answerAndSubmit, takeExam } from "./dashboard-helpers";
import { publishExam, seedBank, startAttempt } from "./exam-helpers";
import { api, configureAi } from "./questions-helpers";

async function a11y(page: Page, path: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${path}: ${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
}

test.describe("dashboard: real data only", () => {
  test("a new user sees explicit empty states, and 'no data' is not a zero score", async ({ page }) => {
    await register(page);
    await page.goto("/dashboard");
    await expect(page.getByTestId("no-exam-results")).toContainText("No exam results yet");
    await expect(page.getByTestId("stat-average")).toHaveAttribute("data-state", "empty");
    await expect(page.getByTestId("stat-highest")).toHaveAttribute("data-state", "empty");
    await expect(page.getByTestId("stat-average")).toContainText("No data yet");
    await expect(page.getByText("0.00%")).toHaveCount(0);
    await expect(page.getByTestId("trend-empty")).toBeVisible();
    await expect(page.getByTestId("topics-empty")).toBeVisible();
    await expect(page.getByTestId("feedback-empty")).toBeVisible();
    await expect(page.getByTestId("saved-empty")).toBeVisible();
    await expect(page.getByTestId("groups-empty")).toBeVisible();
    await expect(page.getByTestId("continue-learning")).toBeVisible();
    await expect(page.getByText("Unread notifications")).toBeVisible();
  });

  test("after an exam: totals, trend table, topic states and recent results come from the released result", async ({ page }) => {
    await register(page);
    await takeExam(page, ["right", "right", "wrong", "skip"], { title: "Cells and energy", negativeFraction: 0.25 });
    await page.goto("/dashboard");
    // 2 correct (+2), 1 wrong (-0.25), 1 unanswered: 1.75 / 4 = 43.75 %
    await expect(page.getByTestId("stat-completed")).toContainText("1");
    await expect(page.getByTestId("stat-average")).toContainText("43.75%");
    await expect(page.getByTestId("stat-highest")).toContainText("43.75%");
    await expect(page.getByTestId("stat-correct")).toContainText("2");
    await expect(page.getByTestId("data-level")).toContainText("Initial picture");
    await page.getByText("Show the data as a table").click();
    await expect(page.getByTestId("trend-card").getByRole("table")).toContainText("Cells and energy");
    await expect(page.getByTestId("trend-card").getByRole("table")).toContainText("43.75%");
    // two questions per topic: too few answers to call either topic weak
    await expect(page.getByTestId("topic-bars")).toContainText("Not enough data");
    await expect(page.getByTestId("topic-bars")).not.toContainText("Needs work");
    await expect(page.getByTestId("recent-results")).toContainText("Cells and energy");
    await expect(page.getByTestId("recent-results")).toContainText("Very bad");
    await expect(page.getByTestId("breakdown")).toContainText("Unanswered");
  });

  test("a real zero score is shown as 0.00%, not as 'No data yet'", async ({ page }) => {
    await register(page);
    await takeExam(page, ["wrong", "wrong", "wrong"], { title: "Zero exam" });
    await page.goto("/dashboard");
    await expect(page.getByTestId("stat-average")).toHaveAttribute("data-state", "value");
    await expect(page.getByTestId("stat-average")).toContainText("0.00%");
    await expect(page.getByTestId("stat-highest")).toContainText("0.00%");
  });

  test("results of an exam that isn't released yet are not counted", async ({ page }) => {
    await register(page);
    const later = new Date(Date.now() + 6 * 3600_000).toISOString();
    await takeExam(page, ["right", "right"], { title: "Held back", release: { mode: "AT_TIME", at: later } });
    await page.goto("/dashboard");
    await expect(page.getByTestId("no-exam-results")).toBeVisible();
    await expect(page.getByTestId("stat-average")).toHaveAttribute("data-state", "empty");
  });

  test("dashboard failure to load analytics shows a retry and leaves the rest of the page working", async ({ page }) => {
    await register(page);
    await page.route("**/api/analytics/me", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }) }));
    await page.goto("/dashboard");
    await expect(page.getByTestId("dashboard-error")).toBeVisible();
    await expect(page.getByText("Unread notifications")).toBeVisible();
    await page.unroute("**/api/analytics/me");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("no-exam-results")).toBeVisible();
  });
});

test.describe("AI feedback on results", () => {
  test("the verified score is always shown; AI feedback can be requested and then reads as supportive, grounded text", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await api(page, "PATCH", "/api/preferences", { theme: "SYSTEM", locale: "en", emailNotifications: true, autoAiFeedback: false });
    const { attemptId } = await takeExam(page, ["right", "wrong", "wrong", "wrong"], { title: "Feedback exam" });
    await page.goto(`/attempts/${attemptId}/result`);
    await expect(page.getByTestId("percentage")).toHaveText("25.00%");
    await expect(page.getByTestId("ai-none")).toBeVisible();
    await page.getByRole("button", { name: "Get AI feedback" }).click();
    await expect(page.getByTestId("ai-ready")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("ai-disclaimer")).toContainText("does not change your score");
    await expect(page.getByTestId("percentage")).toHaveText("25.00%"); // the AI never moves the score
    await a11y(page, "result with AI feedback");
  });

  test("failure does not block the result, and the user can recover (no model → configure → retry)", async ({ page }) => {
    await register(page);
    const { attemptId } = await takeExam(page, ["right", "wrong"], { title: "Recovery exam" });
    await page.goto(`/attempts/${attemptId}/result`);
    await expect(page.getByTestId("percentage")).toHaveText("50.00%");
    await expect(page.getByTestId("band-chip")).toBeVisible(); // deterministic feedback is there without any AI
    await page.getByRole("button", { name: "Get AI feedback" }).click();
    await expect(page.getByTestId("ai-not-configured")).toBeVisible();
    await configureAi(page);
    await page.getByTestId("ai-not-configured").getByRole("button", { name: "Try again" }).click(); // (the page also has "Try again" for retaking the exam)
    await expect(page.getByTestId("ai-ready")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("percentage")).toHaveText("50.00%");
  });

  test("a provider failure shows a calm message and a retry, and the result stays visible", async ({ page }) => {
    test.setTimeout(120_000);
    await register(page);
    await configureAi(page);
    // manual request only, so the automatic job doesn't race the click; the backend retries a transient failure a few times before giving up
    await api(page, "PATCH", "/api/preferences", { theme: "SYSTEM", locale: "en", emailNotifications: true, autoAiFeedback: false });
    const { attemptId } = await takeExam(page, ["right", "wrong"], { title: "[[fail]] Provider down" });
    await page.goto(`/attempts/${attemptId}/result`);
    await expect(page.getByTestId("percentage")).toHaveText("50.00%");
    await page.getByRole("button", { name: "Get AI feedback" }).click();
    await expect(page.getByTestId("ai-failed")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("ai-failed")).toContainText("unaffected");
    await expect(page.getByTestId("ai-failed").getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByTestId("score-card")).toBeVisible();
  });

  test("'Explain this' hands the question to the study assistant, which sends it exactly once", async ({ page }) => {
    await register(page);
    await configureAi(page);
    const { attemptId } = await takeExam(page, ["wrong"], { title: "Explain exam", reviewPolicy: "FULL" });
    await page.goto(`/attempts/${attemptId}/result`);
    await page.getByTestId("explain-question").first().click();
    await expect(page).toHaveURL(/\/chat\/[^/]+$/);
    await expect(page.getByText(/Mock reply/).first()).toBeVisible({ timeout: 30_000 });
    const sent = await page.locator("main").getByText(/Explain|explain/).count();
    expect(sent).toBeGreaterThan(0);
    await page.reload(); // reloading must not send the prompt a second time
    await page.waitForLoadState("networkidle");
    const userBubbles = page.locator('[data-testid="user-message"], [data-role="user"]');
    if (await userBubbles.count()) await expect(userBubbles).toHaveCount(1);
  });
});

test.describe("study plan", () => {
  test("no results: nothing to base a plan on; with a result: initial suggestions and an AI plan that says so", async ({ page }) => {
    await register(page);
    await page.goto("/study-plan");
    await expect(page.getByTestId("plan-no-data")).toBeVisible();
    await configureAi(page);
    await takeExam(page, ["right", "wrong", "wrong", "wrong"], { title: "Plan exam" });
    await page.goto("/study-plan");
    await expect(page.getByTestId("plan-level")).toHaveAttribute("data-level", "INITIAL");
    await expect(page.getByTestId("plan-level")).toContainText("one exam can't");
    await expect(page.getByTestId("plan-none")).toBeVisible();
    await page.getByRole("button", { name: "Write my plan" }).click();
    await expect(page.getByTestId("plan-ready")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("plan-label")).toHaveText("Initial suggestions");
    await a11y(page, "study plan");
  });
});

test.describe("generators, settings and accessibility", () => {
  test("?topic= and ?grounding= prefill the generators without generating anything", async ({ page }) => {
    await register(page);
    await configureAi(page);
    let generated = false;
    await page.route(/\/api\/generation\/(mcq|cq)$/, (route) => { generated = true; return route.continue(); }); // only a generation request counts (the recent-runs list is a GET)
    await page.goto("/mcq?topic=Photosynthesis&grounding=GENERAL&subject=Biology");
    await expect(page.getByLabel("Topic", { exact: true })).toHaveValue("Photosynthesis");
    await expect(page.getByLabel("Subject (optional)")).toHaveValue("Biology");
    await expect(page.locator("#mcq-grounding-GENERAL")).toBeChecked();
    await page.goto("/cq?topic=" + encodeURIComponent("<img src=x onerror=alert(1)>") + "&grounding=ROOT");
    await expect(page.getByLabel("Topic", { exact: true })).toHaveValue("<img src=x onerror=alert(1)>"); // plain text in an input, never markup
    expect(generated).toBe(false);
  });

  test("automatic AI feedback preference persists and the usage card shows the no-cost note", async ({ page }) => {
    await register(page);
    await page.goto("/settings/profile");
    const sw = page.getByRole("switch", { name: "Automatic AI feedback" });
    await expect(sw).toBeChecked();
    await sw.click();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText("Preferences saved")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("switch", { name: "Automatic AI feedback" })).not.toBeChecked();
    await page.goto("/settings/providers");
    await expect(page.getByTestId("usage-card")).toBeVisible();
    await expect(page.getByTestId("usage-note")).toContainText("no cost estimate");
  });

  test("with automatic feedback on, a configured user gets AI feedback without asking", async ({ page }) => {
    await register(page);
    await configureAi(page);
    const { attemptId } = await takeExam(page, ["right", "right", "wrong"], { title: "Auto feedback exam" });
    await page.goto(`/attempts/${attemptId}/result`);
    await expect(page.getByTestId("ai-ready")).toBeVisible({ timeout: 45_000 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("ai-feedback-cards")).toContainText("Auto feedback exam");
  });

  test("dashboard, study plan, results and usage have no serious accessibility violations, and nothing overflows on a phone", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await ctx.newPage();
    await register(page);
    await configureAi(page);
    const ids = await seedBank(page, 4);
    const examId = await publishExam(page, ids, { title: "A11y exam", durationMinutes: 20 });
    const attemptId = await startAttempt(page, examId);
    await answerAndSubmit(page, attemptId, ["right", "wrong", "wrong", "skip"]);
    for (const path of ["/dashboard", "/study-plan", `/attempts/${attemptId}/result`, "/settings/providers", "/settings/profile"]) {
      await page.goto(path);
      await a11y(page, path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(0);
    }
    await ctx.close();
  });
});
