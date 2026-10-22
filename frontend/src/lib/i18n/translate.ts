import { DEFAULT_LOCALE, INTL_TAG, type Locale } from "./config";
import { DYNAMIC_MESSAGES } from "./dynamic";

export type Vars = Record<string, string | number | null | undefined>;
export type Catalog = Readonly<Record<string, string>>;
export type TFunction = (message: string, vars?: Vars) => string;

/** Marks a string for extraction (scripts/i18n-coverage.mjs) without translating it yet; translate at render with `t(value)`. */
export const msg = <T extends string>(message: T): T => message;

const warned = new Set<string>();

function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_TAG[locale], { maximumFractionDigits: 20 }).format(n);
}

/** Finds the matching close brace for the `{` at `start`. */
function closeBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * ICU-lite: `{name}` substitutes a variable (numbers use the locale's digits); `{count, plural, one {# item} other {# items}}` picks a
 * branch with `Intl.PluralRules` (`=0` exact branches are supported) and replaces `#` with the formatted count.
 */
export function interpolate(template: string, vars: Vars | undefined, locale: Locale): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]!;
    if (ch !== "{") {
      out += ch;
      continue;
    }
    const end = closeBrace(template, i);
    if (end === -1) {
      out += ch;
      continue;
    }
    const inner = template.slice(i + 1, end);
    const m = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (m) {
      const value = Number(vars?.[m[1]!]);
      const branches = new Map<string, string>();
      const body = m[2]!;
      for (let j = 0; j < body.length; ) {
        const rest = /^\s*(=\d+|\w+)\s*\{/.exec(body.slice(j));
        if (!rest) break;
        const open = j + rest[0].length - 1;
        const close = closeBrace(body, open);
        if (close === -1) break;
        branches.set(rest[1]!, body.slice(open + 1, close));
        j = close + 1;
      }
      const rule = new Intl.PluralRules(INTL_TAG[locale]).select(Number.isFinite(value) ? value : 0);
      const chosen = branches.get(`=${value}`) ?? branches.get(rule) ?? branches.get("other") ?? "";
      out += interpolate(chosen.replaceAll("#", formatNumber(Number.isFinite(value) ? value : 0, locale)), vars, locale);
    } else {
      const v = vars?.[inner.trim()];
      out += v === undefined || v === null ? `{${inner}}` : typeof v === "number" ? formatNumber(v, locale) : String(v);
    }
    i = end;
  }
  return out;
}

/**
 * Messages the server composes in English with values baked in ("You've used all 3 attempts for this exam.") are matched against
 * DYNAMIC_MESSAGES and re-rendered from the translated template with the captured values.
 */
function fromPattern(message: string, catalog: Catalog, locale: Locale): string | null {
  for (const d of DYNAMIC_MESSAGES) {
    const m = d.re.exec(message);
    const template = m && catalog[d.key];
    if (m && template) return interpolate(template, Object.fromEntries(d.vars.map((v, i) => [v, /^\d+$/.test(m[i + 1]!) ? Number(m[i + 1]) : m[i + 1]!])), locale);
  }
  return null;
}

/**
 * Builds `t(englishText, vars?)`. The English text IS the key: English renders it directly; other locales look it up in their catalog
 * and fall back to the English text, so an untranslated string is always readable English and never a raw key id.
 */
export function createT(locale: Locale, catalogs: Partial<Record<Locale, Catalog>>, opts: { warn?: boolean } = {}): TFunction {
  const catalog = locale === DEFAULT_LOCALE ? undefined : catalogs[locale];
  return (message, vars) => {
    let template = message;
    if (catalog) {
      const found = catalog[message];
      const dynamic = found === undefined || found === "" ? (vars ? null : fromPattern(message, catalog, locale)) : null;
      if (dynamic !== null) return dynamic;
      if (found !== undefined && found !== "") template = found;
      else if (opts.warn && !warned.has(`${locale}:${message}`)) {
        warned.add(`${locale}:${message}`);
        console.warn(`[i18n] missing ${locale} translation: ${message}`);
      }
    }
    return vars || template.includes("{") ? interpolate(template, vars, locale) : template;
  };
}
