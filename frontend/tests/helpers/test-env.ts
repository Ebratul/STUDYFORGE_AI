import { config } from "dotenv";
import { existsSync } from "node:fs";

// Reuse the backend's local dev secrets for the *same machine* without printing them.
config({ path: ".env.local" });

export const PORTS = { frontend: 3100, backend: 4100, rag: 8200 };

/** End-to-end tests use their own database; it must end in `_e2e` so no other database is ever truncated. */
export function e2eDatabaseUrl(): string {
  const url = process.env.E2E_DATABASE_URL ?? "postgresql://studyforge:studyforge_dev_only@127.0.0.1:5440/studyforge_e2e";
  if (!new URL(url).pathname.replace(/^\//, "").endsWith("_e2e")) throw new Error("E2E database name must end with _e2e");
  return url;
}

/** Throw-away secrets for the E2E stack only (not the dev ones). */
export const E2E_SECRETS = {
  BETTER_AUTH_SECRET: "e2e-only-secret-e2e-only-secret-1234567890",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
  RAG_AGENT_TOKEN: "e2e-rag-agent-token-0123456789abcdef",
};

/** Throw-away Google client values so the button renders. Google itself is never contacted: the browser's hop to accounts.google.com is intercepted. */
export const E2E_GOOGLE = {
  AUTH_GOOGLE_ID: "e2e-test-client.apps.googleusercontent.com",
  AUTH_GOOGLE_SECRET: "e2e-only-google-client-secret",
};

export const E2E_STORAGE_DIR = "/tmp/studyforge-e2e-storage";

export function backendDir(): string {
  const p = new URL("../../../backend", import.meta.url).pathname;
  if (!existsSync(p)) throw new Error("backend/ not found next to frontend/");
  return p;
}
export function ragDir(): string {
  return new URL("../../../rag_agent", import.meta.url).pathname;
}
