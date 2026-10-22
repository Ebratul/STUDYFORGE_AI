import type { Page } from "@playwright/test";
import { expect, PASSWORD } from "./fixtures";
import { api } from "./questions-helpers";

/** Signs in through the real login form. */
export async function loginViaUi(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace/);
}

export type ExamKey = Map<string, { correct: string; wrong: string }>;

/** The author's view of an exam carries the answer key; returns stem → correct/wrong option text. */
export async function examKeyFor(author: Page, examId: string): Promise<ExamKey> {
  const res = await api(author, "GET", `/api/exams/${examId}`);
  expect(res.status(), await res.text()).toBe(200);
  const questions = (await res.json()).exam.questions as { stem: string; options: { id: string; text: string }[]; correctOptionId: string }[];
  expect(questions.length).toBeGreaterThan(0);
  const key: ExamKey = new Map();
  for (const q of questions) {
    const correct = q.options.find((o) => o.id === q.correctOptionId)!.text;
    const wrong = q.options.find((o) => o.id !== q.correctOptionId)!.text;
    key.set(q.stem, { correct, wrong });
  }
  return key;
}

export type Plan = ("right" | "wrong" | "skip")[];

/**
 * Takes an exam through the real exam screen: for every question it reads the stem on screen, looks up the right/wrong option TEXT in the
 * author's key and clicks the option showing that text, waits for the server-confirmed "Saved", then submits through the confirmation dialog.
 */
export async function answerExamViaUi(page: Page, attemptId: string, key: ExamKey, plan: Plan): Promise<void> {
  await page.goto(`/attempts/${attemptId}`);
  await expect(page.getByTestId("exam-timer")).toBeVisible();
  const view = await (await api(page, "GET", `/api/attempts/${attemptId}`)).json();
  const questions = (view.attempt ?? view).questions as { stem: string; options: { id: string; text: string }[] }[];
  expect(questions.length).toBe(plan.length);
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    await expect(page.getByTestId("question-stem")).toHaveText(q.stem);
    const how = plan[i]!;
    if (how !== "skip") {
      const k = key.get(q.stem);
      if (!k) throw new Error(`No key for question: ${q.stem}`);
      const text = how === "right" ? k.correct : k.wrong;
      const index = q.options.findIndex((o) => o.text === text);
      expect(index, `option "${text}" is shown`).toBeGreaterThanOrEqual(0);
      await page.locator(`input[data-testid="option-${"ABCDEF"[index]}"] + label`).click();
      await expect(page.getByTestId("question-save-state")).toContainText("Saved");
    }
    if (i < questions.length - 1) await page.getByTestId("next-question").click();
  }
  await page.getByTestId("submit-exam").click();
  await page.getByTestId("confirm-submit").click();
  await expect(page).toHaveURL(/\/attempts\/[^/]+\/result/);
}

export async function startAttemptViaUi(page: Page, examId: string): Promise<string> {
  await page.goto(`/exams/${examId}`);
  await page.getByTestId("start-exam").click();
  await expect(page).toHaveURL(/\/attempts\/[^/]+$/);
  return page.url().split("/").pop()!;
}
