import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFormatters } from "@/lib/format-locale";
import { createT, interpolate, msg } from "@/lib/i18n/translate";
import { catalogs } from "@/lib/i18n/catalog";
import { localeFromAcceptLanguage, resolveLocale } from "@/lib/i18n/resolve";
import { DYNAMIC_MESSAGES } from "@/lib/i18n/dynamic";
import { BAND_INFO, BAND_ORDER } from "@/lib/bands";

const tEn = createT("en", catalogs);
const tBn = createT("bn", catalogs);

afterEach(() => vi.restoreAllMocks());

describe("t(): English is the source text", () => {
  it("returns the text unchanged and msg() is an identity marker", () => {
    expect(tEn("Save changes")).toBe("Save changes");
    expect(msg("Save changes")).toBe("Save changes");
  });

  it("interpolates {name} variables and leaves unknown placeholders visible", () => {
    expect(tEn("Welcome, {name}", { name: "Rafi" })).toBe("Welcome, Rafi");
    expect(tEn("Hello {who}", {})).toBe("Hello {who}");
  });

  it("picks plural branches with Intl.PluralRules and formats #", () => {
    const tpl = "{count, plural, one {# question} other {# questions}}";
    expect(tEn(tpl, { count: 1 })).toBe("1 question");
    expect(tEn(tpl, { count: 0 })).toBe("0 questions");
    expect(tEn(tpl, { count: 1234 })).toBe("1,234 questions");
    expect(tEn("{count, plural, =0 {none} one {# item} other {# items}}", { count: 0 })).toBe("none");
  });
});

describe("t(): Bangla", () => {
  it("translates through the catalog and uses Bengali digits for numbers", () => {
    expect(tBn("Save changes")).toBe("পরিবর্তন সংরক্ষণ করুন");
    expect(tBn("Attempt {n}", { n: 3 })).toBe("প্রচেষ্টা ৩");
    expect(tBn("Page {page} of {pages}", { page: 2, pages: 10 })).toBe("পৃষ্ঠা ২ / ১০");
  });

  it("applies the Bangla plural rule (0 and 1 are 'one')", () => {
    const tpl = "{count, plural, one {# question} other {# questions}}";
    expect(tBn(tpl, { count: 1 })).toBe("১টি প্রশ্ন");
    expect(tBn(tpl, { count: 0 })).toBe("০টি প্রশ্ন");
    expect(tBn(tpl, { count: 25 })).toBe("২৫টি প্রশ্ন");
  });

  it("falls back to the English text (never a key id) when a translation is missing", () => {
    expect(tBn("A sentence nobody translated yet")).toBe("A sentence nobody translated yet");
    expect(tBn("Hello {name}", { name: "Mina" })).toBe("Hello Mina");
    const empty = createT("bn", { bn: { "Save changes": "" } });
    expect(empty("Save changes")).toBe("Save changes");
  });

  it("warns once per missing key, and only when asked to (development)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createT("bn", catalogs)("Missing one");
    expect(warn).not.toHaveBeenCalled();
    const dev = createT("bn", catalogs, { warn: true });
    dev("Missing two");
    dev("Missing two");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Missing two");
    createT("en", catalogs, { warn: true })("Anything");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("renders server messages with baked-in values from their translated template", () => {
    expect(tBn("You've used all 3 attempts for this exam.")).toBe("এই পরীক্ষার ৩টি প্রচেষ্টা সবই আপনি ব্যবহার করে ফেলেছেন।");
    expect(tBn("An exam can have up to 50 questions.")).toBe("একটি পরীক্ষায় সর্বোচ্চ ৫০টি প্রশ্ন থাকতে পারে।");
    expect(tBn("Results for “Midterm 1” are ready.")).toBe("“Midterm 1”-এর ফলাফল প্রস্তুত।");
    expect(tBn("You were removed from Physics club")).toBe("আপনাকে Physics club থেকে সরিয়ে দেওয়া হয়েছে");
    expect(tEn("You've used all 3 attempts for this exam.")).toBe("You've used all 3 attempts for this exam.");
  });

  it("has a translated template for every dynamic server-message pattern", () => {
    for (const d of DYNAMIC_MESSAGES) expect(catalogs.bn?.[d.key], d.key).toBeTruthy();
  });

  it("keeps the supportive result bands translated (labels, ranges, messages)", () => {
    for (const b of BAND_ORDER) for (const field of ["label", "range", "message"] as const) {
      const text = BAND_INFO[b][field];
      expect(tBn(text), `${b}.${field}`).not.toBe(text);
    }
  });

  it("interpolate() ignores unbalanced braces instead of throwing", () => {
    expect(interpolate("a { b", undefined, "en")).toBe("a { b");
  });
});

describe("locale resolution", () => {
  it("prefers the cookie, then the saved preference, then Accept-Language, then English", () => {
    expect(resolveLocale({ cookie: "bn", preference: "en", acceptLanguage: "en" })).toBe("bn");
    expect(resolveLocale({ cookie: null, preference: "bn", acceptLanguage: "en" })).toBe("bn");
    expect(resolveLocale({ cookie: undefined, preference: undefined, acceptLanguage: "bn-BD,bn;q=0.9,en;q=0.8" })).toBe("bn");
    expect(resolveLocale({ acceptLanguage: "fr-FR,fr;q=0.9" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });

  it("ignores unsupported cookie or preference values", () => {
    expect(resolveLocale({ cookie: "xx", preference: "bn" })).toBe("bn");
    expect(resolveLocale({ cookie: "<script>", preference: "zz", acceptLanguage: "bn" })).toBe("bn");
  });

  it("respects q-values in Accept-Language", () => {
    expect(localeFromAcceptLanguage("en;q=0.4, bn;q=0.9")).toBe("bn");
    expect(localeFromAcceptLanguage("bn;q=0, en")).toBe("en");
    expect(localeFromAcceptLanguage("de, fr")).toBeNull();
    expect(localeFromAcceptLanguage("")).toBeNull();
  });
});

describe("locale-aware formatting", () => {
  const bn = makeFormatters("bn");
  const en = makeFormatters("en");

  it("uses Bengali digits in bn and Latin digits in en", () => {
    expect(bn.number(1234.5)).toBe("১,২৩৪.৫");
    expect(en.number(1234.5)).toBe("1,234.5");
  });

  it("formats percentages from basis points with two decimals", () => {
    expect(en.percentBp(8750)).toBe("87.50%");
    expect(bn.percentBp(8750)).toBe("৮৭.৫০%");
    expect(en.percentBp(0)).toBe("0.00%");
    expect(bn.percentBp(10000)).toBe("১০০.০০%");
  });

  it("formats marks and centi-marks", () => {
    expect(en.centi(875)).toBe("8.75");
    expect(bn.centi(875)).toBe("৮.৭৫");
    expect(bn.marks(9)).toBe("৯");
  });

  it("formats dates in the requested time zone and returns a dash for bad input", () => {
    const iso = "2026-10-23T20:20:00Z"; // 02:20 on 24 Oct in Asia/Dhaka (UTC+6)
    expect(makeFormatters("en", "Asia/Dhaka").dateTime(iso)).toMatch(/Oct 24, 2026/);
    expect(makeFormatters("en", "UTC").dateTime(iso)).toMatch(/Oct 23, 2026/);
    const out = makeFormatters("bn", "Asia/Dhaka").dateTime(iso);
    expect(out).toMatch(/[০-৯]/);
    expect(out).toContain("২০২৬");
    expect(en.dateTime("not a date")).toBe("—");
    expect(en.date(null)).toBe("—");
  });

  it("ignores an invalid time zone instead of throwing", () => {
    expect(() => makeFormatters("en", "Mars/Olympus").dateTime("2026-10-23T20:20:00Z")).not.toThrow();
  });

  it("formats relative times in the locale", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(en.relative("2026-10-20T12:00:00Z", now)).toBe("3 days ago");
    expect(bn.relative("2026-10-20T12:00:00Z", now)).toMatch(/৩/);
  });
});
