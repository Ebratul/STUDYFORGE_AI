/**
 * Google profile handling. Everything Google returns is untrusted input: it is validated and normalised here before it
 * reaches the database. Pure functions, no I/O (unit-tested).
 */

const NAME_MAX = 80; // matches profileSchema.name
const CONTROL_OR_BIDI = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}\u{200B}\u{FEFF}]/gu;

export type GoogleClaims = Record<string, unknown>;

/** Google sends a boolean, but some historic token shapes use the string "true". Anything else is NOT verified. */
export function isGoogleEmailVerified(claims: GoogleClaims | undefined): boolean {
  return claims?.email_verified === true || claims?.email_verified === "true";
}

export function normalizeGoogleEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/.test(email)) return null;
  return email;
}

/** Display name: strip control/bidi characters, collapse whitespace, cap the length; fall back to the e-mail's local part. */
export function sanitizeGoogleName(value: unknown, email: string): string {
  const cleaned = typeof value === "string" ? value.replace(CONTROL_OR_BIDI, "").replace(/\s+/g, " ").trim() : "";
  const name = Array.from(cleaned).slice(0, NAME_MAX).join("").trim();
  return name || email.split("@")[0]!.slice(0, NAME_MAX);
}

/** Avatar: only an https URL on Google's image CDN (also what the frontend CSP allows). Anything else is dropped. */
export function sanitizeGoogleImage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (host !== "googleusercontent.com" && !host.endsWith(".googleusercontent.com")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** The subset of the profile that becomes our user row. */
export function mapGoogleProfile(claims: GoogleClaims) {
  const email = normalizeGoogleEmail(claims.email);
  return {
    email: email ?? undefined,
    emailVerified: isGoogleEmailVerified(claims),
    name: sanitizeGoogleName(claims.name, email ?? "user@invalid"),
    image: sanitizeGoogleImage(claims.picture),
  };
}

/** Why a Google identity must be refused, or null when it is acceptable. Codes are redirected to the UI as `?error=<code>`. */
export function googleIdentityProblem(claims: GoogleClaims | undefined): "email_not_found" | "email_not_verified" | "invalid_identity" | null {
  if (!claims) return "invalid_identity";
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) return "invalid_identity";
  if (!normalizeGoogleEmail(claims.email)) return "email_not_found";
  if (!isGoogleEmailVerified(claims)) return "email_not_verified";
  return null;
}
