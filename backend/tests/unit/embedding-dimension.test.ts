import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { DIMENSION_LIMITS, embeddingCredentials, isValidDimension, LEGACY_DIMENSION, resolveRequestedDimension } from "../../src/modules/ai/embedding-identity.js";

const saved = (modelId: string, dimension: number | null) => ({ modelId, dimension });

describe("resolveRequestedDimension — database settings override the environment default (EMBEDDING_SETTINGS_SPEC §2)", () => {
  it("a typed number always wins", () => {
    expect(resolveRequestedDimension(512, saved("m", 1024), "m", 2048)).toEqual({ requested: 512, source: "request" });
    expect(resolveRequestedDimension(512, null, "m", null)).toEqual({ requested: 512, source: "request" });
  });

  it("omitted keeps the SAVED size for the same model, ahead of the deployment default", () => {
    expect(resolveRequestedDimension(undefined, saved("m", 1024), "m", 2048)).toEqual({ requested: 1024, source: "database" });
  });

  it("a saved size is never inherited by another model", () => {
    expect(resolveRequestedDimension(undefined, saved("m", 1024), "other", 2048)).toEqual({ requested: 2048, source: "environment" });
    expect(resolveRequestedDimension(undefined, saved("m", 1024), "other", null)).toEqual({ requested: null, source: "model" });
  });

  it("explicit Automatic (null) ignores the saved size and uses the deployment default, else the model's own size", () => {
    expect(resolveRequestedDimension(null, saved("m", 1024), "m", 2048)).toEqual({ requested: 2048, source: "environment" });
    expect(resolveRequestedDimension(null, saved("m", 1024), "m", null)).toEqual({ requested: null, source: "model" });
  });

  it("with nothing saved the deployment default seeds the value, and without one the model decides", () => {
    expect(resolveRequestedDimension(undefined, null, "m", 768)).toEqual({ requested: 768, source: "environment" });
    expect(resolveRequestedDimension(undefined, null, "m", null)).toEqual({ requested: null, source: "model" });
  });

  it("a saved row without a recorded size does not count as a saved size", () => {
    expect(resolveRequestedDimension(undefined, saved("m", null), "m", 768)).toEqual({ requested: 768, source: "environment" });
  });

  it("0 is a (typed) value, not 'unset'", () => {
    expect(resolveRequestedDimension(0, saved("m", 1024), "m", 2048)).toEqual({ requested: 0, source: "request" }); // rejected later by the range check
  });
});

describe("dimension limits", () => {
  it("accepts whole numbers within 8..4096 only", () => {
    for (const ok of [8, 1536, 4096]) expect(isValidDimension(ok)).toBe(true);
    for (const bad of [0, 7, 4097, -1, 1.5, NaN, Infinity, "512", null, undefined, true]) expect(isValidDimension(bad)).toBe(false);
    expect(DIMENSION_LIMITS).toEqual({ min: 8, max: 4096 });
  });
});

describe("embeddingCredentials — what rag_agent is told", () => {
  const emb = { provider: "OPENAI" as const, modelId: "text-embedding-3-large", embeddingDimension: 1024, embeddingRequestDimensions: 1024 };
  it("always names the dimension and sends the request parameter only when it was verified", () => {
    expect(embeddingCredentials(emb, "k")).toEqual({ provider: "openai", api_key: "k", model: "text-embedding-3-large", dimension: 1024, request_dimensions: 1024 });
    expect(embeddingCredentials({ ...emb, embeddingRequestDimensions: null }, "k")).toEqual({ provider: "openai", api_key: "k", model: "text-embedding-3-large", dimension: 1024 });
  });
  it("rows from before the dimension was recorded are 1536-dimensional by construction", () => {
    expect(embeddingCredentials({ ...emb, embeddingDimension: null, embeddingRequestDimensions: null }, "k").dimension).toBe(LEGACY_DIMENSION);
  });
});

describe("EMBEDDING_DIMENSIONS (deployment default)", () => {
  const base = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(32),
    APP_URL: "http://localhost:3000",
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    RAG_AGENT_TOKEN: "t".repeat(24),
  };
  it("is optional", () => {
    expect(parseEnv(base).EMBEDDING_DIMENSIONS).toBeUndefined();
    expect(parseEnv({ ...base, EMBEDDING_DIMENSIONS: "" }).EMBEDDING_DIMENSIONS).toBeUndefined();
  });
  it("accepts a whole number from 8 to 4096", () => {
    expect(parseEnv({ ...base, EMBEDDING_DIMENSIONS: "2048" }).EMBEDDING_DIMENSIONS).toBe(2048);
    expect(parseEnv({ ...base, EMBEDDING_DIMENSIONS: "8" }).EMBEDDING_DIMENSIONS).toBe(8);
    expect(parseEnv({ ...base, EMBEDDING_DIMENSIONS: "4096" }).EMBEDDING_DIMENSIONS).toBe(4096);
  });
  it.each(["7", "4097", "0", "-5", "12.5", "abc"])("rejects %s with a value-free message", (v) => {
    expect(() => parseEnv({ ...base, EMBEDDING_DIMENSIONS: v })).toThrow(/EMBEDDING_DIMENSIONS/);
  });
});
