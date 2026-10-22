import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every environment variable the app reads (outside Next/Node built-ins) must be in `.env.example`, and nothing sensitive may be NEXT_PUBLIC_. */
const root = resolve(__dirname, "../..");
const BUILT_IN = new Set(["NODE_ENV", "NEXT_RUNTIME", "PORT", "HOSTNAME", "CI"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

const used = new Set<string>();
for (const file of walk(join(root, "src"))) for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]!);
const example = readFileSync(join(root, ".env.example"), "utf8");
const documented = new Set([...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

describe("frontend .env.example", () => {
  it("documents every variable read by src/", () => {
    expect(used.has("BACKEND_URL")).toBe(true); // guards the scanner itself
    expect([...used].filter((k) => !BUILT_IN.has(k) && !documented.has(k))).toEqual([]);
  });

  it("documents nothing the code does not read", () => {
    expect([...documented].filter((k) => !used.has(k))).toEqual([]);
  });

  it("never exposes secrets through NEXT_PUBLIC_ variables", () => {
    expect([...used, ...documented].filter((k) => k.startsWith("NEXT_PUBLIC_") && /KEY|SECRET|TOKEN|PASSWORD/.test(k))).toEqual([]);
  });
});
