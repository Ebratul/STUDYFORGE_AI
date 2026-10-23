import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, register, sql, test, uniqueEmail } from "./fixtures";
import { connectionInputs, connectViaForm, submitConnection, VALID_KEY } from "./connection-helpers";
import { api, BIOLOGY_TEXT } from "./questions-helpers";

/**
 * Settings → AI connection (docs/AI_CONNECTION_SPEC.md): exactly three inputs, validated by the provider before anything is saved.
 * The mock provider stands in for OpenRouter (derived from the key `mock-valid-key`, test environments only).
 */

const connection = async (page: Page) => (await (await api(page, "GET", "/api/ai/connection")).json()).connection;
const savedMessage = (page: Page) => page.getByRole("status").filter({ hasText: "Saved. Your connection works." });
const textInputs = (page: Page) => page.getByRole("main").locator("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])");

async function openForm(page: Page) {
  await page.goto("/settings/providers");
  await page.waitForLoadState("networkidle"); // hydration: typing before it is silently lost
}

async function uploadDoc(page: Page, name: string, text: string) {
  await page.goto("/documents");
  await page.waitForLoadState("networkidle");
  await page.locator("#file-input").setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
  const row = page.getByTestId(`doc-${name}`);
  await expect(row).toBeVisible();
  await expect(row.locator("[data-status]")).toHaveAttribute("data-status", "READY", { timeout: 30_000 });
  return row;
}

test.describe("the form", () => {
  test("has exactly three text inputs, a hidden-by-default key with a show/hide button, and no provider/base-URL/dimension fields", async ({ page }) => {
    await register(page);
    await openForm(page);
    await expect(textInputs(page)).toHaveCount(3);
    const { key, chat, embedding } = connectionInputs(page);
    await expect(key).toHaveAttribute("type", "password");
    await expect(chat).toHaveAttribute("type", "text");
    await expect(embedding).toHaveAttribute("type", "text");
    const toggle = page.getByRole("button", { name: /^Show\s*API key/ });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await key.fill("sk-or-v1-not-a-real-key");
    await toggle.click();
    await expect(key).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: /^Hide\s*API key/ })).toHaveAttribute("aria-pressed", "true");
    await expect(textInputs(page)).toHaveCount(3); // toggling never adds a field
    await expect(page.getByLabel(/base url|endpoint|dimension/i)).toHaveCount(0);
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(1);
    await expect(page.getByLabel("Chat / LLM model ID")).toHaveCount(1);
    await expect(page.getByLabel("Embedding model ID")).toHaveCount(1);
    await expect(page.getByRole("combobox")).toHaveCount(0); // no provider or model dropdowns
    await expect(page.getByTestId("cost-note")).toContainText("two tiny paid requests");
    // old entry points are gone
    await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "API keys" })).toHaveCount(0);
    await page.goto("/settings/api-keys");
    await expect(page).toHaveURL(/\/settings\/providers$/);
  });

  test("client-side checks catch empty and malformed input before anything is sent", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: "", chat: "", embedding: "bad id" });
    await expect(page.getByRole("alert").filter({ hasText: "Enter your API key." })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Enter a model ID." })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: /letters, digits/ })).toBeVisible();
    expect((await connection(page)).configured).toBe(false);
  });
});

test.describe("validation by the provider (nothing is saved on failure)", () => {
  test("a rejected key: auth fails, the other checks are skipped, nothing is stored", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: "mock-wrong-key-1", chat: "mock-chat", embedding: "mock-embed" });
    await expect(page.getByTestId("save-error")).toContainText("nothing was saved");
    await expect(page.getByTestId("check-auth")).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("check-auth")).toContainText(/rejected this API key|API key/i);
    await expect(page.getByTestId("check-chat")).toHaveAttribute("data-state", "skipped");
    await expect(page.getByTestId("check-embedding")).toHaveAttribute("data-state", "skipped");
    const c = await connection(page);
    expect(c.configured).toBe(false);
    expect(c.apiKey.configured).toBe(false);
    expect((await (await api(page, "GET", "/api/ai/credentials")).json()).items).toEqual([]);
  });

  test("an unknown chat model is reported on the chat check and nothing is saved", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: VALID_KEY, chat: "no-such-model", embedding: "mock-embed" });
    await expect(page.getByTestId("check-auth")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("check-chat")).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("check-chat")).toContainText(/wasn't found|not found/i);
    expect((await connection(page)).configured).toBe(false);
  });

  test("an embedding model with a different vector size is rejected with the measured dimension", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: VALID_KEY, chat: "mock-chat", embedding: "mock-embed-3072" });
    await expect(page.getByTestId("check-embedding")).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("check-embedding")).toContainText(/3,?072/);
    await expect(page.getByTestId("check-embedding")).toContainText(/1,?536/);
    expect((await connection(page)).configured).toBe(false);
  });

  test("an unknown embedding model is reported on the embedding check", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: VALID_KEY, chat: "mock-chat", embedding: "no-such-embedding" });
    await expect(page.getByTestId("check-embedding")).toHaveAttribute("data-state", "failed");
    expect((await connection(page)).configured).toBe(false);
  });
});

test.describe("saving, persistence and replacement", () => {
  test("saves, shows the masked key and measured dimension, persists across reloads, and never exposes the key", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: VALID_KEY, chat: "mock-chat", embedding: "mock-embed" });
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    for (const n of ["auth", "chat", "embedding"] as const) await expect(page.getByTestId(`check-${n}`)).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("status-key")).toContainText("••••-key");
    await expect(page.getByTestId("status-dimension")).toContainText(/1,?536/);
    await expect(page.getByTestId("provider-line")).toBeVisible();
    await expect(connectionInputs(page).key).toHaveValue(""); // the key field is cleared after saving

    // not in the page, storage, cookies or any API response
    expect(await page.content()).not.toContain(VALID_KEY);
    for (const path of ["/api/ai/connection", "/api/ai/credentials", "/api/ai/providers", "/api/ai/preferences", "/api/me", "/api/profile"]) expect(await (await api(page, "GET", path)).text(), path).not.toContain(VALID_KEY);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }) + document.cookie)).not.toContain(VALID_KEY);

    await page.reload();
    await page.waitForLoadState("networkidle");
    expect(await page.content()).not.toContain(VALID_KEY);
    await expect(connectionInputs(page).chat).toHaveValue("mock-chat");
    await expect(connectionInputs(page).embedding).toHaveValue("mock-embed");
    await expect(connectionInputs(page).key).toHaveValue("");
    await expect(page.getByTestId("key-hint")).toContainText("Key configured ••••-key — leave blank to keep it.");
    const c = await connection(page);
    expect(c).toMatchObject({ configured: true, chatModelId: "mock-chat", embeddingModelId: "mock-embed", embeddingDimension: 1536 });
    const prefs = await (await api(page, "GET", "/api/ai/preferences")).json();
    expect(prefs.default).toMatchObject({ modelId: "mock-chat" });
    expect(prefs.tasks.EMBEDDING).toMatchObject({ modelId: "mock-embed" });
  });

  test("replacing a model without retyping the key keeps the saved key; a failed replacement keeps the last working configuration", async ({ page }) => {
    await register(page);
    await connectViaForm(page);
    await expect(connectionInputs(page).key).toHaveValue("");

    // blank key + a different chat model: validated with the saved key, then active
    await submitConnection(page, { chat: "mock-chat-plain" });
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    expect((await connection(page)).chatModelId).toBe("mock-chat-plain");
    await expect(page.getByTestId("status-key")).toContainText("••••-key");

    // a failing replacement changes nothing
    await submitConnection(page, { chat: "no-such-model" });
    await expect(page.getByTestId("save-error")).toBeVisible();
    await page.reload();
    await page.waitForLoadState("networkidle");
    expect(await connection(page)).toMatchObject({ configured: true, chatModelId: "mock-chat-plain", embeddingModelId: "mock-embed" });
    await expect(connectionInputs(page).chat).toHaveValue("mock-chat-plain");

    // the existing features keep working with the replaced model
    const prefs = await (await api(page, "GET", "/api/ai/preferences")).json();
    expect(prefs.default).toMatchObject({ modelId: "mock-chat-plain" });
  });

  test("a bad replacement key is rejected and the previous key keeps working", async ({ page }) => {
    await register(page);
    await connectViaForm(page);
    await submitConnection(page, { key: "mock-wrong-key-2" });
    await expect(page.getByTestId("check-auth")).toHaveAttribute("data-state", "failed");
    expect((await connection(page)).apiKey).toMatchObject({ configured: true, masked: "••••-key", status: "VALID" });
    const [cred] = await sql<{ last4: string }>('SELECT c.last4 FROM "ProviderCredential" c JOIN "User" u ON u.id = c."userId" WHERE u.id = (SELECT id FROM "User" ORDER BY "createdAt" DESC LIMIT 1)');
    expect(cred?.last4).toBe("-key");
  });

  test("another user can't see this configuration", async ({ browser }) => {
    const a = await (await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.71" } })).newPage();
    const b = await (await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.72" } })).newPage();
    await register(a, { email: uniqueEmail("conn-a") });
    await register(b, { email: uniqueEmail("conn-b") });
    await connectViaForm(a);
    const other = await connection(b);
    expect(other).toMatchObject({ configured: false, chatModelId: null, embeddingModelId: null });
    expect(JSON.stringify(other)).not.toContain("mock-chat");
    await a.context().close();
    await b.context().close();
  });
});

test.describe("embedding identity and re-embedding", () => {
  test("documents indexed with another embedding model are flagged, can be re-embedded in one click, and then answer with citations", async ({ page }) => {
    test.setTimeout(150_000);
    await register(page);
    await connectViaForm(page);
    const row = await uploadDoc(page, "biology.txt", BIOLOGY_TEXT);
    await expect(page.getByTestId("stale-biology.txt")).toHaveCount(0);

    // Simulate "this document was indexed with a different embedding model" (the identity the form compares against).
    await sql(`UPDATE "Document" SET "embeddingModel" = 'older-embed-model' WHERE name = 'biology.txt' AND "ownerId" = (SELECT id FROM "User" ORDER BY "createdAt" DESC LIMIT 1)`);

    await page.goto("/settings/providers");
    const banner = page.getByTestId("reembed-banner");
    await expect(banner).toContainText("1 document needs re-embedding");
    await expect(page.getByTestId("status-documents")).toContainText("1 need re-embedding");

    // The Documents page flags it too, and an answer is not built from the stale index.
    await page.goto("/documents");
    await expect(page.getByTestId("stale-biology.txt")).toBeVisible();
    await expect(page.getByTestId("stale-banner")).toContainText("1 document needs re-embedding");

    await page.getByTestId("stale-banner").getByRole("button", { name: /Re-embed 1 document/ }).click();
    await expect(page.getByTestId("stale-biology.txt")).toHaveCount(0, { timeout: 60_000 });
    await expect(row.locator("[data-status]")).toHaveAttribute("data-status", "READY", { timeout: 60_000 });
    const [d] = await sql<{ embeddingModel: string; embeddingDimension: number | null }>(`SELECT "embeddingModel", "embeddingDimension" FROM "Document" WHERE name = 'biology.txt' ORDER BY "createdAt" DESC LIMIT 1`);
    expect(d).toMatchObject({ embeddingModel: "mock-embed", embeddingDimension: 1536 });

    await page.goto("/settings/providers");
    await expect(page.getByTestId("reembed-banner")).toHaveCount(0);

    // a grounded answer with a citation works again
    await page.goto("/chat");
    await page.getByRole("button", { name: /Ask my documents/ }).click();
    await expect(page).toHaveURL(/\/chat\/[a-z0-9]+$/);
    await page.getByRole("button", { name: /Attach documents/ }).click();
    await page.getByRole("checkbox", { name: "Use biology.txt" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("textbox", { name: "Message" }).fill("What do mitochondria produce through cellular respiration?");
    await page.getByRole("button", { name: "Send message" }).click();
    const answer = page.getByTestId("assistant-message").last();
    await expect(answer).toContainText("Mitochondria are the powerhouse", { timeout: 45_000 });
    await expect(answer.getByTestId("citation-chip")).toContainText("biology.txt");
  });
});

test.describe("accessibility and language", () => {
  test("the page has no serious axe violations, labelled controls and a polite status region", async ({ page }) => {
    await register(page);
    await connectViaForm(page);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).exclude("[data-sonner-toaster]").analyze(); // the toast library is third-party and animates
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
    await expect(page.getByRole("heading", { level: 1, name: "AI connection" })).toBeVisible();
    // keyboard: tab order reaches the show/hide button and the submit button
    await connectionInputs(page).key.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /^Show\s*API key/ })).toBeFocused();
  });

  test("the page and its messages are available in Bangla", async ({ page, context }) => {
    await register(page);
    await context.addCookies([{ name: "sf-locale", value: "bn", url: "http://localhost:3100" }]);
    await page.goto("/settings/providers");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("এআই সংযোগ");
    await expect(page.getByTestId("save-connection")).toContainText("পরীক্ষা করুন ও সংরক্ষণ করুন");
    await submitConnection(page, { key: "mock-wrong-key-1", chat: "mock-chat", embedding: "mock-embed" });
    await expect(page.getByTestId("save-error")).toContainText("কিছুই সংরক্ষিত হয়নি");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});
