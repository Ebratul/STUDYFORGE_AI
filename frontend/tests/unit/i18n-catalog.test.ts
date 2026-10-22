import { describe, expect, it } from "vitest";
import bnJson from "@/messages/bn.json";
import enJson from "@/messages/en.json";
import { AREAS, coverage, extractKeys, placeholders } from "../../scripts/i18n-extract.mjs";

const keys = extractKeys();
const bn = bnJson as Record<string, string>;
const en = enJson as Record<string, string>;

describe("message catalogs", () => {
  it("finds the translatable strings in the source", () => {
    expect(keys.size).toBeGreaterThan(900);
  });

  it("en.json lists every key used in the source (run `pnpm i18n:write` after adding strings)", () => {
    const missing = [...keys.keys()].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    expect(Object.keys(en).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("every area declared complete has a Bangla translation for every key", () => {
    for (const row of coverage(keys, bn)) {
      if (row.complete) expect(row.missing, `Missing Bangla keys in "${row.area}"`).toEqual([]);
    }
  });

  it("covers the product areas the brief requires", () => {
    const names = AREAS.map((a) => a.name.toLowerCase()).join(" | ");
    for (const must of ["shell", "auth", "dashboard", "exams", "results", "groups", "settings"]) expect(names).toContain(must);
    expect(AREAS.every((a) => a.complete)).toBe(true);
  });

  it("keeps {placeholders} and plural branches intact in every translation", () => {
    const broken = Object.entries(bn).filter(([k, v]) => JSON.stringify(placeholders(k)) !== JSON.stringify(placeholders(v))).map(([k]) => k);
    expect(broken).toEqual([]);
  });

  it("has no empty translations and no stale entries", () => {
    expect(Object.entries(bn).filter(([, v]) => typeof v !== "string" || v.trim() === "")).toEqual([]);
    expect(Object.keys(bn).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("the coverage check really fails when a key is missing", () => {
    const partial = { ...bn };
    delete partial["Save changes"];
    const failing = coverage(keys, partial).filter((r) => r.missing.includes("Save changes"));
    expect(failing.length).toBeGreaterThan(0);
  });
});
