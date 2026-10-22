import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { expect, sql } from "./fixtures";
import { newUser, type TestUser } from "./group-helpers";

export type ConsoleRole = "ADMIN" | "SUPPORT" | "USER";

/** Authenticated same-origin API call (the browser context already carries the session cookie). */
export async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.request.fetch(path, {
    method,
    headers: { origin: "http://localhost:3100", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Registers a user in an isolated browser context and gives them `role` directly in the database (there is no public way to become an admin). */
export async function userWithRole(browser: Browser, role: ConsoleRole, name = `${role.toLowerCase()} ${randomUUID().slice(0, 6)}`): Promise<TestUser> {
  const u = await newUser(browser, name);
  if (role !== "USER") await sql('UPDATE "User" SET role = $1::"Role" WHERE id = $2', [role, u.id]);
  return u;
}

/** A FAILED job as the queue would leave it after exhausting its attempts. Returns its id. */
export async function seedFailedJob(type = "exam.analysis", lastError = "PROVIDER_UNAVAILABLE after 3 attempts"): Promise<string> {
  const id = `j${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  await sql(`INSERT INTO "Job" ("id","type","payload","status","attempts","maxAttempts","lastError","updatedAt") VALUES ($1,$2,'{}'::jsonb,'FAILED',3,3,$3,now())`, [id, type, lastError]);
  return id;
}

export const jobStatus = async (id: string): Promise<string | undefined> => (await sql<{ status: string }>('SELECT status FROM "Job" WHERE id = $1', [id]))[0]?.status;

/** Every admin section with the panel heading it renders (used for navigation and axe sweeps). */
export const SECTIONS: { path: string; tab: string; heading: RegExp }[] = [
  { path: "/admin", tab: "Overview", heading: /Recent audit events/ },
  { path: "/admin/users", tab: "Users", heading: /^Users$/ },
  { path: "/admin/usage", tab: "Usage", heading: /Documents by status/ },
  { path: "/admin/metrics", tab: "Metrics", heading: /API requests by status class|^Metrics$/ },
  { path: "/admin/jobs", tab: "Jobs", heading: /Background jobs/ },
  { path: "/admin/health", tab: "Health", heading: /^Services$/ },
  { path: "/admin/audit", tab: "Audit", heading: /Security audit events/ },
  { path: "/admin/config", tab: "Config", heading: /.+/ },
];

export async function expectConsole(page: Page) {
  await expect(page.getByRole("heading", { name: "Administration", level: 1 })).toBeVisible();
  await expect(page.getByTestId("privacy-note")).toContainText("cannot read private conversations, documents or API keys");
}
