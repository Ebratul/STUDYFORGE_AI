import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const MiB = 1024 * 1024;

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(4000, 1),
  DATABASE_URL: z.string().url("DATABASE_URL must be a PostgreSQL connection URL").startsWith("postgres"),
  DIRECT_URL: z.string().url().optional(),
  /** Public origin of the FRONTEND (browsers only ever see this origin; the frontend proxies /api to this service). */
  APP_URL: z.string().url().default("http://localhost:3000"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  AUTH_REQUIRE_EMAIL_VERIFICATION: bool,
  SMTP_URL: z.string().url().optional(),
  EMAIL_FROM: z.string().min(3).default("StudyForge <no-reply@localhost>"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // --- rag_agent (internal AI service) ---
  RAG_AGENT_URL: z.string().url().default("http://127.0.0.1:8100"),
  RAG_AGENT_TOKEN: z.string().min(24, "RAG_AGENT_TOKEN must be at least 24 characters"),
  RAG_AGENT_TIMEOUT_MS: int(120_000, 1000),

  // --- BYOK credential encryption (AES-256-GCM). 32 random bytes, base64. Keep out of the database and out of git. ---
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1, "CREDENTIAL_ENCRYPTION_KEY is required"),
  /** Optional previous key(s), comma-separated, so keys can be rotated without re-encrypting immediately. */
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  /** Offers the deterministic "mock" provider (tests/demos). Rejected in production. */
  ALLOW_MOCK_PROVIDER: bool,

  // --- storage ---
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default("./storage"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,

  // --- upload limits (the single source of truth; the frontend reads them from /api/documents/limits) ---
  MAX_UPLOAD_BYTES: int(25 * MiB, 1024),
  MAX_FILES_PER_UPLOAD: int(10, 1),
  USER_STORAGE_QUOTA_BYTES: int(500 * MiB, 1024),
  MAX_DOCUMENTS_PER_USER: int(200, 1),
  DOWNLOAD_LINK_TTL_SECONDS: int(60, 5),
  /** Video is not supported: no transcription pipeline exists. Kept as an explicit, reportable setting. */
  VIDEO_UPLOADS_ENABLED: bool,

  // --- AI usage limits ---
  AI_DAILY_TOKEN_LIMIT: int(500_000),
  AI_DAILY_REQUEST_LIMIT: int(300),
  CHAT_MAX_MESSAGE_CHARS: int(8000, 100),
  CHAT_HISTORY_MAX_CHARS: int(24_000, 1000),
  CHAT_HISTORY_MAX_MESSAGES: int(20, 1),
  CHAT_MAX_DOCUMENTS: int(20, 1),
  RETRIEVAL_TOP_K: int(6, 1),
  RETRIEVAL_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
  RETRIEVAL_MAX_CONTEXT_CHARS: int(12_000, 500),

  // --- background jobs ---
  JOB_WORKER_ENABLED: z.enum(["true", "false", "1", "0"]).default("true").transform((v) => v === "true" || v === "1"),
  JOB_POLL_INTERVAL_MS: int(1000, 50),
  JOB_CONCURRENCY: int(2, 1),
});

export type Env = z.infer<typeof schema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n - ${issues.join("\n - ")}`);
    this.name = "EnvError";
  }
}

export function decodeKey(b64: string): Buffer | null {
  try {
    const buf = Buffer.from(b64.trim(), "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/** Pure parser (used by tests). Messages never include the offending values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const env = result.data;
  const extra: string[] = [];

  if (!decodeKey(env.CREDENTIAL_ENCRYPTION_KEY)) extra.push("CREDENTIAL_ENCRYPTION_KEY: must be 32 random bytes, base64-encoded");
  for (const k of (env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").filter(Boolean)) {
    if (!decodeKey(k)) extra.push("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: every entry must be 32 random bytes, base64-encoded");
  }
  if (env.AUTH_REQUIRE_EMAIL_VERIFICATION && !env.SMTP_URL) extra.push("SMTP_URL: required when AUTH_REQUIRE_EMAIL_VERIFICATION=true");
  if (env.STORAGE_DRIVER === "s3") {
    for (const k of ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!env[k]) extra.push(`${k}: required when STORAGE_DRIVER=s3`);
    }
  }
  if (env.NODE_ENV === "production") {
    // Plain http is tolerated only for loopback hosts (local production builds, CI end-to-end runs).
    const host = new URL(env.APP_URL).hostname;
    const loopback = host === "localhost" || host === "127.0.0.1";
    if (!env.APP_URL.startsWith("https://") && !loopback) extra.push("APP_URL: must be https in production");
    if (env.ALLOW_MOCK_PROVIDER) extra.push("ALLOW_MOCK_PROVIDER: must not be enabled in production");
    if (env.VIDEO_UPLOADS_ENABLED) extra.push("VIDEO_UPLOADS_ENABLED: video processing is not implemented");
  }
  if (extra.length) throw new EnvError(extra);
  return env;
}

let cached: Env | undefined;

/** Lazily validated; also called at server start so misconfiguration fails fast with a value-free message. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper. */
export function resetEnvCache() {
  cached = undefined;
}
