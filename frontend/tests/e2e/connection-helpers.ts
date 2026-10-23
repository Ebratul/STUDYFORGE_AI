import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export const VALID_KEY = "mock-valid-key";

/** The three text-like inputs of the AI connection form (docs/AI_CONNECTION_SPEC.md §4). */
export const connectionInputs = (page: Page) => ({
  // by name, so the same helpers work in English and Bangla (the labels are asserted separately)
  key: page.locator('input[name="apiKey"]'),
  chat: page.locator('input[name="chatModelId"]'),
  embedding: page.locator('input[name="embeddingModelId"]'),
});

/** Fills the form (only the fields given) and presses "Test and save". Does not assert the outcome. */
export async function submitConnection(page: Page, v: { key?: string; chat?: string; embedding?: string }) {
  const f = connectionInputs(page);
  if (v.key !== undefined) await f.key.fill(v.key);
  if (v.chat !== undefined) await f.chat.fill(v.chat);
  if (v.embedding !== undefined) await f.embedding.fill(v.embedding);
  await page.getByTestId("save-connection").click();
}

/** Opens Settings → AI connection and saves a working mock configuration through the three inputs. */
export async function connectViaForm(page: Page, v: { key?: string; chat?: string; embedding?: string } = {}) {
  await page.goto("/settings/providers");
  await page.waitForLoadState("networkidle"); // wait for hydration so typing isn't lost
  await submitConnection(page, { key: v.key ?? VALID_KEY, chat: v.chat ?? "mock-chat", embedding: v.embedding ?? "mock-embed" });
  await expect(page.getByRole("status").filter({ hasText: "Saved. Your connection works." })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("status-chat")).toHaveText(v.chat ?? "mock-chat");
}
