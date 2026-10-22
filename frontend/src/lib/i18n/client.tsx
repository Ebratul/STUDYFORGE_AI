"use client";

import { Children, Fragment, createContext, useContext, useMemo, type ReactNode } from "react";
import { catalogs } from "./catalog";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from "./config";
import { createT, type TFunction } from "./translate";
import { makeFormatters, type Formatters } from "@/lib/format-locale";

type Ctx = { locale: Locale; t: TFunction; format: Formatters };
const LocaleContext = createContext<Ctx>({ locale: DEFAULT_LOCALE, t: createT(DEFAULT_LOCALE, {}), format: makeFormatters(DEFAULT_LOCALE) });

export function LocaleProvider({ locale, timeZone, children }: { locale: Locale; timeZone?: string; children: ReactNode }) {
  const value = useMemo<Ctx>(
    () => ({ locale, t: createT(locale, catalogs, { warn: process.env.NODE_ENV === "development" }), format: makeFormatters(locale, timeZone) }),
    [locale, timeZone],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export const useT = (): TFunction => useContext(LocaleContext).t;

/**
 * Translation with React elements inside the sentence (links, bold): `rich("Read the {terms} first", { terms: <Link …>terms</Link> })`.
 * The whole sentence is one translatable string, so word order can differ per language.
 */
export function useRich(): (message: string, nodes: Record<string, ReactNode>, vars?: Parameters<TFunction>[1]) => ReactNode {
  const t = useT();
  return (message, nodes, vars) => {
    const text = t(message, vars);
    const parts = text.split(/(\{\w+\})/g);
    return Children.toArray(parts.map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      return m && m[1]! in nodes ? <Fragment key={i}>{nodes[m[1]!]}</Fragment> : part;
    }));
  };
}
export const useLocale = (): Locale => useContext(LocaleContext).locale;
/** `{ t, format, locale }` for passing into pure helper functions (see `I18n` in format-locale.ts). */
export const useI18n = (): Ctx => useContext(LocaleContext);
export const useFormat = (): Formatters => useContext(LocaleContext).format;

/** Remembers the choice in a first-party cookie (SameSite=Lax, one year). The caller also saves it to the account preference. */
export function writeLocaleCookie(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}
