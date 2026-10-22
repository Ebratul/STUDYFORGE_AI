import { describe, expect, it } from "vitest";
import { passwordSchema } from "@/lib/validation/password";
import { loginSchema, preferencesSchema, profileSchema, registerSchema } from "@/lib/validation/profile";
import { safeNextPath } from "@/lib/safe-next";
import { formatBytes } from "@/lib/format";

describe("password policy", () => {
  it.each([["short1", false], ["alllettersnonumber", false], ["1234567890123", false], ["Correct-horse-9", true]])("%s -> %s", (pw, ok) => {
    expect(passwordSchema.safeParse(pw).success).toBe(ok);
  });
  it("rejects absurdly long passwords", () => {
    expect(passwordSchema.safeParse("a1".repeat(100)).success).toBe(false);
  });
});

describe("profile validation", () => {
  it("accepts a valid profile and trims input", () => {
    expect(profileSchema.parse({ name: "  Ada  ", displayName: "", bio: "", timezone: "Asia/Dhaka" }).name).toBe("Ada");
  });
  it("rejects empty name, oversized bio and bad time zone", () => {
    expect(profileSchema.safeParse({ name: "", timezone: "UTC" }).success).toBe(false);
    expect(profileSchema.safeParse({ name: "A", bio: "x".repeat(281), timezone: "UTC" }).success).toBe(false);
    expect(profileSchema.safeParse({ name: "A", timezone: "Mars/Olympus" }).success).toBe(false);
  });
  it("only accepts known themes and locales", () => {
    expect(preferencesSchema.safeParse({ theme: "NEON", locale: "en", emailNotifications: true }).success).toBe(false);
    expect(preferencesSchema.safeParse({ theme: "DARK", locale: "bn", emailNotifications: false }).success).toBe(true);
  });
  it("normalises login and register emails", () => {
    expect(loginSchema.parse({ email: " A@B.CO ", password: "x" }).email).toBe("a@b.co");
    expect(registerSchema.safeParse({ name: "A", email: "nope" }).success).toBe(false);
  });
});

describe("safeNextPath (open-redirect guard)", () => {
  it.each([
    ["/dashboard", "/dashboard"], ["/settings/profile?tab=1", "/settings/profile?tab=1"], ["//evil.com", "/workspace"], ["https://evil.com", "/workspace"],
    ["/\\evil.com", "/workspace"], ["javascript:alert(1)", "/workspace"], ["/login", "/workspace"], [null, "/workspace"], ["", "/workspace"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNextPath(input as string | null)).toBe(expected);
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
