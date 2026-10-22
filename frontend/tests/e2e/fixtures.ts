import { randomInt, randomUUID } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";
import pg from "pg";
import { e2eDatabaseUrl } from "../helpers/test-env";

export const PASSWORD = "Correct-horse-battery-9";
export const MAILPIT = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8025";

// Each test gets its own client IP so per-IP auth rate limits don't leak between tests.
export const test = base.extend({
  extraHTTPHeaders: async ({}, use) => {
    await use({ "x-forwarded-for": `198.51.${randomInt(1, 250)}.${randomInt(1, 250)}` });
  },
});
export { expect };

export function uniqueEmail(prefix = "e2e") {
  return `${prefix}-${randomUUID()}@example.test`;
}

export async function register(page: Page, opts: { name?: string; email?: string; password?: string } = {}) {
  const email = opts.email ?? uniqueEmail();
  const name = opts.name ?? "Ayesha Rahman";
  await page.goto("/register");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(opts.password ?? PASSWORD);
  await page.getByLabel("Confirm password").fill(opts.password ?? PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/workspace/);
  return { email, name };
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

export async function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Polls Mailpit for the newest message to `email` and returns the first URL it contains. */
export async function latestLinkFor(email: string, subjectContains: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:"${subjectContains}"`)}`);
    const data = (await res.json()) as { messages?: { ID: string }[] };
    const id = data.messages?.[0]?.ID;
    if (id) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string };
      const m = msg.Text.match(/https?:\/\/\S+/);
      if (m) return m[0];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No "${subjectContains}" email for ${email} (is Mailpit running on ${MAILPIT}?)`);
}
