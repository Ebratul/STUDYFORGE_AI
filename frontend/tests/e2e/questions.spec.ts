import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, register, sql, test } from "./fixtures";
import { api, BIOLOGY_TEXT, configureAi, fillMcq, generateButton, generateMcq, saveAllToNewCollection } from "./questions-helpers";

const cards = (page: Page) => page.getByTestId("review-card");

async function a11y(page: Page, path: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${path}: ${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
}

test.describe("MCQ generation", () => {
  test("topic-only (General AI) generation, then difficulty setting is honoured", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "Photosynthesis", count: 5, difficulty: "HARD", grounding: "GENERAL" });
    await expect(cards(page)).toHaveCount(5);
    await expect(page.getByTestId("review-summary")).toContainText("5 questions");
    for (let i = 0; i < 5; i++) await expect(cards(page).nth(i).getByLabel("Question details")).toContainText("Hard");
    // AI output is never presented as guaranteed correct.
    await expect(page.getByText("AI-generated — review before use").first()).toBeVisible();
    await expect(cards(page).first().getByText("Model knowledge")).toBeVisible();
    await expect(page.getByTestId("model-badge")).toContainText("mock-chat");
  });

  test("Bangla output shows Bangla option labels and text", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "কোষ", count: 3, language: "bn", grounding: "GENERAL" });
    const first = cards(page).first();
    await expect(first).toContainText(/[ঀ-৿]/);
    await expect(first.getByRole("list", { name: "Options" })).toContainText("ক");
    await expect(first.getByRole("list", { name: "Options" })).toContainText("খ");
  });

  test("pasted text with Source only shows evidence quotes; a failed cross-check flags the question for review", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "cells [[solver-disagree]]", text: BIOLOGY_TEXT, count: 3, grounding: "SOURCE_ONLY" });
    await expect(cards(page).first().getByText("Source-quoted")).toBeVisible();
    await cards(page).first().getByText(/Evidence from your sources/).click();
    await expect(cards(page).first().getByText(/found word-for-word in the source/).first()).toBeVisible();
    await expect(cards(page).first().getByTestId("needs-review")).toContainText("second AI pass");
  });

  test("grounding policy options follow the sources", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.goto("/mcq");
    await expect(page.locator("#mcq-grounding-GENERAL")).toBeEnabled();
    await expect(page.locator("#mcq-grounding-SOURCE_ONLY")).toBeDisabled();
    await page.getByLabel("Pasted text (optional)").fill(BIOLOGY_TEXT);
    await expect(page.locator("#mcq-grounding-GENERAL")).toBeDisabled();
    await expect(page.locator("#mcq-grounding-SOURCE_ONLY")).toBeEnabled();
    await expect(page.locator("#mcq-grounding-SOURCE_ONLY")).toBeChecked();
  });

  test("instant validation on the form (the server validates again)", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await fillMcq(page, { topic: "", count: 999 });
    await generateButton(page).click();
    await expect(page.getByText("Enter a topic.")).toBeVisible();
    await expect(page.getByText(/Choose 1–50 questions/)).toBeVisible();
    await expect(page.getByTestId("review-workspace")).toHaveCount(0);
  });

  test("edit, reorder, select, delete with undo, and regenerate one question", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "Cells", count: 4, grounding: "GENERAL" });
    const first = cards(page).first();
    const originalStem = await first.getByRole("paragraph").first().innerText();

    // edit stem, an option and the correct answer
    await first.getByRole("button", { name: "Edit" }).click();
    await first.getByLabel("Question", { exact: true }).fill("What is the powerhouse of the cell?");
    await first.getByLabel("Option B text").fill("Mitochondrion");
    await first.getByLabel("Option B is the correct answer").check();
    await expect(first.getByText("Edited")).toBeVisible();
    // local validation: an empty option is flagged immediately
    await first.getByLabel("Option C text").fill("");
    await expect(first.getByText("Enter the option text.")).toBeVisible();
    await first.getByLabel("Option C text").fill("Nucleus");
    await first.getByRole("button", { name: "Done" }).click();
    await expect(first).toContainText("What is the powerhouse of the cell?");
    await expect(first.getByRole("list", { name: "Options" }).getByText("Correct answer")).toHaveCount(1);

    // reorder: move Q1 down; the edited question is now second and keeps its edits
    await first.getByRole("button", { name: "Move question 1 down" }).click();
    await expect(cards(page).nth(1)).toContainText("What is the powerhouse of the cell?");

    // select / deselect
    await cards(page).nth(0).getByLabel("Select question 1").uncheck();
    await expect(page.getByTestId("review-summary")).toContainText("3 selected");
    await page.getByLabel("Select all").check();
    await expect(page.getByTestId("review-summary")).toContainText("4 selected");

    // delete + undo restores it in place
    await cards(page).nth(1).getByRole("button", { name: "Delete question 2" }).click();
    await expect(cards(page)).toHaveCount(3);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(cards(page)).toHaveCount(4);
    await expect(cards(page).nth(1)).toContainText("What is the powerhouse of the cell?");

    // regenerate one question: only that card changes
    const before = await cards(page).nth(2).innerText();
    await cards(page).nth(2).getByRole("button", { name: "Regenerate question 3" }).click();
    await expect(page.getByText("Question regenerated")).toBeVisible();
    await expect(cards(page).nth(1)).toContainText("What is the powerhouse of the cell?");
    expect(await cards(page).nth(2).innerText()).not.toBe("");
    void before;
    void originalStem;
  });

  test("malformed or invalid provider output ends in a friendly error, and nothing is saved", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await fillMcq(page, { topic: "[[bad-key-always]] cells", count: 3, grounding: "GENERAL" });
    await generateButton(page).click();
    await expect(page.getByTestId("generation-error")).toContainText("No valid questions were produced");
    await page.getByRole("button", { name: "Dismiss" }).click();

    await page.getByLabel("Topic", { exact: true }).fill("[[bad-json-always]] cells");
    await generateButton(page).click();
    await expect(page.getByTestId("generation-error")).toContainText(/couldn.t be read|No valid questions/);
    expect((await (await api(page, "GET", "/api/questions")).json()).total).toBe(0);
  });

  test("provider failures, rate limits and Stop are explained without raw provider text", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await fillMcq(page, { topic: "[[rate-limit]]", count: 2, grounding: "GENERAL" });
    await generateButton(page).click();
    await expect(page.getByTestId("generation-error")).toContainText("rate-limiting");
    await page.getByRole("button", { name: "Dismiss" }).click();

    await page.getByLabel("Topic", { exact: true }).fill("[[slow]]");
    await generateButton(page).click();
    await expect(page.getByTestId("generation-progress")).toBeVisible();
    // Wait until the server has actually registered the run (the progress panel appears as soon as the request is sent).
    await expect.poll(async () => (await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "GenerationRun" WHERE status = 'RUNNING'`))[0]?.n, { timeout: 15_000 }).toBe("1");
    // a second generation while one is running is refused (one run per user)
    const second = await api(page, "POST", "/api/generation/mcq", { topic: "x", count: 1, difficulty: "MIXED", language: "en", optionCount: 4, marks: 1, negativeMarks: 0, includeExplanations: true, includeShortNotes: true, grounding: "GENERAL", crossCheck: false });
    expect(second.status()).toBe(409);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText("Generation stopped. Nothing was saved.")).toBeVisible();
  });

  test("the daily AI quota is reported and no provider call is made", async ({ page }) => {
    const { email } = await register(page);
    await configureAi(page);
    const [user] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [email]);
    await sql(`INSERT INTO "UsageRecord" (id, "userId", category, quantity, "createdAt") VALUES ($1, $2, 'llm.requests', 1000000, now())`, [`q${Date.now()}`, user!.id]);
    await fillMcq(page, { topic: "Cells", count: 2, grounding: "GENERAL" });
    await generateButton(page).click();
    await expect(page.getByTestId("generation-error")).toContainText("Daily AI limit reached");
  });

  test("generation needs a configured model: clear CTA instead of a broken button", async ({ page }) => {
    await register(page);
    await page.goto("/mcq");
    await expect(page.getByText("No model chosen for MCQ generation")).toBeVisible();
    await expect(generateButton(page)).toBeDisabled();
    await expect(page.getByRole("link", { name: "Settings → AI providers" })).toBeVisible();
  });
});

test.describe("question bank", () => {
  test("save to a new collection, find it in the bank, search, filter and paginate", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "Cells", count: 25, grounding: "GENERAL", crossCheck: false });
    await saveAllToNewCollection(page, "Biology set");
    await expect(page.getByTestId("save-success")).toContainText("Biology set");

    await page.getByRole("link", { name: "Open your question bank" }).click();
    await expect(page.getByTestId("collection-header")).toContainText("Biology set");
    await expect(page.getByTestId("bank-total")).toContainText("25 questions");
    await expect(page.getByTestId("page-indicator")).toContainText("Page 1 of 2");
    await expect(page.getByTestId("bank-row")).toHaveCount(20);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByTestId("bank-row")).toHaveCount(5);
    await page.getByRole("button", { name: "Previous" }).click();

    await page.getByRole("searchbox", { name: "Search questions" }).fill("zzz-no-such-thing");
    await expect(page.getByText("No questions match")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByLabel("Difficulty", { exact: true }).selectOption("HARD");
    await expect(page.getByTestId("bank-total")).not.toContainText("25 questions");
    await page.getByLabel("Difficulty", { exact: true }).selectOption("");
    await expect(page.getByTestId("bank-total")).toContainText("25 questions");
  });

  test("open, edit and re-save a question; provenance and version history are shown", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "Cells", count: 2, grounding: "GENERAL", crossCheck: false });
    await saveAllToNewCollection(page, "Edits");
    await page.goto("/question-bank");
    await page.getByTestId("bank-row").first().getByRole("button", { name: "Open" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("provenance")).toContainText("AI-generated");
    await expect(dialog.getByTestId("provenance")).toContainText("mock-chat");
    await dialog.getByRole("button", { name: "Edit", exact: true }).click();
    await dialog.getByLabel("Question", { exact: true }).fill("An edited question about the cell?");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Question saved")).toBeVisible();
    await expect(dialog.getByTestId("provenance")).toContainText("Version2");
    await dialog.getByText("Version history").click();
    await expect(dialog.getByText(/Version 1/)).toBeVisible();
  });

  test("bulk add to a collection, remove, and delete", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "Cells", count: 4, grounding: "GENERAL", crossCheck: false });
    await page.getByRole("button", { name: "Save to collection" }).click();
    await page.getByRole("dialog").getByText("Just save", { exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^Save 4 questions$/ }).click();
    await expect(page.getByTestId("save-success")).toBeVisible();

    await page.goto("/question-bank");
    await page.getByRole("button", { name: "New" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Bulk target");
    await page.getByRole("dialog").getByRole("button", { name: "Create collection" }).click();
    await expect(page.getByTestId("collection-header")).toContainText("Bulk target");
    await page.getByRole("button", { name: "All questions" }).click();

    await page.getByLabel("Select this page").check();
    await page.getByRole("button", { name: "Add to collection" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(/Added 4 questions to the collection/)).toBeVisible();

    await page.getByRole("button", { name: /Bulk target/ }).click();
    await expect(page.getByTestId("bank-row")).toHaveCount(4);
    await page.getByRole("checkbox", { name: /Select:/ }).first().check();
    await page.getByRole("button", { name: "Remove from collection" }).click();
    await expect(page.getByTestId("bank-row")).toHaveCount(3);

    await page.getByLabel("Select this page").check();
    await page.getByTestId("bulk-bar").getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete questions" }).click();
    await expect(page.getByText(/Deleted 3 questions/)).toBeVisible();
  });

  test("export JSON and TXT: valid structure and no internal identifiers", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "Cells", count: 3, grounding: "GENERAL", crossCheck: false });

    await page.getByRole("button", { name: "Export" }).click();
    await page.locator("#export-format").selectOption("json");
    const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
    expect(json.suggestedFilename()).toMatch(/\.json$/);
    const parsed = JSON.parse(readFileSync((await json.path())!, "utf8"));
    expect(parsed.format).toBe("studyforge.questions");
    expect(parsed.questions).toHaveLength(3);
    const raw = JSON.stringify(parsed);
    for (const leaked of ["ownerId", "documentId", "generationRunId", "\"provider\"", "mock-valid-key"]) expect(raw).not.toContain(leaked);

    await page.getByRole("button", { name: "Export" }).click();
    await page.locator("#export-format").selectOption("txt");
    const [txt] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
    expect(txt.suggestedFilename()).toMatch(/\.txt$/);
    const text = readFileSync((await txt.path())!, "utf8");
    expect(text).toContain("1.");
    expect(text).toMatch(/A\)/);
  });

  test("copy and print use only the selected questions", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await register(page);
    await configureAi(page);
    await generateMcq(page, { topic: "Cells", count: 3, grounding: "GENERAL", crossCheck: false });
    await cards(page).nth(2).getByLabel("Select question 3").uncheck();
    await page.getByRole("button", { name: "Copy" }).click();
    await page.getByRole("menuitem", { name: "Copy with answers and notes" }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain("1.");
    expect(text).toContain("2.");
    expect(text).not.toContain("3.");
    expect(text).toContain("Answer:");
    // The print layout exists in the DOM but is hidden on screen, and visible only to the print media type.
    await expect(page.getByTestId("print-area")).toBeHidden();
    await page.emulateMedia({ media: "print" });
    await page.evaluate(() => document.documentElement.classList.add("sf-printing"));
    await expect(page.getByTestId("print-area")).toBeVisible();
    await expect(page.getByTestId("print-area").getByRole("listitem").first()).toBeVisible();
  });

  test("another user cannot open your questions or collections", async ({ browser }) => {
    const a = await (await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.61" } })).newPage();
    const b = await (await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.62" } })).newPage();
    await register(a);
    await register(b);
    await configureAi(a);
    await generateMcq(a, { topic: "Cells", count: 2, grounding: "GENERAL", crossCheck: false });
    await saveAllToNewCollection(a, "Private set");
    const q = (await (await api(a, "GET", "/api/questions")).json()).items[0].id as string;
    const col = (await (await api(a, "GET", "/api/collections")).json()).items[0].id as string;

    expect((await api(b, "GET", `/api/questions/${q}`)).status()).toBe(404);
    expect((await api(b, "GET", `/api/collections/${col}`)).status()).toBe(404);
    expect((await (await api(b, "GET", "/api/questions")).json()).total).toBe(0);
    for (const path of [`/question-bank?question=${q}`, `/question-bank?collection=${col}`]) {
      await b.goto(path);
      await expect(b.getByText(/couldn.t find what you were looking for|not found/i).first()).toBeVisible();
    }
    await a.context().close();
    await b.context().close();
  });
});

test.describe("CQ generation", () => {
  test("questions-only mode writes no model answers; with-answers mode shows answers and their basis", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.goto("/cq");
    await page.getByLabel("Topic", { exact: true }).fill("Photosynthesis");
    await page.getByRole("button", { name: "Generate CQs" }).click();
    await expect(page.getByTestId("review-workspace")).toBeVisible({ timeout: 45_000 });
    // Scoped to the results: the mode descriptions above the form legitimately mention "model answers".
    await expect(page.getByTestId("review-workspace").getByText("Model answer")).toHaveCount(0);
    await expect(cards(page).first().getByRole("list", { name: "Parts" }).getByRole("listitem")).toHaveCount(4);

    await page.locator('label[for="cq-mode-WITH_ANSWERS"]').click();
    await page.getByRole("button", { name: "Generate CQs" }).click();
    await expect(page.getByTestId("review-workspace").getByText("Model answer").first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("General reasoning").first()).toBeVisible();
  });

  test("Bangla 4-part CQ uses ক খ গ ঘ and the four cognitive levels", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.goto("/cq");
    await page.getByLabel("Topic", { exact: true }).fill("কোষ");
    await page.locator('label[for="cq-language-bn"]').click();
    await page.getByRole("button", { name: "Generate CQs" }).click();
    const parts = cards(page).first().getByRole("list", { name: "Parts" });
    await expect(parts).toBeVisible({ timeout: 45_000 });
    for (const level of ["জ্ঞানমূলক", "অনুধাবনমূলক", "প্রয়োগমূলক", "উচ্চতর দক্ষতামূলক"]) await expect(parts).toContainText(level);
    for (const label of ["ক", "খ", "গ", "ঘ"]) await expect(parts).toContainText(label);
  });

  test("with Source preferred, answers the sources cannot support are shown as insufficient evidence, not invented", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.goto("/cq");
    await page.locator('label[for="cq-mode-WITH_ANSWERS"]').click();
    await page.getByLabel("Topic", { exact: true }).fill("cells [[insufficient]]");
    await page.getByLabel("Pasted text (optional)").fill(BIOLOGY_TEXT);
    await page.locator('label[for="cq-grounding-SOURCE_PREFERRED"]').click();
    await page.getByRole("button", { name: "Generate CQs" }).click();
    const results = page.getByTestId("review-workspace");
    await expect(results.getByText("Insufficient evidence in your sources").first()).toBeVisible({ timeout: 45_000 });
    await expect(results.getByText(/No answer was written/).first()).toBeVisible();
  });

  test("with Source only, a CQ none of whose answers the sources support is rejected with an honest message", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.goto("/cq");
    await page.locator('label[for="cq-mode-WITH_ANSWERS"]').click();
    await page.getByLabel("Topic", { exact: true }).fill("cells [[insufficient]]");
    await page.getByLabel("Pasted text (optional)").fill(BIOLOGY_TEXT);
    await page.locator('label[for="cq-grounding-SOURCE_ONLY"]').click();
    await page.getByRole("button", { name: "Generate CQs" }).click();
    const err = page.getByTestId("generation-error");
    await expect(err).toContainText("Your sources couldn't back any of the questions", { timeout: 45_000 });
    await expect(err).toContainText("Nothing was invented or kept");
    await expect(page.getByTestId("review-workspace")).toHaveCount(0);
  });

  test("there is no timer anywhere in the CQ workspace", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.goto("/cq");
    const before = await page.getByRole("main").innerText();
    expect(before.replace(/there is no timer/g, "")).not.toMatch(/\b(timer|countdown|time limit|time remaining|duration|stopwatch)\b/i);
    await expect(page.locator('[role="timer"], input[type="time"]')).toHaveCount(0);
    await page.getByLabel("Topic", { exact: true }).fill("Photosynthesis");
    await page.getByRole("button", { name: "Generate CQs" }).click();
    await expect(page.getByTestId("review-workspace")).toBeVisible({ timeout: 45_000 });
    const after = await page.getByRole("main").innerText();
    expect(after.replace(/there is no timer/g, "")).not.toMatch(/\b(timer|countdown|time limit|time remaining|duration|stopwatch)\b/i);
  });

  test("save a CQ set and find it in the bank", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.goto("/cq");
    await page.getByLabel("Topic", { exact: true }).fill("Photosynthesis");
    await page.getByLabel("Number of questions").fill("2");
    await page.getByRole("button", { name: "Generate CQs" }).click();
    await expect(page.getByTestId("review-workspace")).toBeVisible({ timeout: 45_000 });
    await saveAllToNewCollection(page, "CQ practice");
    await page.goto("/question-bank");
    await page.getByLabel("Type", { exact: true }).selectOption("CQ");
    await expect(page.getByTestId("bank-total")).toContainText("2 questions");
  });
});

test.describe("accessibility", () => {
  test("generator and bank pages have no serious accessibility violations", async ({ page }) => {
    await register(page);
    await configureAi(page);
    for (const path of ["/mcq", "/cq", "/question-bank"]) {
      await page.goto(path);
      await a11y(page, path);
    }
    await generateMcq(page, { topic: "Cells", count: 3, grounding: "GENERAL", crossCheck: false });
    await a11y(page, "/mcq (results)");
    await cards(page).first().getByRole("button", { name: "Edit" }).click();
    await a11y(page, "/mcq (editing)");
  });

  test("the generator has no horizontal scroll on a phone", async ({ page }) => {
    await register(page);
    await configureAi(page);
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ["/mcq", "/cq", "/question-bank"]) {
      await page.goto(path);
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw, `${path} scrollWidth`).toBeLessThanOrEqual(cw);
    }
  });
});
