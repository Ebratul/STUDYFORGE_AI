import { describe, expect, it } from "vitest";
import { googleIdentityProblem, isGoogleEmailVerified, mapGoogleProfile, normalizeGoogleEmail, sanitizeGoogleImage, sanitizeGoogleName } from "../../src/auth/google-profile.js";

describe("isGoogleEmailVerified", () => {
  it.each([[true, true], ["true", true], [false, false], ["false", false], [1, false], ["yes", false], [undefined, false], [null, false]])("%j -> %s", (value, expected) => {
    expect(isGoogleEmailVerified({ email_verified: value })).toBe(expected);
  });
  it("is false without claims", () => expect(isGoogleEmailVerified(undefined)).toBe(false));
});

describe("normalizeGoogleEmail", () => {
  it("lower-cases and trims", () => expect(normalizeGoogleEmail("  Ada.Lovelace@Example.COM ")).toBe("ada.lovelace@example.com"));
  it.each(["", "no-at-sign", "a@b", "a b@example.com", "<x>@example.com", "a@example.com,b@example.com", `${"a".repeat(250)}@example.com`, 42, null])("rejects %j", (v) => {
    expect(normalizeGoogleEmail(v)).toBeNull();
  });
});

describe("sanitizeGoogleName", () => {
  it("strips control and bidi-override characters and collapses whitespace", () => {
    expect(sanitizeGoogleName("  Ada ‮  Lovelace\u0000\n", "ada@example.com")).toBe("Ada Lovelace");
  });
  it("caps the length at 80 characters without splitting a character", () => {
    const name = sanitizeGoogleName("😀".repeat(200), "a@example.com");
    expect(Array.from(name)).toHaveLength(80);
  });
  it("falls back to the e-mail local part", () => {
    expect(sanitizeGoogleName(undefined, "kabir@example.com")).toBe("kabir");
    expect(sanitizeGoogleName("‮\u0000", "kabir@example.com")).toBe("kabir");
  });
  it("keeps Bangla and other scripts", () => expect(sanitizeGoogleName("রহিম উদ্দিন", "r@example.com")).toBe("রহিম উদ্দিন"));
});

describe("sanitizeGoogleImage", () => {
  it("accepts https URLs on Google's image CDN", () => {
    expect(sanitizeGoogleImage("https://lh3.googleusercontent.com/a/abc=s96-c")).toBe("https://lh3.googleusercontent.com/a/abc=s96-c");
  });
  it.each([
    "http://lh3.googleusercontent.com/a/x",
    "https://evil.example/a.png",
    "https://googleusercontent.com.evil.example/a.png",
    "https://evilgoogleusercontent.com/a.png",
    "https://user:pass@lh3.googleusercontent.com/a",
    "https://lh3.googleusercontent.com:8443/a",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "not a url",
    `https://lh3.googleusercontent.com/${"a".repeat(3000)}`,
    42,
    undefined,
  ])("rejects %j", (v) => expect(sanitizeGoogleImage(v)).toBeUndefined());
});

describe("googleIdentityProblem", () => {
  const ok = { sub: "1234567890", email: "a@example.com", email_verified: true };
  it("accepts a verified identity", () => expect(googleIdentityProblem(ok)).toBeNull());
  it("requires claims", () => expect(googleIdentityProblem(undefined)).toBe("invalid_identity"));
  it("requires a subject", () => {
    expect(googleIdentityProblem({ ...ok, sub: "" })).toBe("invalid_identity");
    expect(googleIdentityProblem({ ...ok, sub: 123 })).toBe("invalid_identity");
  });
  it("requires an e-mail, then a verified e-mail", () => {
    expect(googleIdentityProblem({ ...ok, email: undefined })).toBe("email_not_found");
    expect(googleIdentityProblem({ ...ok, email_verified: false })).toBe("email_not_verified");
  });
});

describe("mapGoogleProfile", () => {
  it("returns only the allow-listed fields", () => {
    const mapped = mapGoogleProfile({ sub: "1", email: "A@Example.com", email_verified: true, name: "Ada", picture: "https://lh3.googleusercontent.com/a/1", role: "ADMIN", status: "SUSPENDED" });
    expect(Object.keys(mapped).sort()).toEqual(["email", "emailVerified", "image", "name"]);
    expect(mapped).toMatchObject({ email: "a@example.com", emailVerified: true, name: "Ada" });
  });
  it("cannot be tricked into granting a role", () => {
    expect(mapGoogleProfile({ email: "a@example.com", email_verified: true, role: "ADMIN" })).not.toHaveProperty("role");
  });
});
