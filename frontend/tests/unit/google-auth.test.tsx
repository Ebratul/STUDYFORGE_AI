import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_ERRORS, GOOGLE_ERROR_FALLBACK, googleErrorCallback, googleErrorFor, withAuthNotice } from "@/lib/google-auth";
import { safeNextPath } from "@/lib/safe-next";

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signIn: { social: vi.fn() }, linkSocial: vi.fn(), unlinkAccount: vi.fn(), requestPasswordReset: vi.fn() } }));

const { GoogleButtonView, GoogleSignIn } = await import("@/components/auth/google-sign-in");
const { SignInMethodsCard } = await import("@/components/account/sign-in-methods");
const html = (el: React.ReactElement, q = "") => {
  search = q;
  return renderToStaticMarkup(el);
};

describe("Google error messages", () => {
  it("maps known codes and falls back to a generic message for anything else", () => {
    expect(googleErrorFor("access_denied")).toMatchObject({ tone: "info" });
    expect(googleErrorFor("account_not_linked")?.message).toContain("connect Google");
    expect(googleErrorFor("some_new_code")).toEqual({ message: GOOGLE_ERROR_FALLBACK, tone: "error" });
    expect(googleErrorFor(null)).toBeNull();
    expect(googleErrorFor("")).toBeNull();
  });

  it("is not fooled by inherited object keys", () => {
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(googleErrorFor(code)?.message).toBe(GOOGLE_ERROR_FALLBACK);
  });

  it("covers the failure codes the server can produce", () => {
    for (const code of ["access_denied", "account_not_linked", "email_not_verified", "email_not_found", "invalid_identity", "account_suspended", "state_mismatch", "state_not_found", "invalid_code", "email_does_not_match", "account_already_linked_to_different_user", "unable_to_create_user"]) {
      expect(Object.keys(GOOGLE_ERRORS)).toContain(code);
    }
  });
});

describe("post-login redirect targets", () => {
  it("adds the one-shot notice to a path and keeps its query and hash", () => {
    expect(withAuthNotice("/workspace", "google")).toBe("/workspace?auth=google");
    expect(withAuthNotice("/exams/abc?tab=2#top", "google-new")).toBe("/exams/abc?tab=2&auth=google-new#top");
  });

  it("never produces an off-site target, whatever `next` contains", () => {
    for (const evil of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "javascript:alert(1)"]) {
      const target = withAuthNotice(safeNextPath(evil), "google");
      expect(new URL(target, "https://app.example").origin).toBe("https://app.example");
      expect(target.startsWith("/") && !target.startsWith("//")).toBe(true);
    }
  });

  it("sends errors back to the page the user started from, preserving a valid `next` only", () => {
    expect(googleErrorCallback("login", null)).toBe("/login");
    expect(googleErrorCallback("register", "/exams/1")).toBe("/register?next=%2Fexams%2F1");
    expect(googleErrorCallback("login", "https://evil.example")).toBe("/login");
    expect(googleErrorCallback("login", "//evil.example")).toBe("/login");
  });
});

describe("Google sign-in button", () => {
  it("renders an accessible, labelled button with the Google logo hidden from assistive tech", () => {
    const out = html(createElement(GoogleButtonView));
    expect(out).toContain("Continue with Google");
    expect(out).toContain('type="button"');
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(out).toContain("or continue with email");
  });

  it("shows a busy, non-clickable state while redirecting", () => {
    const out = html(createElement(GoogleButtonView, { busy: true }));
    expect(out).toContain("Connecting to Google…");
    expect(out).toContain('aria-busy="true"');
    expect(out).toMatch(/<button[^>]*disabled=""/);
  });

  it("renders nothing when Google sign-in is not configured", () => {
    expect(html(createElement(GoogleSignIn, { mode: "login", enabled: false }))).toBe("");
  });

  it("is present on both the login and registration variants when configured", () => {
    for (const mode of ["login", "register"] as const) expect(html(createElement(GoogleSignIn, { mode, enabled: true }))).toContain("Continue with Google");
  });

  it("shows cancellation as a neutral status and real failures as alerts", () => {
    const cancelled = html(createElement(GoogleSignIn, { mode: "login", enabled: true }), "error=access_denied");
    expect(cancelled).toContain("Google sign-in was cancelled");
    expect(cancelled).toContain('role="status"');
    const failed = html(createElement(GoogleSignIn, { mode: "login", enabled: true }), "error=email_not_verified");
    expect(failed).toContain("hasn&#x27;t verified this email");
    expect(failed).toContain('role="alert"');
  });

  it("never renders provider-supplied text from the URL", () => {
    const out = html(createElement(GoogleSignIn, { mode: "login", enabled: true }), "error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(out).not.toContain("alert(1)");
    const unknown = html(createElement(GoogleSignIn, { mode: "login", enabled: true }), "error=%3Cimg%20src%3Dx%3E");
    expect(unknown).not.toContain("<img");
  });

  it("contains no credentials", () => {
    const out = html(createElement(GoogleSignIn, { mode: "login", enabled: true }));
    expect(out).not.toMatch(/client_secret|GOCSPX|apps\.googleusercontent\.com/);
  });
});

/** The opening tag of the button whose label is `label` (so assertions are about the real `disabled` attribute, not Tailwind's `disabled:` classes). */
const buttonTag = (out: string, label: string) => [...out.matchAll(/<button[^>]*>/g)].map((m) => m[0]).find((tag) => out.slice(out.indexOf(tag) + tag.length).trimStart().startsWith(label));

describe("sign-in methods card", () => {
  const card = (methods: Parameters<typeof SignInMethodsCard>[0]["methods"]) => html(createElement(SignInMethodsCard, { methods, email: "a@example.com" }));

  it("offers to connect Google when it is available and not yet connected", () => {
    const out = card({ hasPassword: true, googleAvailable: true, google: null });
    expect(out).toContain("Connect Google");
    expect(out).not.toContain("Disconnect");
  });

  it("hides the Google row entirely when it is neither configured nor connected", () => {
    expect(card({ hasPassword: true, googleAvailable: false, google: null })).not.toContain("Google");
  });

  it("lets a user with a password disconnect Google", () => {
    const out = card({ hasPassword: true, googleAvailable: true, google: { id: "acc1", linkedAt: "2026-10-01T00:00:00Z" } });
    expect(out).toContain("Disconnect");
    expect(out).toContain("Connected");
    expect(buttonTag(out, "Disconnect")).toBeTruthy();
    expect(buttonTag(out, "Disconnect")).not.toContain('disabled=""');
  });

  it("blocks disconnecting the only sign-in method and explains how to fix it", () => {
    const out = card({ hasPassword: false, googleAvailable: true, google: { id: "acc1", linkedAt: "2026-10-01T00:00:00Z" } });
    expect(buttonTag(out, "Disconnect")).toContain('disabled=""');
    expect(out).toContain("Set a password before disconnecting it");
    expect(out).toContain("Email me a link to set one");
  });
});
