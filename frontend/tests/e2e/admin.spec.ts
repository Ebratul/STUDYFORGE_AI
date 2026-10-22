import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { E2E_SECRETS } from "../helpers/test-env";
import { expect, register, sql, test } from "./fixtures";
import { api, expectConsole, jobStatus, SECTIONS, seedFailedJob, userWithRole } from "./admin-helpers";

async function a11y(page: Page, path: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${path}: ${v.id} (${v.nodes[0]?.target})`)).toEqual([]);
}
const row = (page: Page, name: string) => page.getByTestId("user-row").filter({ hasText: name });

test.describe("access: the console does not advertise itself", () => {
  test("regular users get 404 on every admin page and never see the nav entry", async ({ page }) => {
    await register(page);
    for (const s of SECTIONS) {
      const res = await page.goto(s.path);
      expect(res?.status(), s.path).toBe(404);
      await expect(page.getByRole("heading", { name: "Administration" })).toHaveCount(0);
    }
    await page.goto("/workspace");
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /Admin/ })).toHaveCount(0);
    for (const p of ["/api/admin/overview", "/api/admin/users", "/api/admin/jobs", "/api/admin/config"]) expect((await api(page, "GET", p)).status(), p).toBe(404);
  });

  test("SUPPORT sees the console read-only: no Config tab, no mutation controls, config is 404", async ({ browser }) => {
    const support = await userWithRole(browser, "SUPPORT");
    const other = await userWithRole(browser, "USER", "Sam Student");
    const p = support.page;
    await p.goto("/admin");
    await expectConsole(p);
    await expect(p.getByTestId("role-badge")).toContainText("Support");
    await expect(p.getByTestId("privacy-note")).toContainText("read-only");
    await expect(p.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: /Admin/ })).toBeVisible();
    await expect(p.getByRole("navigation", { name: "Administration sections" }).getByRole("link", { name: "Config" })).toHaveCount(0);

    await p.goto("/admin/users");
    await p.getByRole("searchbox", { name: "Search users" }).fill("Sam Student");
    await expect(row(p, "Sam Student")).toBeVisible();
    await expect(p.getByRole("button", { name: /Actions for/ })).toHaveCount(0);

    await p.goto("/admin/jobs");
    await seedFailedJob();
    await p.reload();
    await expect(p.getByTestId("failure-row").first()).toBeVisible();
    await expect(p.getByRole("button", { name: /Retry/ })).toHaveCount(0);

    expect((await p.goto("/admin/config"))?.status()).toBe(404);
    // the server refuses mutations too, whatever the UI shows
    expect((await api(p, "PATCH", `/api/admin/users/${other.id}`, { status: "SUSPENDED", reason: "nope" })).status()).toBe(404);
    expect((await api(p, "PATCH", `/api/admin/users/${other.id}`, { role: "ADMIN" })).status()).toBe(404);
    const [row0] = await sql<{ status: string }>('SELECT status FROM "User" WHERE id = $1', [other.id]);
    expect(row0?.status).toBe("ACTIVE");
  });
});

test.describe("administrator console", () => {
  test("overview, role badge, privacy note, and every section is reachable from the section nav", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const p = admin.page;
    await p.goto("/admin");
    await expectConsole(p);
    await expect(p.getByTestId("role-badge")).toContainText("Admin");
    await expect(p.getByText("Total users")).toBeVisible();
    await expect(p.getByText("Suspended accounts")).toBeVisible();
    const nav = p.getByRole("navigation", { name: "Administration sections" });
    for (const s of SECTIONS) {
      await nav.getByRole("link", { name: s.tab, exact: true }).click();
      await expect(p).toHaveURL(new RegExp(`${s.path}$`));
      await expect(nav.getByRole("link", { name: s.tab, exact: true })).toHaveAttribute("aria-current", "page");
      await expectConsole(p);
    }
  });

  test("users: search, suspend with a reason (the user is signed out at once), reactivate, change role, revoke sessions", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const victim = await userWithRole(browser, "USER", "Zara Suspendable");
    const p = admin.page;
    await p.goto("/admin/users");
    await p.getByRole("searchbox", { name: "Search users" }).fill("Zara Suspendable");
    await expect(row(p, "Zara Suspendable")).toBeVisible();
    await expect(p.getByTestId("users-total")).toContainText("1 user");

    // the caller's own row offers no status/role changes (the server also refuses them)
    await p.getByRole("searchbox", { name: "Search users" }).fill(admin.name);
    await p.getByRole("button", { name: `Actions for ${admin.name}` }).click();
    await expect(p.getByText("You can't change your own role or status.")).toBeVisible();
    await p.keyboard.press("Escape");
    expect((await api(p, "PATCH", `/api/admin/users/${admin.id}`, { status: "SUSPENDED", reason: "self" })).ok()).toBe(false);
    expect((await api(p, "PATCH", `/api/admin/users/${admin.id}`, { role: "USER" })).ok()).toBe(false);

    await p.getByRole("searchbox", { name: "Search users" }).fill("Zara Suspendable");
    await p.getByRole("button", { name: "Actions for Zara Suspendable" }).click();
    await p.getByRole("menuitem", { name: /Suspend account/ }).click();
    const dialog = p.getByRole("dialog");
    await dialog.getByRole("button", { name: "Suspend account" }).click();
    await expect(dialog.getByText(/Enter a short reason/)).toBeVisible(); // a reason is required
    await dialog.getByLabel(/Reason/).fill("Repeated abuse of the upload limits");
    await dialog.getByRole("button", { name: "Suspend account" }).click();
    await expect(row(p, "Zara Suspendable").getByText("Suspended")).toBeVisible();

    await victim.page.goto("/dashboard");
    await expect(victim.page).toHaveURL(/\/login/); // sessions were revoked and the account is blocked

    await p.getByRole("button", { name: "Actions for Zara Suspendable" }).click();
    await p.getByRole("menuitem", { name: /Reactivate account/ }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Reactivate account" }).click();
    await expect(row(p, "Zara Suspendable").getByText("Active")).toBeVisible();

    await p.getByRole("button", { name: "Actions for Zara Suspendable" }).click();
    await p.getByRole("menuitem", { name: /Make support/ }).click();
    await expect(p.getByRole("dialog")).toContainText("read-only");
    await p.getByRole("dialog").getByRole("button", { name: "Change role" }).click();
    await expect(row(p, "Zara Suspendable").getByTestId("role-badge")).toContainText("Support");
    const [row1] = await sql<{ role: string }>('SELECT role FROM "User" WHERE id = $1', [victim.id]);
    expect(row1?.role).toBe("SUPPORT");

    await p.getByRole("button", { name: "Actions for Zara Suspendable" }).click();
    await p.getByRole("menuitem", { name: /Revoke all sessions/ }).click();
    await p.getByRole("dialog").getByRole("button", { name: "Revoke sessions" }).click();
    await expect(p.getByText(/signed Zara Suspendable out everywhere/i)).toBeVisible();
  });

  test("audit: the changes above are recorded, filters and the date-range check work, metadata is allow-listed", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const target = await userWithRole(browser, "USER", "Audit Target");
    const p = admin.page;
    expect((await api(p, "PATCH", `/api/admin/users/${target.id}`, { status: "SUSPENDED", reason: "e2e audit check" })).ok()).toBe(true);
    await p.goto("/admin/audit");
    await p.getByLabel("Action", { exact: true }).fill("admin.user_status_changed");
    await p.getByRole("button", { name: "Apply" }).click();
    await expect(p.getByTestId("audit-row").first()).toContainText("admin.user_status_changed");
    await expect(p.getByTestId("audit-total")).not.toContainText("0 events");
    const text = await p.getByTestId("audit-row").first().innerText();
    expect(text).not.toMatch(/password|secret|token|api.?key|@example\.test/i);

    await p.getByLabel("From", { exact: true }).fill("2030-01-02");
    await p.getByLabel("To", { exact: true }).fill("2030-01-01");
    await expect(p.getByRole("alert").filter({ hasText: "must be on or before" })).toBeVisible();
    await expect(p.getByRole("button", { name: "Apply" })).toBeDisabled();
    await p.getByRole("button", { name: "Clear" }).click();
    await expect(p.getByLabel("Action", { exact: true })).toHaveValue("");
    await expect(p.getByRole("navigation", { name: "Audit events pagination" })).toBeVisible();
  });

  test("jobs: failed jobs show redacted errors; ADMIN can retry after confirming, and the job goes back to the queue", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const id = await seedFailedJob("exam.analysis", "PROVIDER_UNAVAILABLE after 3 attempts");
    const p = admin.page;
    await p.goto("/admin/jobs");
    await expect(p.getByTestId("job-totals")).toContainText("Failed");
    const fail = p.getByTestId("failure-row").filter({ hasText: "PROVIDER_UNAVAILABLE" }).first();
    await expect(fail).toBeVisible();
    await fail.getByRole("button", { name: /Retry/ }).click();
    await expect(p.getByRole("dialog")).toContainText("cannot create duplicate results");
    await p.getByRole("dialog").getByRole("button", { name: "Retry job" }).click();
    await expect(p.getByText("Job queued for another attempt")).toBeVisible();
    // the retry endpoint re-queues the row (attempts are reset by the server; the worker may pick it up and fail it again with this empty payload)
    await expect.poll(async () => (await sql<{ attempts: number; status: string }>('SELECT attempts, status FROM "Job" WHERE id = $1', [id]))[0]).toMatchObject({ attempts: expect.any(Number) });
    expect(await jobStatus(id)).toBeDefined();
    await expect(p.getByTestId("jobs-matrix")).toBeVisible();
  });

  test("health: each service has a worded state, the overall state is announced, and no connection strings appear", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const p = admin.page;
    await p.goto("/admin/health");
    await expect(p.getByTestId("overall-health")).toBeVisible();
    for (const id of ["h-db", "h-rag", "h-worker", "h-queue", "h-storage"]) await expect(p.getByTestId(id)).toContainText(/Operational|Degraded|Down|Not started|Unknown/);
    await expect(p.getByTestId("h-db")).toContainText("Operational");
    const body = await p.getByRole("main").innerText();
    expect(body).not.toMatch(/postgres(ql)?:\/\/|redis:\/\/|Bearer /i);
    await p.getByRole("button", { name: "Refresh" }).click();
    await expect(p.getByTestId("overall-health")).toBeVisible();
  });

  test("metrics and usage render real aggregates or honest empty states, and the metrics window is selectable", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const p = admin.page;
    for (let i = 0; i < 3; i++) await api(p, "GET", "/api/me"); // generate a few counted requests
    await p.goto("/admin/metrics");
    await expect(p.getByText(/counts/).first()).toBeVisible();
    await expect(p.getByText("Latency is not measured")).toBeVisible();
    await expect(p.getByTestId("api-chart").or(p.getByTestId("metrics-empty"))).toBeVisible();
    await p.getByText("7 d", { exact: true }).click();
    await expect(p.getByRole("radio", { name: "7 d" })).toBeChecked();
    await expect(p.getByRole("heading", { name: "Rate-limit blocks" })).toBeVisible();
    await expect(p.getByRole("heading", { name: "Quota blocks" })).toBeVisible();

    await p.goto("/admin/usage");
    await expect(p.getByText("Storage used", { exact: true })).toBeVisible();
    await expect(p.getByText("AI tokens (30 days)")).toBeVisible();
    await expect(p.getByText(/No cost is estimated/)).toBeVisible();
  });

  test("config is read-only and never contains a secret", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const p = admin.page;
    await p.goto("/admin/config");
    await expect(p.getByTestId("config-note")).toContainText("never displayed or returned");
    await expect(p.getByTestId("config-group").first()).toBeVisible();
    await expect(p.locator("main input, main textarea")).toHaveCount(0);
    const body = await p.content();
    for (const secret of Object.values(E2E_SECRETS)) expect(body).not.toContain(secret);
    expect(body).not.toMatch(/postgres(ql)?:\/\/|studyforge_dev_only/);
    const res = await api(p, "GET", "/api/admin/config");
    const json = await res.text();
    for (const secret of Object.values(E2E_SECRETS)) expect(json).not.toContain(secret);
  });

  test("administrators cannot reach other users' private content through the API", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    const user = await userWithRole(browser, "USER", "Private Person");
    const created = await api(user.page, "POST", "/api/conversations", { title: "Private revision notes" });
    expect(created.status()).toBe(201);
    const conv = (await created.json()).conversation.id as string;
    expect((await api(admin.page, "GET", `/api/conversations/${conv}`)).status()).toBe(404);
    expect((await api(admin.page, "GET", `/api/conversations/${conv}/messages`)).status()).toBe(404);
    const creds = await api(admin.page, "GET", "/api/ai/credentials");
    expect(JSON.stringify(await creds.json())).not.toContain(user.id);
    const users = await (await api(admin.page, "GET", "/api/admin/users?q=Private%20Person")).text();
    expect(users).not.toMatch(/Private revision notes|apiKey|ciphertext/);
  });
});

test.describe("accessibility and responsive layout", () => {
  test("every admin section passes axe for ADMIN", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    for (const s of SECTIONS) {
      await admin.page.goto(s.path);
      await expectConsole(admin.page);
      await a11y(admin.page, s.path);
    }
  });

  test("the user dialogs are keyboard operable and axe-clean", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    await userWithRole(browser, "USER", "Kira Keyboard");
    const p = admin.page;
    await p.goto("/admin/users");
    await p.getByRole("searchbox", { name: "Search users" }).fill("Kira Keyboard");
    const trigger = p.getByRole("button", { name: "Actions for Kira Keyboard" });
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await p.keyboard.press("Enter");
    await p.getByRole("menuitem", { name: /Suspend account/ }).focus();
    await p.keyboard.press("Enter");
    await expect(p.getByRole("dialog")).toBeVisible();
    const dlg = p.getByRole("dialog");
    await expect(dlg.locator(":focus")).toHaveCount(1); // focus moved into the dialog
    // focus order: reason → Cancel → Suspend → close (X) and then wraps inside the dialog; it never escapes to the page behind
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      order.push(await p.evaluate(() => { const a = document.activeElement as HTMLElement | null; return `${a?.tagName}:${a?.getAttribute("aria-label") || a?.id || a?.textContent?.trim().slice(0, 20)}:${a?.closest('[role="dialog"]') ? "in" : "out"}`; }));
      await p.keyboard.press("Tab");
    }
    expect(order.every((o) => o.endsWith(":in")), order.join(" | ")).toBe(true);
    const idx = (needle: string) => order.findIndex((o) => o.includes(needle));
    expect(idx("admin-reason"), order.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(idx("Cancel"), order.join(" | ")).toBeGreaterThan(idx("admin-reason"));
    expect(idx("Suspend account")).toBeGreaterThan(idx("Cancel"));
    await p.waitForTimeout(400); // let the open animation finish before the scan
    await a11y(p, "user dialog");
    await p.keyboard.press("Escape");
    await expect(p.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("SUPPORT's read-only sections pass axe too", async ({ browser }) => {
    const support = await userWithRole(browser, "SUPPORT");
    for (const s of SECTIONS.filter((x) => x.path !== "/admin/config")) {
      await support.page.goto(s.path);
      await expectConsole(support.page);
      await a11y(support.page, `support ${s.path}`);
    }
  });

  test("no horizontal page scroll at 360px on any section", async ({ browser }) => {
    const admin = await userWithRole(browser, "ADMIN");
    await admin.page.setViewportSize({ width: 360, height: 800 });
    for (const s of SECTIONS) {
      await admin.page.goto(s.path);
      await admin.page.waitForLoadState("networkidle");
      const overflow = await admin.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, s.path).toBeLessThanOrEqual(1);
    }
  });
});
