const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|session|ciphertext|set-cookie/i;
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-(?:or-|proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / OpenRouter style
  /\bgsk_[A-Za-z0-9]{16,}/g, // Groq
  /\b(postgres(?:ql)?|smtp|redis)s?:\/\/[^\s"']*:[^\s"'@]+@/gi, // credentials inside URLs
];

export const REDACTED = "[REDACTED]";

export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => (m.includes("://") ? m.replace(/:\/\/[^@]*@/, `://${REDACTED}@`) : REDACTED));
  }
  return out;
}

/** Deep-redacts secrets from arbitrary log/audit payloads. Never mutates the input. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1),
      ]),
    ) as T;
  }
  return value;
}
