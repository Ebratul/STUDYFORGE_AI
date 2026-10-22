import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export const VALID_KEY = "mock-valid-key";

/** Authenticated same-origin API call (the browser context already carries the session cookie). */
export async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.request.fetch(path, {
    method,
    headers: { origin: "http://localhost:3100", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Mock provider key + default chat model (+ optional embedding model) for the signed-in user. */
export async function configureAi(page: Page, opts: { embedding?: boolean } = {}) {
  expect((await api(page, "PUT", "/api/ai/credentials/mock", { apiKey: VALID_KEY })).ok()).toBe(true);
  const prefs = { default: { provider: "mock", modelId: "mock-chat" }, tasks: opts.embedding ? { EMBEDDING: { provider: "mock", modelId: "mock-embed" } } : {} };
  expect((await api(page, "PUT", "/api/ai/preferences", prefs)).ok()).toBe(true);
}

export type McqForm = { topic?: string; text?: string; count?: number; difficulty?: "EASY" | "MEDIUM" | "HARD" | "MIXED"; language?: "en" | "bn"; grounding?: "SOURCE_ONLY" | "SOURCE_PREFERRED" | "GENERAL"; crossCheck?: boolean };

export async function fillMcq(page: Page, f: McqForm) {
  await page.goto("/mcq");
  if (f.topic !== undefined) await page.getByLabel("Topic", { exact: true }).fill(f.topic);
  if (f.text !== undefined) await page.getByLabel("Pasted text (optional)").fill(f.text);
  if (f.count !== undefined) await page.getByLabel("Number of questions").fill(String(f.count));
  if (f.difficulty) await page.locator(`label[for="mcq-difficulty-${f.difficulty}"]`).click();
  if (f.language) await page.locator(`label[for="mcq-language-${f.language}"]`).click();
  if (f.grounding) await page.locator(`label[for="mcq-grounding-${f.grounding}"]`).click();
  if (f.crossCheck === false) await page.getByRole("switch", { name: "Double-check answer keys" }).click();
}

export const generateButton = (page: Page) => page.getByRole("button", { name: /^Generate/ });

export async function generateMcq(page: Page, f: McqForm) {
  await fillMcq(page, f);
  await generateButton(page).click();
  await expect(page.getByTestId("review-workspace")).toBeVisible({ timeout: 45_000 });
}

/** Saves every question in the review list to a new collection and returns once the success banner shows. */
export async function saveAllToNewCollection(page: Page, title: string) {
  await page.getByRole("button", { name: "Save to collection" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("New collection", { exact: true }).click();
  await dialog.getByLabel("Name").fill(title);
  await dialog.getByRole("button", { name: /^Save \d+ questions?$/ }).click();
  await expect(page.getByTestId("save-success")).toBeVisible();
}

export const BIOLOGY_TEXT =
  "Mitochondria are the powerhouse of the cell. They produce ATP through cellular respiration. The nucleus stores genetic material. Ribosomes build proteins from amino acids. The Golgi body packages proteins for transport.";
