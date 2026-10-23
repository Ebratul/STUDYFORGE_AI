import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  APP_URL: "http://localhost:3000",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  RAG_AGENT_TOKEN: "t".repeat(24),
};

describe("VECTOR_STORE", () => {
  it("defaults to pgvector when unset", () => {
    expect(parseEnv(base).VECTOR_STORE).toBe("pgvector");
  });
  it.each(["pgvector", "dual", "pinecone"] as const)("accepts %s", (mode) => {
    expect(parseEnv({ ...base, VECTOR_STORE: mode }).VECTOR_STORE).toBe(mode);
  });
  it("treats an empty value as unset, like every other optional variable", () => {
    expect(parseEnv({ ...base, VECTOR_STORE: "" }).VECTOR_STORE).toBe("pgvector");
  });
  it.each(["Pinecone", "qdrant", "true", "1"])("rejects %j, naming the variable and not echoing anything sensitive", (v) => {
    expect(() => parseEnv({ ...base, VECTOR_STORE: v })).toThrow(/VECTOR_STORE/);
  });
  it("the backend has no Pinecone settings at all (credentials live only in rag_agent)", () => {
    const parsed = parseEnv({ ...base, VECTOR_STORE: "pinecone", PINECONE_API_KEY: "pcsk_should_be_ignored" } as Record<string, string>);
    expect(Object.keys(parsed).filter((k) => k.startsWith("PINECONE"))).toEqual([]);
  });
});
