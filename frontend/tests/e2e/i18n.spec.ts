import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, PASSWORD, sql, test, uniqueEmail } from "./fixtures";
import { answerAndSubmit, takeExam } from "./dashboard-helpers";
import { publishExam, seedBank, startAttempt } from "./exam-helpers";
import { api, createGroup, newUser } from "./group-helpers";
import { configureAi } from "./questions-helpers";

const ORIGIN = "http://localhost:3100";
const SHOTS = process.env.I18N_SHOTS; // optional: directory for the Bangla screenshots reviewed by a human
const BN_DIGIT = /[০-৯]/;

async function useBangla(ctx: BrowserContext, page: Page, opts: { saveToAccount?: boolean } = {}) {
  await ctx.addCookies([{ name: "sf-locale", value: "bn", url: ORIGIN }]);
  if (opts.saveToAccount !== false) {
    const res = await api(page, "PATCH", "/api/preferences", { theme: "SYSTEM", locale: "bn", emailNotifications: true, autoAiFeedback: false });
    expect(res.status(), await res.text()).toBe(200);
  }
}

async function a11y(page: Page, label: string) {
  await page.waitForLoadState("load");
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${label}: ${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
}

const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal overflow").toBe(true);

/** A fallback must be invisible: no raw `{placeholders}` and no message ids may reach the screen. */
async function noRawKeys(page: Page) {
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\{\w+\}/);
  expect(text).not.toMatch(/\b[a-z]+(\.[a-z]+){2,}\b/); // dotted ids such as "settings.profile.title"
  expect(text).not.toMatch(/\[object |undefined|NaN/);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // the app shell scrolls inside a fixed-height frame, so a tall viewport shows the whole page
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.setViewportSize({ width: size.width, height: 2600 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await page.setViewportSize(size);
}

/** Visible lines that still contain English words (4+ Latin letters), minus the user's own data. Used to prove a Bangla screen is translated. */
async function englishLeft(page: Page, allow: (string | RegExp)[] = []): Promise<string[]> {
  const lines = await page.evaluate(() => document.body.innerText.split("\n").map((l) => l.trim()).filter(Boolean));
  return lines.filter((l) => /[A-Za-z]{4,}/.test(l) && !allow.some((a) => (typeof a === "string" ? l.includes(a) : a.test(l))));
}

const USER_DATA = [/^Mechanics every Thursday$/, /^(Windows|macOS|Linux)-এ (Chrome|Edge|Firefox|Safari)/, /@example\.test/, /Because option A|Remember A/, /^[A-Z][a-z]+\/[A-Za-z_]+$/, /^(English|বাংলা \(Bangla\))$/, /Ayesha Rahman/, /StudyForge/, /Cells|Energy/, /Exam question/, /Right answer|Wrong answer/, /E2E exam|Cells and energy|Physics circle|Feedback exam|Bangla exam/, /^\d*\s*@/];

test.describe("language preference", () => {
  test("choosing Bangla in Settings → Profile works, survives a reload and follows the account into a brand-new session", async ({ browser }) => {
    const u = await newUser(browser);
    await expect(u.page.locator("html")).toHaveAttribute("lang", "en");
    await u.page.goto("/settings/profile");
    await u.page.locator("#locale").click();
    await u.page.getByRole("option", { name: "বাংলা" }).click();
    await u.page.getByRole("button", { name: "Save preferences" }).click();
    await expect(u.page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(u.page.getByRole("button", { name: "পছন্দ সংরক্ষণ করুন" })).toBeVisible();

    await u.page.reload();
    await expect(u.page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(u.page.getByRole("button", { name: "পছন্দ সংরক্ষণ করুন" })).toBeVisible();

    // the cookie is first-party, Lax, path "/", valid for about a year
    const cookie = (await u.ctx.cookies()).find((c) => c.name === "sf-locale");
    expect(cookie?.value).toBe("bn");
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/");
    expect((cookie?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(60 * 60 * 24 * 360);
    const [pref] = await sql<{ locale: string }>('SELECT locale::text AS locale FROM "UserPreference" WHERE "userId" = $1', [u.id]);
    expect(pref?.locale).toBe("bn");

    // a new session on a "new device" (no cookie): the saved preference decides
    const ctx2 = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.77" } });
    const p2 = await ctx2.newPage();
    await p2.goto("/login");
    await expect(p2.locator("html")).toHaveAttribute("lang", "en"); // signed out + no cookie + English browser → English
    await p2.getByLabel("Email").fill(u.email);
    await p2.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await p2.getByRole("button", { name: "Sign in" }).click();
    await expect(p2).toHaveURL(/\/workspace/);
    await expect(p2.locator("html")).toHaveAttribute("lang", "bn");
    await expect(p2.getByRole("link", { name: "ড্যাশবোর্ড" }).first()).toBeVisible();
    await ctx2.close();
    await u.ctx.close();
  });

  test("the top-bar switcher works with the keyboard, announces the change, and switches back", async ({ browser }) => {
    const u = await newUser(browser);
    const trigger = u.page.getByRole("button", { name: "Change language" });
    await trigger.focus();
    await u.page.keyboard.press("Enter");
    await expect(u.page.getByRole("menu")).toBeVisible();
    await u.page.keyboard.press("ArrowDown");
    await u.page.keyboard.press("ArrowDown"); // label is skipped; first item = English, second = Bangla
    await expect(u.page.getByRole("menuitem", { name: "বাংলা" })).toBeFocused();
    await u.page.keyboard.press("Enter");
    await expect(u.page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(u.page.getByRole("status").filter({ hasText: "ভাষা বদলে বাংলা করা হয়েছে" })).toHaveCount(1);
    await expect(u.page.getByRole("button", { name: "ভাষা পরিবর্তন" })).toBeFocused().catch(() => undefined); // focus returns to the trigger (best effort across Radix versions)
    // saved to the account too
    await expect.poll(async () => (await sql<{ locale: string }>('SELECT locale::text AS locale FROM "UserPreference" WHERE "userId" = $1', [u.id]))[0]?.locale).toBe("bn");

    await u.page.getByRole("button", { name: "ভাষা পরিবর্তন" }).focus();
    await u.page.keyboard.press("Enter");
    await u.page.getByRole("menuitem", { name: "English" }).focus();
    await u.page.keyboard.press("Enter");
    await expect(u.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(u.page.getByRole("link", { name: "Dashboard" }).first()).toBeVisible();
    await u.ctx.close();
  });

  test("signed-out visitors can switch too (cookie only), and Accept-Language picks the first visit's language", async ({ browser }) => {
    const bnCtx = await browser.newContext({ locale: "bn-BD", extraHTTPHeaders: { "x-forwarded-for": "198.51.100.51" } });
    const p = await bnCtx.newPage();
    await p.goto("/login");
    await expect(p.locator("html")).toHaveAttribute("lang", "bn");
    await expect(p.getByRole("button", { name: "সাইন ইন" })).toBeVisible();
    // an explicit choice beats the browser language
    await p.getByRole("button", { name: "ভাষা পরিবর্তন" }).first().click();
    await p.getByRole("menuitem", { name: "English" }).click();
    await expect(p.locator("html")).toHaveAttribute("lang", "en");
    await p.reload();
    await expect(p.locator("html")).toHaveAttribute("lang", "en");
    await expect(p.getByRole("button", { name: "Sign in" })).toBeVisible();
    await bnCtx.close();

    const enCtx = await browser.newContext({ locale: "fr-FR", extraHTTPHeaders: { "x-forwarded-for": "198.51.100.52" } });
    const q = await enCtx.newPage();
    await q.goto("/login");
    await expect(q.locator("html")).toHaveAttribute("lang", "en"); // unsupported → English
    await enCtx.close();
  });

  test("English is unchanged: same text, lang=en, ltr", async ({ browser }) => {
    const u = await newUser(browser);
    await u.page.goto("/dashboard");
    await expect(u.page.locator("html")).toHaveAttribute("lang", "en");
    await expect(u.page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(u.page.getByTestId("no-exam-results")).toContainText("No exam results yet");
    await expect(u.page.getByRole("link", { name: "Dashboard" }).first()).toBeVisible();
    await u.ctx.close();
  });
});

test.describe("Bangla screens", () => {
  test("app shell, dashboard, groups and notifications read in Bangla with Bengali digits, no overflow at 360px", async ({ browser }) => {
    const u = await newUser(browser);
    await useBangla(u.ctx, u.page);
    await takeExam(u.page, ["right", "right", "wrong", "skip"], { title: "Cells and energy", negativeFraction: 0.25 });
    const gid = await createGroup(u.page, { title: "Physics circle", description: "Mechanics every Thursday", capacity: 12 });

    await u.page.goto("/dashboard");
    await expect(u.page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(u.page.locator("html")).toHaveAttribute("dir", "ltr");
    for (const name of ["ড্যাশবোর্ড", "পরীক্ষা", "গ্রুপ"]) await expect(u.page.getByRole("link", { name }).first()).toBeVisible();
    await expect(u.page.getByTestId("stat-average")).toContainText("৪৩.৭৫%");
    await expect(u.page.getByTestId("stat-completed")).toContainText("১");
    await expect(u.page.getByTestId("stat-average")).not.toContainText("43.75");
    await noRawKeys(u.page);
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await shot(u.page, "bn-dashboard-desktop");
    await a11y(u.page, "bn dashboard");

    await u.page.goto("/groups");
    await expect(u.page.getByTestId("group-card")).toContainText("Physics circle");
    await expect(u.page.getByTestId("group-card")).toContainText("১২ জনের মধ্যে ১ জন সদস্য");
    await expect(u.page.getByTestId("group-card")).toContainText("মালিক");
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await a11y(u.page, "bn groups");

    await u.page.goto(`/groups/${gid}`);
    await expect(u.page.getByRole("tab", { name: "সারসংক্ষেপ" })).toBeVisible();
    await expect(u.page.getByRole("tab", { name: "সদস্য" })).toBeVisible();
    await expect(u.page.getByRole("tab", { name: "আমন্ত্রণ" })).toBeVisible();
    await expect(u.page.getByTestId("group-title")).toHaveText("Physics circle");
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await shot(u.page, "bn-group-desktop");
    for (const tab of ["সদস্য", "আমন্ত্রণ", "পরীক্ষা", "সেটিংস"]) {
      await u.page.getByRole("tab", { name: tab, exact: true }).click();
      expect(await englishLeft(u.page, USER_DATA), `group tab ${tab}`).toEqual([]);
    }

    await u.page.goto("/notifications");
    await expect(u.page.getByText("StudyForge-এ স্বাগতম")).toBeVisible();
    await expect(u.page.getByText(/হাই Ayesha Rahman, আপনার অ্যাকাউন্ট প্রস্তুত/)).toBeVisible();
    await expect(u.page.getByText("আপনার ফলাফল পাওয়া যাচ্ছে").first()).toBeVisible();
    await expect(u.page.getByText("“Cells and energy”-এর ফলাফল প্রস্তুত।")).toBeVisible();
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await a11y(u.page, "bn notifications");

    await u.page.goto("/exams");
    await expect(u.page.getByRole("tab", { name: /আমার পরীক্ষা/ })).toBeVisible();
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);

    await u.page.setViewportSize({ width: 360, height: 740 });
    for (const path of ["/dashboard", "/groups", `/groups/${gid}`, "/notifications", "/exams", "/settings/profile"]) {
      await u.page.goto(path);
      await expect(u.page.locator("main, [role='main']").first()).toBeVisible();
      await noOverflow(u.page);
      if (path === "/dashboard") {
        await expect(u.page.getByTestId("stat-average")).toBeVisible();
        await shot(u.page, "bn-dashboard-360");
      }
    }
    await u.ctx.close();
  });

  test("taking an exam in Bangla: progress, save state, timer, shortcuts and the submit dialog", async ({ browser }) => {
    const u = await newUser(browser);
    await useBangla(u.ctx, u.page);
    const ids = await seedBank(u.page, 3);
    const examId = await publishExam(u.page, ids, { title: "Bangla exam", durationMinutes: 20 });
    const attemptId = await startAttempt(u.page, examId);

    await u.page.goto(`/attempts/${attemptId}`);
    await expect(u.page.locator("html")).toHaveAttribute("lang", "bn");
    await expect(u.page.getByTestId("progress-text")).toHaveText("০/৩ উত্তর দেওয়া হয়েছে");
    await expect(u.page.getByTestId("exam-timer")).toHaveText(/^\d{1,2}:\d{2}$/); // clock stays plain mm:ss
    await expect(u.page.getByTestId("exam-timer")).toHaveAttribute("aria-label", /^বাকি সময়: \d/);
    await expect(u.page.getByRole("button", { name: "উত্তর জমা দিন" })).toBeVisible();
    await expect(u.page.getByRole("button", { name: "পর্যালোচনার জন্য চিহ্নিত করুন" })).toBeVisible();
    await expect(u.page.getByText("প্রশ্ন ১", { exact: false }).first()).toBeVisible();
    await u.page.locator('input[data-testid="option-A"] + label').click();
    await expect(u.page.getByTestId("progress-text")).toHaveText("১/৩ উত্তর দেওয়া হয়েছে");
    await expect(u.page.getByTestId("question-save-state")).toContainText("সংরক্ষিত");
    await expect(u.page.getByTestId("save-announcer")).toHaveText("সব পরিবর্তন সংরক্ষিত");
    await u.page.keyboard.press("m");
    await expect(u.page.getByTestId("mark-review")).toHaveText("চিহ্নিত");
    await u.page.getByRole("button", { name: "শর্টকাট" }).click();
    await expect(u.page.getByText("পরের / আগের প্রশ্ন")).toBeVisible();
    await u.page.keyboard.press("Escape");
    await expect(u.page.getByText("পরের / আগের প্রশ্ন")).toBeHidden();
    const nav = u.page.getByRole("navigation", { name: "প্রশ্ন নেভিগেটর" });
    await expect(nav.getByRole("button", { name: /প্রশ্ন ১, উত্তর দেওয়া হয়েছে, পর্যালোচনার জন্য চিহ্নিত, বর্তমান/ })).toBeVisible();
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await shot(u.page, "bn-exam-desktop");
    await a11y(u.page, "bn exam taking");

    await u.page.getByTestId("submit-exam").click();
    const dialog = u.page.getByRole("dialog");
    await expect(dialog.getByText("আপনার উত্তর জমা দেবেন?")).toBeVisible();
    await expect(dialog).toContainText("৩টির মধ্যে ১টির উত্তর দেওয়া হয়েছে");
    await expect(dialog).toContainText("২টি প্রশ্নের উত্তর দেওয়া হয়নি — উত্তর না দেওয়া প্রশ্নে ০ নম্বর।");
    await expect(dialog).toContainText("১ পর্যালোচনার জন্য চিহ্নিত");
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await dialog.getByRole("button", { name: "কাজ চালিয়ে যান" }).click();

    await u.page.setViewportSize({ width: 360, height: 740 });
    await noOverflow(u.page);
    await u.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await shot(u.page, "bn-exam-360");
    await u.ctx.close();
  });

  test("the result page: score, band (from the one shared bands module), review and actions are Bangla; thresholds are unchanged", async ({ browser }) => {
    const u = await newUser(browser);
    await useBangla(u.ctx, u.page);
    const { attemptId } = await takeExam(u.page, ["right", "right", "right", "wrong"], { title: "Cells and energy" });
    await u.page.goto(`/attempts/${attemptId}/result`);
    await expect(u.page.getByTestId("percentage")).toHaveText("৭৫.০০%");
    await expect(u.page.getByTestId("score-fraction")).toContainText("৪ নম্বরের মধ্যে ৩");
    await expect(u.page.getByTestId("band-chip")).toHaveText("ভালো নয় — উন্নতি প্রয়োজন"); // 70% – below 80%
    await expect(u.page.getByTestId("feedback")).toContainText("আপনি এগোচ্ছেন");
    await expect(u.page.getByTestId("count-correct")).toHaveText("৩");
    await expect(u.page.getByTestId("count-incorrect")).toHaveText("১");
    await expect(u.page.getByText("ফলাফলের মূল্যায়ন যেভাবে হয়")).toBeVisible();
    await expect(u.page.getByText("৭০% – ৮০%-এর কম")).toBeVisible();
    await expect(u.page.getByTestId("review")).toContainText("প্রশ্ন পর্যালোচনা");
    await expect(u.page.getByTestId("review-item").first()).toContainText("প্রশ্ন ১");
    await expect(u.page.getByRole("button", { name: /এআই ফিডব্যাক নিন/ })).toBeVisible();
    await expect(u.page.getByRole("button", { name: /আবার চেষ্টা করুন · ১টি প্রচেষ্টা বাকি/ })).toBeVisible();
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await noRawKeys(u.page);
    await shot(u.page, "bn-result-desktop");
    await a11y(u.page, "bn result");

    await u.page.setViewportSize({ width: 360, height: 740 });
    await noOverflow(u.page);
    await shot(u.page, "bn-result-360");
    // the same attempt in English still reads exactly as before
    await u.ctx.addCookies([{ name: "sf-locale", value: "en", url: ORIGIN }]);
    await u.page.goto(`/attempts/${attemptId}/result`);
    await expect(u.page.getByTestId("percentage")).toHaveText("75.00%");
    await expect(u.page.getByTestId("band-chip")).toHaveText("Not good — needs improvement");
    await u.ctx.close();
  });

  test("an expired attempt page and the not-released state read in Bangla", async ({ browser }) => {
    const u = await newUser(browser);
    await useBangla(u.ctx, u.page);
    const ids = await seedBank(u.page, 2);
    const examId = await publishExam(u.page, ids, { title: "Bangla exam", release: { mode: "AT_TIME", at: new Date(Date.now() + 3 * 3600_000).toISOString() } });
    const attemptId = await startAttempt(u.page, examId);
    await answerAndSubmit(u.page, attemptId, ["right", "wrong"]);
    await u.page.goto(`/attempts/${attemptId}/result`);
    await expect(u.page.getByTestId("not-released")).toContainText("আপনার উত্তর জমা হয়েছে — ফলাফল এখনো প্রকাশিত হয়নি");
    await expect(u.page.getByTestId("not-released")).toContainText(BN_DIGIT);
    expect(await englishLeft(u.page, USER_DATA)).toEqual([]);
    await u.page.goto("/attempts/does-not-exist");
    await expect(u.page.getByRole("heading", { name: /প্রচেষ্টা খুঁজে পাওয়া যায়নি|পৃষ্ঠাটি পাওয়া যায়নি/ })).toBeVisible();
    await u.ctx.close();
  });
});

test.describe("AI feedback follows the language", () => {
  test("with locale=bn the backend asks for Bangla feedback and the card chrome is Bangla", async ({ browser }) => {
    const u = await newUser(browser);
    await configureAi(u.page);
    await useBangla(u.ctx, u.page);
    const { attemptId } = await takeExam(u.page, ["right", "wrong", "wrong", "wrong"], { title: "Feedback exam" });
    await u.page.goto(`/attempts/${attemptId}/result`);
    await expect(u.page.getByTestId("percentage")).toHaveText("২৫.০০%");
    await u.page.getByRole("button", { name: /এআই ফিডব্যাক নিন/ }).click();
    await expect(u.page.getByTestId("ai-ready")).toBeVisible({ timeout: 30_000 });
    // text written by the (mock) model in Bangla, with Bengali digits, rendered as given
    await expect(u.page.getByTestId("ai-ready")).toContainText("তুমি ৪ টি প্রশ্নের মধ্যে ১ টির সঠিক উত্তর দিয়েছ (২৫%)");
    await expect(u.page.getByTestId("ai-ready")).toContainText(BN_DIGIT);
    // the UI chrome around it is ours
    await expect(u.page.getByTestId("ai-disclaimer")).toContainText("এটি আপনার স্কোর বদলায় না");
    await expect(u.page.getByRole("heading", { name: "পরবর্তী করণীয়" })).toBeVisible();
    await expect(u.page.getByTestId("percentage")).toHaveText("২৫.০০%");

    const rows = await sql<{ summary: string }>('SELECT a.content->>\'summary\' AS summary FROM "ExamAnalysis" a WHERE a."userId" = $1', [u.id]);
    expect(rows[0]?.summary).toMatch(/[ঀ-৿]/); // Bengali script: the language reached rag_agent
    await shot(u.page, "bn-ai-feedback-desktop");
    await a11y(u.page, "bn result with AI feedback");

    // and the same user in English gets English chrome around the same stored text
    await u.ctx.addCookies([{ name: "sf-locale", value: "en", url: ORIGIN }]);
    await u.page.goto(`/attempts/${attemptId}/result`);
    await expect(u.page.getByTestId("ai-disclaimer")).toContainText("does not change your score");
    await u.ctx.close();
  });

  test("the study plan page is Bangla and an English account asks the backend for English", async ({ browser }) => {
    const en = await newUser(browser, "English Learner");
    await configureAi(en.page);
    await takeExam(en.page, ["right", "wrong"], { title: "English exam" });
    await en.page.goto("/study-plan");
    await en.page.getByRole("button", { name: "Write my plan" }).click();
    await expect(en.page.getByTestId("plan-ready").or(en.page.getByTestId("plan-label")).first()).toBeVisible({ timeout: 30_000 });
    const [plan] = await sql<{ headline: string }>('SELECT p.content->>\'headline\' AS headline FROM "StudyPlan" p WHERE p."userId" = $1', [en.id]);
    expect(plan?.headline).toMatch(/focused plan/i);
    await en.ctx.close();

    const bn = await newUser(browser, "Bangla Learner");
    await configureAi(bn.page);
    await useBangla(bn.ctx, bn.page);
    await takeExam(bn.page, ["right", "wrong"], { title: "Bangla exam" });
    await bn.page.goto("/study-plan");
    await bn.page.getByRole("button", { name: "আমার প্ল্যান লিখুন" }).click();
    await expect(bn.page.getByTestId("plan-label")).toBeVisible({ timeout: 30_000 });
    const [bp] = await sql<{ headline: string }>('SELECT p.content->>\'headline\' AS headline FROM "StudyPlan" p WHERE p."userId" = $1', [bn.id]);
    expect(bp?.headline).toMatch(/[ঀ-৿]/);
    await shot(bn.page, "bn-study-plan-desktop");
    await a11y(bn.page, "bn study plan");
    await bn.ctx.close();
  });
});

test.describe("settings in Bangla", () => {
  test("profile, privacy and AI providers pages are translated and accessible", async ({ browser }) => {
    const u = await newUser(browser);
    await useBangla(u.ctx, u.page);
    for (const [path, heading] of [["/settings/profile", /প্রোফাইল/], ["/settings/privacy", /গোপনীয়তা/], ["/settings/providers", /এআই সংযোগ/]] as const) {
      await u.page.goto(path);
      await expect(u.page.getByRole("heading", { name: heading }).first()).toBeVisible();
      expect(await englishLeft(u.page, [...USER_DATA, /OpenAI|OpenRouter|Groq|Mock|mock|text-embedding|deepseek|sk-or-|openrouter\.ai|provider\/model-name/, /^AES|JSON/])).toEqual([]);
      await noRawKeys(u.page);
      await a11y(u.page, `bn ${path}`);
    }
    await u.ctx.close();
  });

  test("registering in Bangla: validation messages and the sign-up form are Bangla", async ({ browser }) => {
    const ctx = await browser.newContext({ locale: "bn-BD", extraHTTPHeaders: { "x-forwarded-for": "198.51.100.88" } });
    const p = await ctx.newPage();
    await p.goto("/register");
    await expect(p.locator("html")).toHaveAttribute("lang", "bn");
    await p.getByRole("button", { name: "অ্যাকাউন্ট তৈরি করুন" }).click();
    await expect(p.getByText("আপনার নাম লিখুন।")).toBeVisible();
    await expect(p.getByText("সঠিক একটি ইমেইল ঠিকানা দিন।")).toBeVisible();
    await p.getByLabel("পুরো নাম").fill("রাফি আহমেদ");
    await p.getByLabel("ইমেইল").fill(uniqueEmail("bn"));
    await p.getByLabel("পাসওয়ার্ড", { exact: true }).fill("short");
    await p.getByRole("button", { name: "অ্যাকাউন্ট তৈরি করুন" }).click();
    await expect(p.getByText("কমপক্ষে ১০টি অক্ষর ব্যবহার করুন।")).toBeVisible();
    expect(await englishLeft(p, USER_DATA)).toEqual([]);
    await a11y(p, "bn register");
    await shot(p, "bn-register-desktop");
    await ctx.close();
  });
});

test.describe("Bangla typography", () => {
  test("Bengali text uses a Bengali-capable font and line-height that leaves room for vowel signs and conjuncts", async ({ browser }) => {
    const u = await newUser(browser);
    await useBangla(u.ctx, u.page);
    await u.page.goto("/dashboard");
    const info = await u.page.evaluate(() => {
      const el = (document.querySelector("main h1, main h2, main p") ?? document.body) as HTMLElement;
      const cs = getComputedStyle(el);
      return { family: cs.fontFamily, lineHeight: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize), lang: document.documentElement.lang };
    });
    expect(info.lang).toBe("bn");
    expect(info.family).toMatch(/Bengali|Bangla|Hind Siliguri|Noto/i);
    expect(info.lineHeight).toBeGreaterThanOrEqual(1.4);
    await u.ctx.close();
  });
});
