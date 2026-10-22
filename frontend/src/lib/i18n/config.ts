/**
 * Locales and cookie settings. English is the source language: its message KEYS are the English text itself (see translate.ts), so
 * unmatched/missing translations fall back to correct English and a raw key can never be shown.
 */
export const LOCALES = ["en", "bn"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "sf-locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_LABEL: Record<Locale, string> = { en: "English", bn: "বাংলা" };
/** BCP-47 tag used for Intl formatting. `bn-BD` uses Bengali digits (numbering system `beng`). */
export const INTL_TAG: Record<Locale, string> = { en: "en", bn: "bn-BD" };

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);
