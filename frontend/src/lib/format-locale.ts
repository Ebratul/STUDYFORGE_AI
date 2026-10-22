import { INTL_TAG, type Locale } from "@/lib/i18n/config";
import { createT, type TFunction } from "@/lib/i18n/translate";

export type Formatters = {
  locale: Locale;
  number(n: number, opts?: Intl.NumberFormatOptions): string;
  /** Basis points (8750) → "87.50%" (Bengali digits in `bn`). */
  percentBp(bp: number): string;
  date(value: string | Date | null | undefined): string;
  dateTime(value: string | Date | null | undefined): string;
  /** "Friday, October 23, 2026 at 2:20 PM" */
  dateTimeLong(value: string | Date | null | undefined): string;
  time(value: string | Date | null | undefined): string;
  /** "Oct 23" */
  dateShort(value: string | Date | null | undefined): string;
  /** Centi-marks (875) → "8.75" / "9" in the locale's digits. */
  centi(centi: number): string;
  /** Marks (8.75) without trailing zeros. */
  marks(marks: number): string;
  /** "3 days ago" / "in 2 hours". */
  relative(value: string | Date, now?: Date): string;
};

const valid = (v: string | Date | null | undefined): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Locale-aware formatters; `timeZone` (the user's profile zone) is used when valid, otherwise the browser/server zone. */
export function makeFormatters(locale: Locale, timeZone?: string): Formatters {
  const tag = INTL_TAG[locale];
  const tz = (() => {
    if (!timeZone) return undefined;
    try {
      new Intl.DateTimeFormat(tag, { timeZone });
      return timeZone;
    } catch {
      return undefined;
    }
  })();
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, { ...o, ...(tz ? { timeZone: tz } : {}) });
  return {
    locale,
    number: (n, opts) => new Intl.NumberFormat(tag, opts).format(n),
    centi: (c) => new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(c / 100),
    marks: (m) => new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }).format(m),
    percentBp: (bp) => `${new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bp / 100)}%`,
    date: (v) => { const d = valid(v); return d ? fmt({ dateStyle: "medium" }).format(d) : "—"; },
    dateTime: (v) => { const d = valid(v); return d ? fmt({ dateStyle: "medium", timeStyle: "short" }).format(d) : "—"; },
    dateShort: (v) => { const d = valid(v); return d ? fmt({ month: "short", day: "numeric" }).format(d) : "—"; },
    dateTimeLong: (v) => { const d = valid(v); return d ? fmt({ dateStyle: "full", timeStyle: "short" }).format(d) : "—"; },
    time: (v) => { const d = valid(v); return d ? fmt({ timeStyle: "short" }).format(d) : "—"; },
    relative: (v, now = new Date()) => {
      const d = valid(v);
      if (!d) return "—";
      const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
      const units: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
      const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });
      for (const [unit, sec] of units) if (Math.abs(diffSec) >= sec || unit === "second") return rtf.format(Math.trunc(diffSec / sec), unit);
      return "—";
    },
  };
}

/** What pure helper functions need to produce user-visible text: translate + format. Defaults to English. */
export type I18n = { t: TFunction; format: Formatters };
export const EN: I18n = { t: createT("en", {}), format: makeFormatters("en") };
