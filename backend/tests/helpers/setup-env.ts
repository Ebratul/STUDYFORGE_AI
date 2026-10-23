import { randomBytes } from "node:crypto";
import { resolveTestDatabaseUrl } from "./test-env.js";

Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: resolveTestDatabaseUrl(),
  APP_URL: "http://localhost:3100",
  BETTER_AUTH_SECRET: "test-only-secret-test-only-secret-1234567890",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  RAG_AGENT_URL: "http://127.0.0.1:9",
  RAG_AGENT_TOKEN: "test-rag-agent-token-0123456789abcdef",
  ALLOW_MOCK_PROVIDER: "true",
  VECTOR_STORE: "pgvector", // tests choose another mode explicitly with withEnv(); a developer's .env never leaks in
  // Throw-away Google client values: the token endpoint is always mocked in tests (tests/helpers/google.ts).
  AUTH_GOOGLE_ID: "test-client-id.apps.googleusercontent.com",
  AUTH_GOOGLE_SECRET: "test-only-google-client-secret",
  LOG_LEVEL: "error",
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: `/tmp/studyforge-test-storage-${randomBytes(4).toString("hex")}`,
  JOB_WORKER_ENABLED: "false",
  AI_DAILY_TOKEN_LIMIT: "1000000",
  AI_DAILY_REQUEST_LIMIT: "1000",
});
delete process.env.SMTP_URL; // never send real mail from tests
delete process.env.AUTH_REQUIRE_EMAIL_VERIFICATION;
// Tests never talk to Cloudinary (see tests/helpers/fake-cloudinary.ts), even if real credentials sit in the developer's .env.
for (const k of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_MAX_FILE_BYTES", "CLOUDINARY_URL"]) delete process.env[k];
