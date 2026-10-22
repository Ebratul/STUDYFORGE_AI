import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from "./config";

/** First supported language in an Accept-Language header (q-values respected), or null. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.trim().slice(2) ?? "1");
      return { base: tag.trim().toLowerCase().split("-")[0] ?? "", q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { base } of ranked) if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
  return null;
}

/** Cookie → saved preference → Accept-Language → English (docs: IMPLEMENTATION_STATUS, i18n). */
export function resolveLocale(input: { cookie?: string | null; preference?: string | null; acceptLanguage?: string | null }): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  if (isLocale(input.preference)) return input.preference;
  return localeFromAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}
