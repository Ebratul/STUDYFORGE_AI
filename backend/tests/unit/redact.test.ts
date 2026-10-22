import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactString } from "../../src/lib/redact.js";

describe("redaction", () => {
  it("masks provider-style API keys and bearer tokens in strings", () => {
    const s = redactString("failed with sk-abcdefghijklmnopqrstuv and gsk_abcdefghijklmnopqrstuv and Bearer abcdefghijkl12345");
    expect(s).not.toMatch(/sk-abcdef|gsk_abcdef|abcdefghijkl12345/);
  });

  it("masks credentials embedded in connection URLs but keeps host info", () => {
    const s = redactString("connect postgresql://user:hunter2@db.example.com:5432/app failed");
    expect(s).not.toContain("hunter2");
    expect(s).toContain("db.example.com");
  });

  it("redacts sensitive keys deeply without mutating the input", () => {
    const input = { user: "a", password: "p", nested: { apiKey: "k", Authorization: "Bearer zzzzzzzzzzzz", ok: 1 }, list: [{ token: "t" }] };
    const out = redact(input);
    expect(out.password).toBe(REDACTED);
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.Authorization).toBe(REDACTED);
    expect(out.nested.ok).toBe(1);
    expect(out.list[0]!.token).toBe(REDACTED);
    expect(input.password).toBe("p");
  });

  it("reduces errors to name and redacted message (no stack, no extras)", () => {
    const err = Object.assign(new Error("bad key sk-abcdefghijklmnopqrstuv"), { config: { headers: { authorization: "x" } } });
    const out = redact({ err }) as unknown as { err: Record<string, unknown> };
    expect(Object.keys(out.err).sort()).toEqual(["message", "name"]);
    expect(JSON.stringify(out)).not.toContain("sk-abcdef");
  });
});
