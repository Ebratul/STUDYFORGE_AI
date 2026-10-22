import { describe, expect, it } from "vitest";
import { LIMITS, preferencesInput } from "../../src/modules/ai/preferences.js";
import { apiKeySchema } from "../../src/modules/ai/credentials.js";

const ok = { provider: "openai", modelId: "gpt-4o-mini", temperature: 0.5, topP: 0.9, maxTokens: 1024 };

describe("model preference validation", () => {
  it("accepts a valid entry and null (clear)", () => {
    expect(preferencesInput.safeParse({ default: ok, tasks: { CHAT: null } }).success).toBe(true);
  });
  it("enforces generation limits", () => {
    for (const bad of [{ temperature: LIMITS.temperature.max + 0.1 }, { temperature: -0.1 }, { topP: 1.1 }, { maxTokens: 0 }, { maxTokens: LIMITS.maxTokens.max + 1 }, { maxTokens: 1.5 }]) {
      expect(preferencesInput.safeParse({ default: { ...ok, ...bad } }).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("rejects malformed model ids", () => {
    for (const id of ["", " ", "a b", "bad;id", "../x", "a".repeat(201)]) {
      expect(preferencesInput.safeParse({ default: { ...ok, modelId: id } }).success, id).toBe(false);
    }
    for (const id of ["gpt-4o-mini", "meta-llama/llama-3.3-70b-instruct:free", "text-embedding-3-small", "openai/gpt-4o@2024"])
      expect(preferencesInput.safeParse({ default: { ...ok, modelId: id } }).success, id).toBe(true);
  });
  it("strips unknown task keys instead of accepting them", () => {
    const r = preferencesInput.safeParse({ tasks: { HACK: ok } });
    expect(r.success).toBe(true);
    expect(Object.keys((r as { data: { tasks: object } }).data.tasks)).toEqual([]);
  });
});

describe("api key shape", () => {
  it("accepts typical keys and rejects whitespace, control chars and absurd lengths", () => {
    expect(apiKeySchema.safeParse("sk-abcdefghij1234567890").success).toBe(true);
    for (const k of ["short", "has space in it", "tab\tkey12345", "new\nline12345", "ключ-кириллица-12345", "a".repeat(513)]) expect(apiKeySchema.safeParse(k).success, k).toBe(false);
  });
});
