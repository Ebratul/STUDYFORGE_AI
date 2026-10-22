import { createHash } from "node:crypto";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** NFC, strip control characters (keeps \n and \t), unify line endings, trim. */
export function cleanText(s: string): string {
  return s.normalize("NFC").replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
}

/** Comparison key: NFKC, lower-case, punctuation/symbols removed, whitespace collapsed. Bangla combining marks are kept. */
export function normKey(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function tokens(s: string): Set<string> {
  const k = normKey(s);
  return new Set(k ? k.split(" ") : []);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function normalizeTag(t: string): string {
  return cleanText(t).toLowerCase().replace(/\s+/g, " ");
}

export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = normalizeTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Slug usable in a collection `titleKey`. */
export function titleKey(title: string): string {
  return normKey(title.normalize("NFC")).replace(/\s+/g, " ");
}
