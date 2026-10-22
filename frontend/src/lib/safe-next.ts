/** Only allow same-site relative redirects after sign-in (prevents open-redirect abuse). */
export function safeNextPath(value: string | null | undefined, fallback = "/workspace"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value.startsWith("/login") || value.startsWith("/register")) return fallback;
  return value;
}
