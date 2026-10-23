import { expect, register, test } from "./fixtures";
import { E2E_GOOGLE, PORTS } from "../helpers/test-env";
import type { Page, Request } from "@playwright/test";

const APP = `http://localhost:${PORTS.frontend}`;

/**
 * Google is never contacted. We let the real frontend + backend build the authorization URL, then answer the browser's request to
 * accounts.google.com ourselves: `cancel` sends the user straight back to our callback with `error=access_denied`, as Google does.
 */
async function interceptGoogle(page: Page, mode: "capture" | "cancel") {
  const seen: URL[] = [];
  await page.route("https://accounts.google.com/**", async (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    if (mode === "cancel") {
      const back = new URL(`${APP}/api/auth/callback/google`);
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      await route.fulfill({ status: 302, headers: { location: back.toString() } });
    } else {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Google (intercepted)</title><p>intercepted</p>" });
    }
  });
  return seen;
}

test.describe("Continue with Google", () => {
  test("is offered on both the sign-in and registration pages, above the email form", async ({ page }) => {
    for (const path of ["/login", "/register"]) {
      await page.goto(path);
      const button = page.getByRole("button", { name: "Continue with Google" });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      await expect(page.getByText("or continue with email")).toBeVisible();
      // email/password stays available
      await expect(page.getByLabel("Email")).toBeVisible();
    }
  });

  test("is usable at phone width without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("sends the browser to Google with the code flow, PKCE, state, the exact redirect URI and only basic scopes", async ({ page }) => {
    const seen = await interceptGoogle(page, "capture");
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    const u = seen[0]!;
    expect(`${u.origin}${u.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(E2E_GOOGLE.AUTH_GOOGLE_ID);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe(`${APP}/api/auth/callback/google`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(new Set(u.searchParams.get("scope")!.split(" "))).toEqual(new Set(["openid", "email", "profile"]));
    expect(u.toString()).not.toContain(E2E_GOOGLE.AUTH_GOOGLE_SECRET);
    // The state cookie that binds this browser to the flow is set, HttpOnly (not readable by page scripts).
    const cookies = await page.context().cookies();
    expect(cookies.find((c) => /state/.test(c.name))).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/state/);
  });

  test("shows a loading state while redirecting", async ({ page }) => {
    await page.route("https://accounts.google.com/**", () => undefined); // never answered: the page stays in the "connecting" state
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page.getByRole("button", { name: "Connecting to Google…" })).toBeDisabled();
  });

  test("cancelling at Google returns to the sign-in page with a neutral message and no session", async ({ page }) => {
    await interceptGoogle(page, "cancel");
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page).toHaveURL(/\/login\?.*error=access_denied/);
    await expect(page.getByRole("status").filter({ hasText: "Google sign-in was cancelled" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    await page.goto("/workspace");
    await expect(page).toHaveURL(/\/login/);
  });

  test("cancelling on the registration page returns to registration", async ({ page }) => {
    await interceptGoogle(page, "cancel");
    await page.goto("/register");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expect(page).toHaveURL(/\/register\?.*error=access_denied/);
    await expect(page.getByText("Google sign-in was cancelled")).toBeVisible();
  });

  test("an invalid callback shows a friendly, generic error (no provider text, no secrets)", async ({ page }) => {
    await page.goto("/api/auth/callback/google?code=forged&state=forged");
    // Better Auth answers with its own error redirect; whichever page we land on must not expose internals.
    const body = await page.content();
    expect(body).not.toContain(E2E_GOOGLE.AUTH_GOOGLE_SECRET);
    expect(await page.context().cookies()).not.toContainEqual(expect.objectContaining({ name: expect.stringMatching(/session_token/) }));
    await page.goto("/login?error=state_mismatch&error_description=%3Cb%3Eboom%3C/b%3E");
    await expect(page.getByText("The Google sign-in session expired or was invalid")).toBeVisible();
    await expect(page.getByText("boom")).toHaveCount(0);
  });

  test("an existing password account is told how to connect Google instead of being merged", async ({ page }) => {
    await page.goto("/login?error=account_not_linked");
    await expect(page.getByRole("alert").filter({ hasText: "connect Google under Settings" })).toBeVisible();
  });

  test("only passes a same-site post-login path to the server", async ({ page }) => {
    const bodies: string[] = [];
    page.on("request", (r: Request) => {
      if (r.url().includes("/api/auth/sign-in/social")) bodies.push(r.postData() ?? "");
    });
    await interceptGoogle(page, "capture");
    for (const [next, expected] of [["/exams/abc", "/exams/abc?auth=google"], ["//evil.example", "/workspace?auth=google"], ["https://evil.example", "/workspace?auth=google"]] as const) {
      bodies.length = 0;
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await page.getByRole("button", { name: "Continue with Google" }).click();
      await expect.poll(() => bodies.length).toBe(1);
      const sent = JSON.parse(bodies[0]!) as { callbackURL: string; newUserCallbackURL: string; errorCallbackURL: string };
      expect(sent.callbackURL).toBe(expected);
      expect(sent.newUserCallbackURL).toBe(expected.replace("auth=google", "auth=google-new"));
      expect(sent.errorCallbackURL.startsWith("/login")).toBe(true);
      await page.waitForURL(/accounts\.google\.com/); // let this navigation finish before the next case starts
    }
  });

  test("the content-security-policy allows Google profile pictures and nothing broader", async ({ request }) => {
    const csp = (await request.get("/login")).headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/img-src [^;]*https:\/\/\*\.googleusercontent\.com/);
    expect(csp).not.toMatch(/img-src [^;]*\shttps:(\s|;)/);
  });
});

test.describe("Google in account settings", () => {
  test("a password account can start connecting Google, with the same redirect URI and scopes", async ({ page }) => {
    const seen = await interceptGoogle(page, "capture");
    await register(page);
    await page.goto("/settings/privacy");
    await expect(page.getByText("Sign-in methods", { exact: true })).toBeVisible();
    await expect(page.getByText("A password is set for this account.")).toBeVisible();
    await page.getByRole("button", { name: "Connect Google" }).click();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen[0]!.searchParams.get("redirect_uri")).toBe(`${APP}/api/auth/callback/google`);
    expect(new Set(seen[0]!.searchParams.get("scope")!.split(" "))).toEqual(new Set(["openid", "email", "profile"]));
  });

  test("cancelling while connecting returns to settings with a message and links nothing", async ({ page }) => {
    await interceptGoogle(page, "cancel");
    await register(page);
    await page.goto("/settings/privacy");
    await page.getByRole("button", { name: "Connect Google" }).click();
    await expect(page).toHaveURL(/\/settings\/privacy/);
    await expect(page.getByText("Google sign-in was cancelled")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Google" })).toBeVisible();
  });
});
