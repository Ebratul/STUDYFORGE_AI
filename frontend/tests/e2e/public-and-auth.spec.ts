import AxeBuilder from "@axe-core/playwright";
import { expect, latestLinkFor, PASSWORD, register, signOut, sql, test, uniqueEmail } from "./fixtures";

test.describe("public site", () => {
  test("landing page explains the product and offers register/login", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("your own material");
    await expect(page.getByRole("link", { name: /Create free account/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
    for (const l of ["Privacy", "Terms", "Help"]) await expect(page.getByRole("contentinfo").getByRole("link", { name: l })).toBeVisible();
  });

  test("legal and help pages render", async ({ page }) => {
    for (const [path, title] of [["/privacy", "Privacy policy"], ["/terms", "Terms of service"], ["/help", "Help"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    }
  });

  test("security headers and a per-request CSP nonce are present", async ({ request }) => {
    const res = await request.get("/login");
    const h = res.headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["strict-transport-security"]).toContain("max-age");
    expect(h["referrer-policy"]).toBeTruthy();
    const csp = h["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    const second = (await request.get("/login")).headers()["content-security-policy"];
    expect(second).not.toBe(csp); // nonce differs per request
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("health endpoints respond without leaking internals", async ({ request }) => {
    expect(await (await request.get("/api/health")).json()).toEqual({ status: "ok" });
    expect(await (await request.get("/api/ready")).json()).toMatchObject({ status: "ready" });
  });
});

test.describe("authentication", () => {
  test("signed-out visitors are redirected from every protected area", async ({ page }) => {
    for (const path of ["/workspace", "/dashboard", "/settings/profile", "/notifications", "/admin", "/documents"]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/%/g, "%")}`));
    }
  });

  test("registration validates input with field-level errors", async ({ page }) => {
    await page.goto("/register");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await expect(page.getByText("Enter a valid email address.")).toBeVisible();

    await page.getByLabel("Full name").fill("A B");
    await page.getByLabel("Email").fill(uniqueEmail());
    await page.getByLabel("Password", { exact: true }).fill("weak");
    await page.getByLabel("Confirm password").fill("different");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    await expect(page).toHaveURL(/\/register/);
  });

  test("register -> workspace -> sign out -> sign in", async ({ page }) => {
    const { email, name } = await register(page);
    await expect(page.getByRole("heading", { name: `Welcome, ${name.split(" ")[0]}` })).toBeVisible();
    await signOut(page);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace/);
  });

  test("wrong password and unknown email show the same generic error", async ({ page }) => {
    const { email } = await register(page);
    await signOut(page);
    for (const e of [email, uniqueEmail("ghost")]) {
      await page.getByLabel("Email").fill(e);
      await page.getByLabel("Password", { exact: true }).fill("Wrong-password-1");
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Incorrect email or password." })).toBeVisible();
    }
  });

  test("sign-in honours a safe ?next and ignores an external redirect", async ({ page }) => {
    const { email } = await register(page);
    await signOut(page);
    await page.goto("/login?next=%2Fdashboard");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    await signOut(page);
    await page.goto("/login?next=https%3A%2F%2Fevil.example");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/localhost:3100\/workspace$/);
  });

  test("session cookie is HttpOnly and SameSite=Lax", async ({ page, context }) => {
    await register(page);
    const cookie = (await context.cookies()).find((c) => c.name.includes("session_token"));
    expect(cookie).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe("Lax");
  });

  test("password recovery by email, and the old password stops working", async ({ page }) => {
    const { email } = await register(page);
    await signOut(page);

    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/If an account exists/)).toBeVisible();

    const link = await latestLinkFor(email, "Reset your StudyForge password");
    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    const next = "Brand-new-passphrase-7";
    await page.getByLabel("New password", { exact: true }).fill(next);
    await page.getByLabel("Confirm new password").fill(next);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password.")).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill(next);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace/);
  });

  test("recovery does not reveal whether an email is registered", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(uniqueEmail("ghost"));
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/If an account exists/)).toBeVisible();
  });

  test("an invalid reset link is rejected", async ({ page }) => {
    await page.goto("/reset-password?token=not-a-real-token");
    await page.getByLabel("New password", { exact: true }).fill("Brand-new-passphrase-7");
    await page.getByLabel("Confirm new password").fill("Brand-new-passphrase-7");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("form", { name: "Choose a new password" }).getByRole("alert")).toContainText(/invalid or has expired/);
  });

  test("email verification link marks the address verified", async ({ page }) => {
    const { email } = await register(page);
    await expect(page.getByText(/We need to confirm/)).toBeVisible();
    const link = await latestLinkFor(email, "Verify your StudyForge email");
    await page.goto(link);
    await expect(page).toHaveURL(/verify-email/);
    await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
    const rows = await sql<{ emailVerified: boolean }>('SELECT "emailVerified" FROM "User" WHERE email = $1', [email]);
    expect(rows[0]?.emailVerified).toBe(true);
  });

  test("login rate limiting kicks in after repeated failures", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(uniqueEmail("ghost"));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      await page.getByLabel("Password", { exact: true }).fill("Wrong-password-1");
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/auth/sign-in/email")),
        page.getByRole("button", { name: "Sign in" }).click(),
      ]);
      statuses.push(res.status());
    }
    expect(statuses.slice(0, 8)).not.toContain(429);
    expect(statuses).toContain(429);
    await expect(page.getByText(/Too many attempts/)).toBeVisible();
  });

  test("login and landing pages have no serious accessibility violations", async ({ page }) => {
    for (const path of ["/", "/login", "/register"]) {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${path}: ${v.id}`)).toEqual([]);
    }
  });
});
