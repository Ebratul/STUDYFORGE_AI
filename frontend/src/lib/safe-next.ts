/**
 * Only allow same-site relative redirects after sign-in (prevents open-redirect abuse).
 * Rejects anything that a browser could resolve to another origin: absolute and protocol-relative URLs, backslashes,
 * control characters or whitespace (browsers strip tabs/newlines, so "/\t/evil.example" would become "//evil.example"),
 * and anything whose parsed origin differs from the app's.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/workspace"): string {
  if (!value || value.length > 2048) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return fallback;
  }
  try {
    if (new URL(value, "http://app.invalid").origin !== "http://app.invalid") return fallback;
  } catch {
    return fallback;
  }
  if (/^\/(login|register)(?![\w-])/.test(value)) return fallback;
  return value;
}
