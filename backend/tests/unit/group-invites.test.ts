import { describe, expect, it } from "vitest";
import { base32, formatCode, generateCode, hashCode, inviteStatus, normalizeCode } from "../../src/modules/groups/invites.js";

describe("invite codes", () => {
  it("base32 encodes known vectors (RFC 4648, no padding)", () => {
    expect(base32(new TextEncoder().encode("f"))).toBe("MY");
    expect(base32(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(base32(new Uint8Array(16))).toBe("A".repeat(26));
  });

  it("generates 26-character codes from 128 random bits, all distinct", () => {
    const codes = new Set(Array.from({ length: 2000 }, generateCode));
    expect(codes.size).toBe(2000);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{26}$/);
  });

  it("round-trips through the grouped display form and tolerant input", () => {
    const code = generateCode();
    const shown = formatCode(code);
    expect(shown).toMatch(/^([A-Z2-7]{5}-){5}[A-Z2-7]$/);
    expect(normalizeCode(shown)).toBe(code);
    expect(normalizeCode(` ${shown.toLowerCase()} `)).toBe(code);
    expect(normalizeCode(shown.replaceAll("-", " "))).toBe(code);
  });

  it("rejects strings that cannot be codes", () => {
    for (const bad of ["", "abc", "A".repeat(25), "A".repeat(27), "1".repeat(26), "<script>"]) expect(normalizeCode(bad)).toBeNull();
  });

  it("hashes deterministically and only the hash differs per code", () => {
    const code = generateCode();
    expect(hashCode(code)).toBe(hashCode(code));
    expect(hashCode(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(code)).not.toBe(hashCode(generateCode()));
    expect(hashCode(code)).not.toContain(code);
  });

  it("derives a status with REVOKED > EXPIRED > USED_UP > ACTIVE", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const base = { revokedAt: null, expiresAt: new Date("2026-01-02T00:00:00Z"), maxUses: 2, useCount: 0 };
    expect(inviteStatus(base, at)).toBe("ACTIVE");
    expect(inviteStatus({ ...base, useCount: 2 }, at)).toBe("USED_UP");
    expect(inviteStatus({ ...base, expiresAt: at }, at)).toBe("EXPIRED"); // expires exactly at the instant
    expect(inviteStatus({ ...base, useCount: 2, expiresAt: new Date("2025-12-31T00:00:00Z") }, at)).toBe("EXPIRED");
    expect(inviteStatus({ ...base, revokedAt: at, expiresAt: new Date("2025-12-31T00:00:00Z") }, at)).toBe("REVOKED");
  });
});
