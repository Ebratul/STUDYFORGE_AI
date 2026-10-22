import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every variable the backend parses must be documented in `.env.example` (active or commented out), and the example
 * must not document variables the code no longer reads. Keeps deployment docs from drifting away from `src/config/env.ts`.
 */
const root = resolve(__dirname, "../..");
const envSrc = readFileSync(resolve(root, "src/config/env.ts"), "utf8");
const example = readFileSync(resolve(root, ".env.example"), "utf8");

const schemaBlock = envSrc.slice(envSrc.indexOf("z.object({"), envSrc.indexOf("export type Env"));
const parsed = new Set([...schemaBlock.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!));
const documented = new Set([...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

describe("backend .env.example matches src/config/env.ts", () => {
  it("finds the schema keys (guards the parser itself)", () => {
    expect(parsed.size).toBeGreaterThan(40);
    expect(parsed.has("DATABASE_URL")).toBe(true);
    expect(parsed.has("RAG_AGENT_TOKEN")).toBe(true);
  });

  it("documents every parsed variable", () => {
    expect([...parsed].filter((k) => !documented.has(k))).toEqual([]);
  });

  it("does not document variables the code ignores", () => {
    expect([...documented].filter((k) => !parsed.has(k))).toEqual([]);
  });

  it("contains placeholders only (no real-looking secrets)", () => {
    expect(example).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(example).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});
