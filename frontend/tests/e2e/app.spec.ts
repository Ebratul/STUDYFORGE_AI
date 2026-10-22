import AxeBuilder from "@axe-core/playwright";
import { expect, PASSWORD, register, signOut, sql, test, uniqueEmail } from "./fixtures";

test.describe("application shell and navigation", () => {
  test("desktop shell: sidebar sections, honest 'Soon' labels and labelled placeholders", async ({ page }) => {
    await register(page);
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const label of ["Workspace", "Dashboard", "Conversation", "MCQ Generator", "CQ Generator", "Documents", "Question Bank", "Exams", "Groups", "Notifications", "Profile", "Privacy & account", "AI providers", "API keys"]) {
      await expect(nav.getByRole("link", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toBeVisible();
    }
    // Planned modules advertise that they're unfinished.
    for (const label of ["MCQ Generator", "CQ Generator", "Question Bank", "Exams", "Groups"]) {
      await expect(nav.getByRole("link", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toContainText("Soon");
    }
    // Modules that exist in this build are not labelled "Soon".
    for (const label of ["Conversation", "Documents", "AI providers", "API keys"]) {
      await expect(nav.getByRole("link", { name: new RegExp(`^${label}`) })).not.toContainText("Soon");
    }
    await expect(nav.getByRole("link", { name: /^Workspace/ })).not.toContainText("Soon");
    // Regular users never see the admin entry.
    await expect(nav.getByRole("link", { name: /Admin/ })).toHaveCount(0);

    await nav.getByRole("link", { name: /^MCQ Generator/ }).click();
    await expect(page).toHaveURL(/\/mcq$/);
    await expect(page.getByText("Not implemented yet")).toBeVisible();
    await expect(page.getByText(/Coming in Part 3/)).toBeVisible();
    // Placeholders contain no inputs that could simulate an AI answer.
    await expect(page.getByRole("main").getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  });

  test("every placeholder route is labelled and authenticated", async ({ page }) => {
    await register(page);
    for (const path of ["/mcq", "/cq", "/question-bank", "/exams", "/groups"]) {
      await page.goto(path);
      await expect(page.getByText("Not implemented yet")).toBeVisible();
    }
  });

  test("dashboard shows real account facts and no fabricated analytics", async ({ page }) => {
    await register(page);
    await page.goto("/dashboard");
    await expect(page.getByText("No exam activity yet")).toBeVisible();
    await expect(page.getByText("Planned analytics")).toBeVisible();
    await expect(page.getByText("Unread notifications")).toBeVisible();
  });

  test("⌘K / Ctrl+K command search jumps to a page", async ({ page }) => {
    await register(page);
    await page.keyboard.press("Control+k");
    const box = page.getByRole("textbox", { name: "Search pages" });
    await expect(box).toBeFocused();
    await box.fill("upload");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/documents$/);
  });

  test("theme toggle switches to dark mode", async ({ page }) => {
    await register(page);
    await page.getByRole("button", { name: "Change theme" }).click();
    await page.getByRole("menuitem", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("mobile: sidebar collapses into a drawer and there is no horizontal overflow", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": "198.51.100.77" } });
    const page = await ctx.newPage();
    await page.goto(`${baseURL}/register`);
    await page.getByLabel("Full name").fill("Mobile User");
    await page.getByLabel("Email").fill(uniqueEmail("mobile"));
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/workspace/);

    await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("link", { name: /Dashboard/ })).toBeVisible();
    await drawer.getByRole("link", { name: /Dashboard/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("dialog")).toHaveCount(0); // drawer closed after navigating

    for (const path of ["/workspace", "/dashboard", "/settings/profile", "/settings/privacy", "/notifications", "/settings/api-keys", "/settings/providers", "/documents", "/chat"]) {
      await page.goto(`${baseURL}${path}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} overflows horizontally`).toBeLessThanOrEqual(0);
    }
    await ctx.close();
  });

  test("keyboard: skip link reaches main content and Tab order starts in the page", async ({ page }) => {
    await register(page);
    await page.goto("/dashboard");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("authenticated pages have no serious accessibility violations", async ({ page }) => {
    await register(page);
    for (const path of ["/workspace", "/dashboard", "/notifications", "/settings/profile", "/settings/privacy", "/settings/api-keys", "/settings/providers", "/documents", "/chat", "/mcq"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${path}: ${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
    }
  });
});

test.describe("notifications", () => {
  test("welcome notification appears and can be marked read", async ({ page }) => {
    await register(page);
    await expect(page.getByRole("link", { name: /Notifications, 1 unread/ })).toBeVisible();
    await page.goto("/notifications");
    await expect(page.getByText("Welcome to StudyForge")).toBeVisible();
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(page.getByText("0 unread")).toBeVisible();
    await expect(page.getByRole("link", { name: "Notifications" }).first()).toBeVisible();
  });
});

test.describe("profile and account settings", () => {
  test("profile validation errors, successful save, and persistence after reload", async ({ page }) => {
    await register(page, { name: "Old Name" });
    await page.goto("/settings/profile");
    await page.getByLabel("Full name").fill("");
    await page.getByLabel("Bio").fill("x".repeat(281));
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await expect(page.getByText("Use at most 280 characters.")).toBeVisible();

    await page.getByLabel("Full name").fill("New Name");
    await page.getByLabel("Display name").fill("Newbie");
    await page.getByLabel("Bio").fill("Studying for HSC.");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Full name")).toHaveValue("New Name");
    await expect(page.getByLabel("Bio")).toHaveValue("Studying for HSC.");
    await expect(page.getByRole("complementary", { name: "Sidebar" }).getByText("New Name")).toBeVisible();
  });

  test("preferences persist", async ({ page }) => {
    await register(page);
    await page.goto("/settings/profile");
    await page.getByLabel("Email notifications").click();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText("Preferences saved")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Email notifications")).not.toBeChecked();
  });

  test("changing the password signs out other devices", async ({ page, browser, baseURL }) => {
    const { email } = await register(page);
    const other = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.88" } });
    const otherPage = await other.newPage();
    await otherPage.goto(`${baseURL}/login`);
    await otherPage.getByLabel("Email").fill(email);
    await otherPage.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await otherPage.getByRole("button", { name: "Sign in" }).click();
    await expect(otherPage).toHaveURL(/\/workspace/);

    await page.goto("/settings/privacy");
    await expect(page.getByText("This device")).toBeVisible();
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password", { exact: true }).fill("Totally-new-passphrase-3");
    await page.getByLabel("Confirm new password").fill("Totally-new-passphrase-3");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText(/Password updated/)).toBeVisible();

    await otherPage.goto(`${baseURL}/dashboard`);
    await expect(otherPage).toHaveURL(/\/login/);
    await other.close();
  });

  test("a session can be revoked from the sessions list", async ({ page, browser, baseURL }) => {
    const { email } = await register(page);
    const other = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.99" } });
    const otherPage = await other.newPage();
    await otherPage.goto(`${baseURL}/login`);
    await otherPage.getByLabel("Email").fill(email);
    await otherPage.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await otherPage.getByRole("button", { name: "Sign in" }).click();
    await expect(otherPage).toHaveURL(/\/workspace/);

    await page.goto("/settings/privacy");
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Session revoked")).toBeVisible();
    await otherPage.goto(`${baseURL}/dashboard`);
    await expect(otherPage).toHaveURL(/\/login/);
    await other.close();
  });

  test("account deletion requires confirmation and removes the account", async ({ page }) => {
    const { email } = await register(page);
    await page.goto("/settings/privacy");
    await page.getByRole("button", { name: "Delete my account" }).click();
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", { name: "Delete permanently" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/Type/).fill(email);
    await dialog.getByLabel("Password", { exact: true }).fill("Wrong-password-1");
    await confirm.click();
    await expect(dialog.getByText(/couldn't delete the account/)).toBeVisible();

    await dialog.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await confirm.click();
    await expect(page).toHaveURL(/\/\?deleted=1$/);
    expect(await sql('SELECT 1 FROM "User" WHERE email = $1', [email])).toHaveLength(0);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  });
});

test.describe("authorization", () => {
  test("data export returns only the caller's data; anonymous callers get 401", async ({ browser, baseURL }) => {
    const a = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.11" } });
    const b = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.12" } });
    const [pa, pb] = [await a.newPage(), await b.newPage()];
    const [ua, ub] = [await register(pa, { name: "Alice A" }), await register(pb, { name: "Bob B" })];

    const exportA = await (await a.request.get(`${baseURL}/api/account/export`)).text();
    expect(exportA).toContain(ua.email);
    expect(exportA).not.toContain(ub.email);
    const exportB = await (await b.request.get(`${baseURL}/api/account/export`)).text();
    expect(exportB).toContain(ub.email);
    expect(exportB).not.toContain(ua.email);

    const anon = await (await pa.context().browser()!.newContext()).request.get(`${baseURL}/api/account/export`);
    expect(anon.status()).toBe(401);
    await a.close(); await b.close();
  });

  test("regular users get 404 on /admin; admins get the dashboard", async ({ page }) => {
    const { email } = await register(page);
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(404);

    await sql('UPDATE "User" SET role = \'ADMIN\' WHERE email = $1', [email]);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /Admin/ })).toBeVisible();
    await expect(page.getByText("Total users")).toBeVisible();

    // Demotion takes effect on the very next request.
    await sql('UPDATE "User" SET role = \'USER\' WHERE email = $1', [email]);
    const again = await page.goto("/admin");
    expect(again?.status()).toBe(404);
  });

  test("a suspended user is signed out on their next request", async ({ page }) => {
    const { email } = await register(page);
    await sql('UPDATE "User" SET status = \'SUSPENDED\' WHERE email = $1', [email]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("after sign-out the browser back button cannot reveal protected pages", async ({ page }) => {
    await register(page);
    await page.goto("/dashboard");
    await signOut(page);
    await page.goBack();
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
  });
});
