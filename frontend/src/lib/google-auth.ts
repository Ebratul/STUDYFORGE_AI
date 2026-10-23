import { safeNextPath } from "@/lib/safe-next";
import { msg } from "@/lib/i18n/translate";

/** Query parameter that tells the app a Google sign-in just completed (shown once as a toast, then removed). */
export const AUTH_NOTICE_PARAM = "auth";
export type AuthNotice = "google" | "google-new";

/** Adds the one-shot notice parameter to a (already validated, relative) path. */
export function withAuthNotice(path: string, notice: AuthNotice): string {
  const url = new URL(path, "http://app.invalid");
  url.searchParams.set(AUTH_NOTICE_PARAM, notice);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where Google sends the browser after an error or cancellation: back to the page the user started from, keeping `next`. */
export function googleErrorCallback(mode: "login" | "register", next: string | null | undefined): string {
  const base = mode === "login" ? "/login" : "/register";
  const safe = safeNextPath(next, "");
  return safe ? `${base}?next=${encodeURIComponent(safe)}` : base;
}

/**
 * Messages for the `?error=` codes Better Auth and our own validation put on the redirect. Anything unknown gets the generic text,
 * so provider-supplied descriptions are never rendered.
 */
const FAILED = msg("We couldn't complete Google sign-in. Please try again.");
const EXPIRED = msg("The Google sign-in session expired or was invalid. Please try again.");
const MISSING = msg("Google didn't share the details we need to sign you in.");

export const GOOGLE_ERRORS: Record<string, string> = {
  access_denied: msg("Google sign-in was cancelled. You can try again, or use your email and password."),
  account_not_linked: msg("An account with this email already exists. Sign in with your password, then connect Google under Settings → Privacy & account."),
  email_not_verified: msg("Google hasn't verified this email address, so we can't use it. Verify it with Google or choose another account."),
  email_not_found: MISSING,
  invalid_identity: MISSING,
  unable_to_get_user_info: MISSING,
  account_suspended: msg("This account is suspended."),
  email_does_not_match: msg("That Google account uses a different email address than your StudyForge account."),
  account_already_linked_to_different_user: msg("That Google account is already connected to another StudyForge account."),
  state_mismatch: EXPIRED,
  state_not_found: EXPIRED,
  please_restart_the_process: EXPIRED,
  invalid_callback_request: EXPIRED,
  no_code: EXPIRED,
  invalid_code: EXPIRED,
  issuer_missing: EXPIRED,
  issuer_mismatch: EXPIRED,
  unable_to_create_user: FAILED,
  unable_to_link_account: FAILED,
  internal_server_error: FAILED,
  oauth_provider_not_found: msg("Google sign-in isn't available right now."),
};
export const GOOGLE_ERROR_FALLBACK = FAILED;

export type GoogleErrorTone = "info" | "error";

/** `null` when there is no error to show. Cancelling is not an error condition, so it gets a neutral tone. */
export function googleErrorFor(code: string | null | undefined): { message: string; tone: GoogleErrorTone } | null {
  if (!code) return null;
  const key = code.toLowerCase();
  return { message: Object.hasOwn(GOOGLE_ERRORS, key) ? GOOGLE_ERRORS[key]! : GOOGLE_ERROR_FALLBACK, tone: key === "access_denied" ? "info" : "error" };
}
