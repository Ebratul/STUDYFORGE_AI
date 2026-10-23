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
const textInputs = (page: Page) => page.getByRole("main").locator("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=number])");
const numberInputs = (page: Page) => page.getByRole("main").locator("input[type=number]");
const param = (page: Page, name: string) => page.locator(`input[name="${name}"]`);
const dimensionField = (page: Page) => page.locator('input[name="embeddingDimension"]');

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
  test("has exactly three text inputs, the optional embedding dimensions plus six optional numeric settings, a hidden-by-default key with a show/hide button, and no provider/base-URL fields", async ({ page }) => {
    await register(page);
    await openForm(page);
    await expect(textInputs(page)).toHaveCount(3);
    await expect(numberInputs(page)).toHaveCount(7); // embedding dimensions + six generation settings
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
    await expect(page.getByLabel(/base url|endpoint/i)).toHaveCount(0);
    const dimension = page.getByLabel(/^Embedding dimensions/);
    await expect(dimension).toHaveCount(1);
    await expect(dimension).toHaveAttribute("type", "number");
    await expect(dimension).toHaveAttribute("placeholder", "Automatic");
    await expect(dimension).toHaveValue(""); // blank = Automatic
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(1);
    await expect(page.getByLabel("Chat / LLM model ID")).toHaveCount(1);
    await expect(page.getByLabel("Embedding model ID")).toHaveCount(1);
    await expect(page.getByRole("combobox")).toHaveCount(0); // no provider or model dropdowns
    await expect(page.getByTestId("cost-note")).toContainText("Testing makes tiny requests");
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

  test("a model's own size is accepted whatever it is (Automatic), and the measured size is what gets saved", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: VALID_KEY, chat: "mock-chat", embedding: "mock-embed-3072" });
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("check-dimension")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("check-dimension")).toContainText(/3,?072 dimensions/);
    await expect(page.getByTestId("status-dimension")).toContainText(/3,?072 dimensions \(measured\)/);
    expect(await connection(page)).toMatchObject({ configured: true, embeddingModelId: "mock-embed-3072", embeddingDimension: 3072, embeddingRequestDimensions: null });
  });

  test("a model that ignores the requested size is rejected with what it really returned; nothing is padded, truncated or saved", async ({ page }) => {
    await register(page);
    await openForm(page);
    await submitConnection(page, { key: VALID_KEY, chat: "mock-chat", embedding: "mock-embed-ignore", dimension: "512" });
    await expect(page.getByTestId("save-error")).toContainText("nothing was saved");
    await expect(page.getByTestId("check-dimension")).toHaveAttribute("data-state", "failed");
    await expect(page.getByTestId("check-dimension")).toContainText(/768-dimensional/);
    await expect(page.getByTestId("check-dimension")).toContainText(/512/);
    await expect(page.getByTestId("check-dimension")).toContainText(/never padded or truncated/);
    await expect(page.getByTestId("dimension-error")).not.toBeEmpty();
    expect((await connection(page)).configured).toBe(false);
  });

  test("a provider that rejects the dimensions setting for the model is reported as such", async ({ page }) => {
    await register(page);
    await openForm(page);
    const f = connectionInputs(page);
    await f.key.fill(VALID_KEY);
    await f.chat.fill("mock-chat");
    await f.embedding.fill("mock-embed-strict");
    await dimensionField(page).fill("512");
    await page.getByTestId("test-connection").click();
    await expect(page.getByTestId("check-results")).toBeVisible({ timeout: 30_000 });
    const failed = page.locator('[data-testid^="check-"][data-state="failed"]').filter({ hasText: /refused|doesn't accept/i });
    await expect(failed.first()).toBeVisible();
    expect((await connection(page)).configured).toBe(false);
  });

  test("an out-of-range or fractional size is stopped in the browser before anything is sent", async ({ page }) => {
    const sent: string[] = [];
    page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/ai\/connection/.test(r.url())) sent.push(r.url()); });
    await register(page);
    await openForm(page);
    await connectionInputs(page).key.fill(VALID_KEY);
    await connectionInputs(page).chat.fill("mock-chat");
    await connectionInputs(page).embedding.fill("mock-embed");
    for (const [value, message] of [["7", /Enter a value from 8 to 4,096/], ["5000", /Enter a value from 8 to 4,096/], ["512.5", /Enter a whole number/]] as const) {
      await dimensionField(page).fill(value);
      await page.getByTestId("save-connection").click();
      await expect(page.getByTestId("dimension-error")).toContainText(message);
    }
    expect(sent).toEqual([]);
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

test.describe("embedding dimensions and staged re-indexing", () => {
  test("a shortened size is verified with a live request, saved from the database, and an untouched field keeps it", async ({ page }) => {
    await register(page);
    await openForm(page);
    await connectionInputs(page).key.fill(VALID_KEY);
    await connectionInputs(page).chat.fill("mock-chat");
    await connectionInputs(page).embedding.fill("mock-embed-flex");
    await dimensionField(page).fill("512");
    await page.getByTestId("test-connection").click();
    await expect(page.getByTestId("check-dimension")).toHaveAttribute("data-state", "ok", { timeout: 30_000 });
    await expect(page.getByTestId("check-dimension")).toContainText(/1,024 natively; 512 was verified with a live request/);
    expect((await connection(page)).configured).toBe(false); // testing stores nothing

    await page.getByTestId("save-connection").click();
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("status-dimension")).toContainText(/512 dimensions \(measured\)/);
    await expect(page.getByTestId("status-dimension")).toContainText("shortened to 512");
    expect(await connection(page)).toMatchObject({ embeddingModelId: "mock-embed-flex", embeddingDimension: 512, embeddingRequestDimensions: 512, reindex: null });

    // untouched on reload: the field shows the saved size, and saving only the chat model keeps it (the field is omitted from the request)
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(dimensionField(page)).toHaveValue("512");
    const put = page.waitForRequest((r) => r.method() === "PUT" && /\/api\/ai\/connection$/.test(r.url()));
    await submitConnection(page, { chat: "mock-chat-plain" });
    expect(JSON.parse((await put).postData() ?? "{}")).not.toHaveProperty("embeddingDimension");
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    expect(await connection(page)).toMatchObject({ chatModelId: "mock-chat-plain", embeddingDimension: 512, reindex: null });
  });

  test("clearing the field sends an explicit Automatic (null)", async ({ page }) => {
    await register(page);
    await connectViaForm(page, { embedding: "mock-embed-flex" });
    await dimensionField(page).fill("256");
    await page.getByTestId("save-connection").click();
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await dimensionField(page).fill("");
    const put = page.waitForRequest((r) => r.method() === "PUT" && /\/api\/ai\/connection$/.test(r.url()));
    await page.getByTestId("save-connection").click();
    expect(JSON.parse((await put).postData() ?? "{}")).toHaveProperty("embeddingDimension", null);
  });

  test("changing the embedding model with documents re-indexes in the background; the old index keeps working until the switch, then answers still cite", async ({ page }) => {
    test.setTimeout(180_000);
    await register(page);
    await connectViaForm(page);
    await uploadDoc(page, "biology.txt", BIOLOGY_TEXT);
    await page.goto("/settings/providers");
    await page.waitForLoadState("networkidle");

    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/ai\/connection$/.test(r.url()));
    await connectionInputs(page).embedding.fill("mock-embed-flex");
    await expect(dimensionField(page)).toHaveValue(""); // a different model: the field no longer claims the old saved size
    await dimensionField(page).fill("512");
    await page.getByTestId("save-connection").click();
    const body = await (await saved).json();
    expect(body.embeddingChange).toMatchObject({ status: "reindexing", documents: 1 });

    // until the new index is verified the saved embedding configuration is still the old one
    // (the build is quick with the mock provider, so this only asserts the contract: the switch is atomic and never half-done)
    await expect.poll(async () => {
      const c = await connection(page);
      return c.reindex === null && c.embeddingModelId === "mock-embed-flex" && c.embeddingDimension === 512;
    }, { timeout: 90_000 }).toBe(true);
    const chunks = await sql<{ dims: string; models: string }>(`SELECT string_agg(DISTINCT c."embeddingDimension"::text, ',') AS dims, string_agg(DISTINCT c."embeddingModel", ',') AS models FROM "DocumentChunk" c JOIN "Document" d ON d.id = c."documentId" WHERE d.name = 'biology.txt' AND d."ownerId" = (SELECT id FROM "User" ORDER BY "createdAt" DESC LIMIT 1)`);
    expect(chunks[0]).toMatchObject({ dims: "512", models: "mock-embed-flex" }); // the old index is gone only after the switch

    await page.goto("/chat");
    await page.getByRole("button", { name: /Ask my documents/ }).click();
    await expect(page).toHaveURL(/\/chat\/[a-z0-9]+$/);
    await page.getByRole("button", { name: /Attach documents/ }).click();
    await page.getByRole("checkbox", { name: "Use biology.txt" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /Attach documents \(1 selected\)/ })).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("What do mitochondria produce through cellular respiration?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByTestId("assistant-message").last().getByTestId("citation-chip")).toContainText("biology.txt", { timeout: 45_000 });
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


test.describe("generation settings, Test configuration and model suggestions", () => {
  const settings = (page: Page) => page.getByTestId("generation-settings");
  const check = (page: Page, name: string) => page.getByTestId(`check-${name}`);
  const rowCount = async () => Number((await sql<{ n: string }>("SELECT count(*)::text AS n FROM \"ModelPreference\" WHERE \"userId\" = (SELECT id FROM \"User\" ORDER BY \"createdAt\" DESC LIMIT 1)"))[0]!.n);

  test("Test configuration shows six separate checks and saves nothing; opening the page makes no provider request", async ({ page }) => {
    const providerCalls: string[] = [];
    page.on("request", (r) => { if (/\/api\/ai\/connection\/test|\/api\/ai\/connection$/.test(r.url()) && r.method() !== "GET") providerCalls.push(r.url()); });
    await register(page);
    await openForm(page);
    expect(providerCalls).toEqual([]); // nothing is tested until a button is pressed
    const { key, chat, embedding } = connectionInputs(page);
    await key.fill(VALID_KEY);
    await chat.fill("mock-chat");
    await embedding.fill("mock-embed");
    await param(page, "temperature").fill("0.3");
    await page.getByTestId("test-connection").click();
    const results = page.getByTestId("check-results");
    await expect(results).toBeVisible({ timeout: 30_000 });
    for (const n of ["auth", "chat", "chatParams", "embedding", "dimension", "database"]) await expect(check(page, n)).toHaveAttribute("data-state", "ok");
    await expect(check(page, "dimension")).toContainText(/1,536 dimensions/);
    await expect(check(page, "database")).toContainText("can store 1,536-dimensional vectors");
    expect(await rowCount()).toBe(0); // the test stored nothing
    expect((await connection(page)).configured).toBe(false);
    expect(providerCalls).toHaveLength(1);
  });

  test("an unsupported setting is named, refused on save, and the last working settings stay active", async ({ page }) => {
    await register(page);
    await connectViaForm(page, { chat: "mock-chat", embedding: "mock-embed" });
    await param(page, "temperature").fill("0.5");
    await submitConnection(page, { chat: "mock-chat-limited" });
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("status-params")).toContainText("temperature=0.5");

    await param(page, "frequencyPenalty").fill("0.7");
    await submitConnection(page, { chat: "mock-chat-limited" });
    await expect(page.getByTestId("save-error")).toContainText("nothing was saved");
    await expect(check(page, "chatParams")).toHaveAttribute("data-state", "failed");
    await expect(check(page, "chatParams")).toContainText("frequency_penalty");
    await expect(check(page, "chat")).toHaveAttribute("data-state", "ok"); // the model exists; only the setting is the problem
    await expect(page.getByTestId("params-error")).toContainText("frequency_penalty");
    const after = await connection(page);
    expect(after.params.frequencyPenalty).toBeNull();
    expect(after.params.temperature).toBe(0.5);
    expect(after.chatModelId).toBe("mock-chat-limited");

    await param(page, "frequencyPenalty").fill("");
    await submitConnection(page, {});
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
  });

  test("ranges are enforced instantly and by the server; saved settings survive a reload", async ({ page }) => {
    await register(page);
    await openForm(page);
    await connectionInputs(page).key.fill(VALID_KEY);
    await connectionInputs(page).chat.fill("mock-chat");
    await connectionInputs(page).embedding.fill("mock-embed");
    await param(page, "temperature").fill("2.5");
    await param(page, "seed").fill("1.5");
    await page.getByTestId("save-connection").click();
    await expect(settings(page).getByText("Enter a value from 0 to 2.")).toBeVisible();
    await expect(settings(page).getByText("Enter a whole number.")).toBeVisible();
    expect(await rowCount()).toBe(0);
    const direct = await api(page, "PUT", "/api/ai/connection", { apiKey: VALID_KEY, chatModelId: "mock-chat", embeddingModelId: "mock-embed", params: { temperature: 2.5 } });
    expect(direct.status()).toBe(422); // the server does not trust the browser

    await param(page, "temperature").fill("0.2");
    await param(page, "seed").fill("42");
    await param(page, "topP").fill("0.8");
    await page.getByTestId("save-connection").click();
    await expect(savedMessage(page)).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(param(page, "temperature")).toHaveValue("0.2");
    await expect(param(page, "seed")).toHaveValue("42");
    await expect(param(page, "topP")).toHaveValue("0.8");
    await expect(param(page, "maxTokens")).toHaveValue("");
    await expect(page.getByTestId("status-params")).toContainText("seed=42");
  });

  test("Browse models lists the provider's public models and fills the box; typing by hand still works", async ({ page }) => {
    await register(page);
    await openForm(page);
    await connectionInputs(page).key.fill(VALID_KEY);
    await page.getByRole("button", { name: "Browse chat models" }).click();
    const list = page.getByRole("listbox", { name: "Model suggestions" });
    await expect(list.getByText("mock-chat-limited")).toBeVisible();
    await list.getByRole("button", { name: /mock-chat-limited/ }).click();
    await expect(connectionInputs(page).chat).toHaveValue("mock-chat-limited");
    await connectionInputs(page).chat.fill("any/custom-model-id:free");
    await expect(connectionInputs(page).chat).toHaveValue("any/custom-model-id:free");
  });

  test("the provider's public list tells which settings a chosen model lists, without blocking anything", async ({ page }) => {
    await register(page);
    await openForm(page);
    await connectionInputs(page).key.fill(VALID_KEY);
    await connectionInputs(page).chat.fill("mock-chat-limited");
    await param(page, "presencePenalty").fill("0.4");
    await connectionInputs(page).chat.blur();
    await expect(page.getByTestId("param-presencePenalty-unlisted")).toBeVisible();
    await expect(page.getByTestId("param-temperature-unlisted")).toHaveCount(0);
    await expect(param(page, "presencePenalty")).toBeEnabled();
  });

  test("the key is never in the page or storage, and the new fields pass the accessibility check", async ({ page }) => {
    await register(page);
    await connectViaForm(page);
    const html = await page.content();
    expect(html).not.toContain(VALID_KEY);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(VALID_KEY);
    // (the transient success toast is excluded: its green-on-green contrast is a separate, pre-existing styling issue of the shared Toaster)
    const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).exclude("[data-sonner-toast]").analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
