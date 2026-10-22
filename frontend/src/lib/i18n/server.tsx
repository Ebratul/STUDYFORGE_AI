import "server-only";
import { Fragment, cache } from "react";
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, type Locale } from "./config";
import { catalogs } from "./catalog";
import { resolveLocale } from "./resolve";
import { createT, type TFunction } from "./translate";
import { getMe } from "@/lib/server/backend";
import { makeFormatters } from "@/lib/format-locale";

/** The request's locale: cookie → saved preference (only looked up when there is no cookie) → Accept-Language → English. */
export const getLocale = cache(async (): Promise<Locale> => {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value ?? null;
  const acceptLanguage = (await headers()).get("accept-language");
  const preference = cookie ? null : ((await getMe())?.preference.locale ?? null);
  return resolveLocale({ cookie, preference, acceptLanguage });
});

export async function getT(): Promise<TFunction> {
  return createT(await getLocale(), catalogs, { warn: process.env.NODE_ENV === "development" });
}

/** Server-side `rich()` for sentences that contain React elements (see `useRich` in client.tsx). */
export async function getRich() {
  const t = await getT();
  return (message: string, nodes: Record<string, import("react").ReactNode>, vars?: Parameters<typeof t>[1]) => {
    const parts = t(message, vars).split(/(\{\w+\})/g);
    return parts.map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      return m && m[1]! in nodes ? <Fragment key={i}>{nodes[m[1]!]}</Fragment> : part;
    });
  };
}

export async function getI18n(): Promise<import("@/lib/format-locale").I18n> {
  const locale = await getLocale();
  return { t: createT(locale, catalogs, { warn: process.env.NODE_ENV === "development" }), format: makeFormatters(locale) };
}
