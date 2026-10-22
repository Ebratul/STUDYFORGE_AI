import { execFileSync } from "node:child_process";
import pg from "pg";
import { resolveTestDatabaseUrl } from "./test-env.js";

export default async function setup() {
  const testUrl = new URL(resolveTestDatabaseUrl());
  const dbName = testUrl.pathname.replace(/^\//, "");

  const admin = new URL(testUrl.toString());
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
  } finally {
    await client.end();
  }

  // Apply committed migrations (the same path production uses).
  execFileSync("pnpm", ["prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: testUrl.toString(), DIRECT_URL: "" },
  });

  const db = new pg.Client({ connectionString: testUrl.toString() });
  await db.connect();
  try {
    await db.query('TRUNCATE "User", "RateLimit", "RateLimitBucket", "AuditEvent", "Verification", "Job" CASCADE');
  } finally {
    await db.end();
  }
}
