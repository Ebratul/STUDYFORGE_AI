import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";
import { backendDir, e2eDatabaseUrl, E2E_GOOGLE, E2E_SECRETS, E2E_STORAGE_DIR, PORTS, ragDir } from "./tests/helpers/test-env";

const dbUrl = e2eDatabaseUrl();

// Start from an empty, migrated database. Guarded so Playwright's worker processes (which re-load this file) don't wipe it again.
if (!process.env.E2E_DB_PREPARED) {
  execFileSync(process.execPath, ["tests/helpers/prepare-db.mjs", dbUrl, backendDir(), E2E_STORAGE_DIR], { stdio: "inherit" });
  process.env.E2E_DB_PREPARED = "1";
}
const frontendUrl = `http://localhost:${PORTS.frontend}`;
const smtp = process.env.E2E_SMTP_URL ?? "smtp://127.0.0.1:1025";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL: frontendUrl, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Three real processes: rag_agent (mock provider enabled), backend, and the production-built frontend.
  webServer: [
    {
      command: `uv run uvicorn app.main:app --host 127.0.0.1 --port ${PORTS.rag}`,
      cwd: ragDir(),
      url: `http://127.0.0.1:${PORTS.rag}/health`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: { APP_ENV: "test", DATABASE_URL: dbUrl, RAG_AGENT_TOKEN: E2E_SECRETS.RAG_AGENT_TOKEN, ALLOW_MOCK_PROVIDER: "1", LOG_LEVEL: "warning" },
    },
    {
      command: "pnpm exec tsx src/index.ts",
      cwd: backendDir(),
      url: `http://127.0.0.1:${PORTS.backend}/api/health`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: "test",
        PORT: String(PORTS.backend),
        DATABASE_URL: dbUrl,
        APP_URL: frontendUrl,
        BETTER_AUTH_SECRET: E2E_SECRETS.BETTER_AUTH_SECRET,
        CREDENTIAL_ENCRYPTION_KEY: E2E_SECRETS.CREDENTIAL_ENCRYPTION_KEY,
        RAG_AGENT_URL: `http://127.0.0.1:${PORTS.rag}`,
        RAG_AGENT_TOKEN: E2E_SECRETS.RAG_AGENT_TOKEN,
        ALLOW_MOCK_PROVIDER: "true",
        ...E2E_GOOGLE,
        SMTP_URL: smtp,
        EMAIL_FROM: "StudyForge <no-reply@studyforge.test>",
        STORAGE_DRIVER: "local",
        LOCAL_STORAGE_DIR: E2E_STORAGE_DIR,
        JOB_POLL_INTERVAL_MS: "200",
        LOG_LEVEL: "error",
      },
    },
    {
      command: `pnpm build && pnpm start -p ${PORTS.frontend}`,
      url: `${frontendUrl}/login`,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      env: { BACKEND_URL: `http://127.0.0.1:${PORTS.backend}` },
    },
  ],
});
