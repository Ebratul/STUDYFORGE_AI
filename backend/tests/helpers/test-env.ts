import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

/** Integration tests only ever touch a database whose name ends in `_test`. */
export function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  const base = explicit ?? process.env.DATABASE_URL;
  if (!base) throw new Error("Set TEST_DATABASE_URL (or DATABASE_URL in .env.local) to run integration tests.");
  const url = new URL(base);
  if (!explicit) url.pathname = "/studyforge_test";
  if (!url.pathname.replace(/^\//, "").endsWith("_test")) {
    throw new Error("Refusing to run tests: the test database name must end with _test.");
  }
  return url.toString();
}
