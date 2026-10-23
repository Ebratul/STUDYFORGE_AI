import { describe, expect, it } from "vitest";
import { EnvError, isGoogleConfigured, parseEnv } from "../../src/config/env.js";

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  APP_URL: "http://localhost:3000",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  RAG_AGENT_TOKEN: "t".repeat(24),
};

describe("environment validation", () => {
  it("accepts a minimal valid configuration and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.AUTH_REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects missing required variables", () => {
    expect(() => parseEnv({})).toThrow(EnvError);
  });

  it("rejects a short auth secret", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("rejects non-postgres database URLs", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "mysql://u:p@h/db" })).toThrow(/DATABASE_URL/);
  });

  it("treats empty strings as unset", () => {
    expect(parseEnv({ ...valid, SMTP_URL: "", DIRECT_URL: "" }).SMTP_URL).toBeUndefined();
  });

  it("requires SMTP when email verification is enforced", () => {
    expect(() => parseEnv({ ...valid, AUTH_REQUIRE_EMAIL_VERIFICATION: "true" })).toThrow(/SMTP_URL/);
    expect(parseEnv({ ...valid, AUTH_REQUIRE_EMAIL_VERIFICATION: "true", SMTP_URL: "smtp://localhost:1025" }).AUTH_REQUIRE_EMAIL_VERIFICATION).toBe(true);
  });

  it("requires https APP_URL in production", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "production", APP_URL: "http://app.example.com" })).toThrow(/https/);
    expect(parseEnv({ ...valid, NODE_ENV: "production", APP_URL: "https://app.example.com" }).NODE_ENV).toBe("production");
    // loopback http is allowed for local production builds / CI
    expect(parseEnv({ ...valid, NODE_ENV: "production", APP_URL: "http://localhost:3100" }).NODE_ENV).toBe("production");
  });

  it("requires a 32-byte base64 credential encryption key", () => {
    expect(() => parseEnv({ ...valid, CREDENTIAL_ENCRYPTION_KEY: "short" })).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(() => parseEnv({ ...valid, CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/32 random bytes/);
    expect(() => parseEnv({ ...valid, CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: "bad" })).toThrow(/PREVIOUS/);
  });

  it("requires a long rag_agent token", () => {
    expect(() => parseEnv({ ...valid, RAG_AGENT_TOKEN: "short" })).toThrow(/RAG_AGENT_TOKEN/);
  });

  it("forbids the mock provider in production", () => {
    const prod = { ...valid, NODE_ENV: "production", APP_URL: "https://app.example.com" };
    expect(() => parseEnv({ ...prod, ALLOW_MOCK_PROVIDER: "true" })).toThrow(/ALLOW_MOCK_PROVIDER/);
    expect(parseEnv(prod).ALLOW_MOCK_PROVIDER).toBe(false);
  });

  it("validates Cloudinary settings", () => {
    const c = { ...valid, STORAGE_DRIVER: "cloudinary", CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" };
    expect(parseEnv(c)).toMatchObject({ STORAGE_DRIVER: "cloudinary", CLOUDINARY_FOLDER: "studyforge/documents" });
    expect(parseEnv(c).CLOUDINARY_MAX_FILE_BYTES).toBeUndefined();
    expect(parseEnv({ ...c, CLOUDINARY_MAX_FILE_BYTES: "10485760" }).CLOUDINARY_MAX_FILE_BYTES).toBe(10485760);
    expect(() => parseEnv({ ...c, CLOUDINARY_FOLDER: "../escape" })).toThrow(/CLOUDINARY_FOLDER/);
    expect(() => parseEnv({ ...c, CLOUDINARY_API_SECRET: "" })).toThrow(/CLOUDINARY_API_SECRET/);
    // credentials are optional while another driver is selected
    expect(parseEnv({ ...valid, STORAGE_DRIVER: "local" }).STORAGE_DRIVER).toBe("local");
  });

  it("requires S3 settings when STORAGE_DRIVER=s3", () => {
    expect(() => parseEnv({ ...valid, STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
  });

  it("applies upload and AI limit defaults", () => {
    const env = parseEnv(valid);
    expect(env.MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(env.MAX_FILES_PER_UPLOAD).toBe(10);
    expect(env.RETRIEVAL_MIN_SIMILARITY).toBeCloseTo(0.3);
  });

  it("never echoes secret values in error messages", () => {
    try {
      parseEnv({ ...valid, BETTER_AUTH_SECRET: "super-secret-short" });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("super-secret-short");
    }
  });
});

describe("Google sign-in configuration", () => {
  const google = { AUTH_GOOGLE_ID: "123-test.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "test-only-google-client-secret" };

  it("is optional and off by default", () => {
    expect(isGoogleConfigured(parseEnv(valid))).toBe(false);
  });

  it("is on when both the client id and secret are set", () => {
    expect(isGoogleConfigured(parseEnv({ ...valid, ...google }))).toBe(true);
  });

  it("refuses half a configuration, without echoing the values", () => {
    expect(() => parseEnv({ ...valid, AUTH_GOOGLE_ID: google.AUTH_GOOGLE_ID })).toThrow(/set both or neither/);
    try {
      parseEnv({ ...valid, AUTH_GOOGLE_SECRET: google.AUTH_GOOGLE_SECRET });
    } catch (e) {
      expect(String(e)).not.toContain(google.AUTH_GOOGLE_SECRET);
    }
  });
});
