// Creates/migrates/empties the end-to-end database. Runs BEFORE the three servers start
// (Playwright starts webServers before globalSetup, so this is invoked from playwright.config.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import pg from "pg";

const [dbUrl, backendDir, storageDir] = process.argv.slice(2);
const url = new URL(dbUrl);
const dbName = url.pathname.replace(/^\//, "");
if (!dbName.endsWith("_e2e")) throw new Error("refusing: E2E database name must end with _e2e");

const admin = new URL(url);
admin.pathname = "/postgres";
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  if ((await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await client.end();
}
execFileSync("pnpm", ["prisma", "migrate", "deploy"], { cwd: backendDir, stdio: "pipe", env: { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: "" } });
const db = new pg.Client({ connectionString: url.toString() });
await db.connect();
try {
  await db.query('TRUNCATE "User", "RateLimit", "RateLimitBucket", "AuditEvent", "Verification", "Job" CASCADE');
} finally {
  await db.end();
}
rmSync(storageDir, { recursive: true, force: true });
mkdirSync(storageDir, { recursive: true });
