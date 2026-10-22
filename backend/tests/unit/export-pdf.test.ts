import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { segmentScripts } from "../../src/modules/questions/export/fonts.js";
import { renderExport } from "../../src/modules/questions/export/index.js";
import type { ExportInclude } from "../../src/modules/questions/types.js";
import { bnMcq, cq, FULL, mcq, NONE } from "./export-helpers.js";

const NOW = new Date("2026-10-22T10:00:00Z");
const pdf = (items: Parameters<typeof renderExport>[0], include: ExportInclude = FULL, title?: string) => renderExport(items, { format: "pdf", include, title, now: NOW });
const ascii = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const pages = (b: Uint8Array) => (ascii(b).match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;
function text(b: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-pdf-"));
  try {
    const f = join(dir, "x.pdf");
    writeFileSync(f, b);
    return spawnSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" }).stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("segmentScripts", () => {
  it("assigns Bengali (incl. danda) and Latin text to the right fonts", () => {
    expect(segmentScripts("সালোকসংশ্লেষণ")).toEqual([{ text: "সালোকসংশ্লেষণ", font: "bn" }]);
    expect(segmentScripts("a, b")).toEqual([{ text: "a, b", font: "la" }]);
    const mixed = segmentScripts("কী? (What) হ্যাঁ। ok");
    expect(mixed.map((r) => r.font)).toEqual(["bn", "la", "bn", "la"]);
    expect(mixed.map((r) => r.text).join("")).toBe("কী? (What) হ্যাঁ। ok");
  });
  it("keeps a Bengali phrase (with spaces) in one run so it is shaped together", () => {
    expect(segmentScripts("উদ্দীপক পড়ে উত্তর দাও")).toHaveLength(1);
  });
  it("substitutes characters no bundled font can draw instead of emitting empty boxes", () => {
    expect(segmentScripts("O₂ ≥ 3 → x ✓ 😀").map((r) => r.text).join("")).toBe("O2 >= 3 -> x + ?");
  });
  it("preserves leading and trailing whitespace and handles empty input", () => {
    expect(segmentScripts("  x ").map((r) => r.text).join("")).toBe("  x ");
    expect(segmentScripts("")).toEqual([]);
    expect(segmentScripts("  ").map((r) => r.text).join("")).toBe("  ");
  });
});

describe("PDF export", () => {
  it("produces a valid A4 PDF for English MCQs with an answer key page", async () => {
    const r = await pdf([mcq(), mcq({ stem: "Second question?" })], FULL, "Bio set");
    expect(r.contentType).toBe("application/pdf");
    expect(r.extension).toBe("pdf");
    expect(ascii(r.body).startsWith("%PDF-")).toBe(true);
    expect(ascii(r.body).trimEnd().endsWith("%%EOF")).toBe(true);
    expect(ascii(r.body)).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(pages(r.body)).toBe(2); // questions + answer key
    expect(r.body.byteLength).toBeGreaterThan(5_000);
  });

  it("has no answer key page when answers are not included", async () => {
    expect(pages((await pdf([mcq()], NONE)).body)).toBe(1);
  });

  it("renders Bangla MCQs and CQs without throwing and embeds the Bengali font", async () => {
    const r = await pdf([bnMcq(), cq()], FULL, "জীববিজ্ঞান — Quiz");
    expect(pages(r.body)).toBeGreaterThanOrEqual(2);
    expect(ascii(r.body)).toMatch(/NotoSansBengali/i);
  });

  it("paginates long content (page breaks inside a long question)", async () => {
    const long = Array.from({ length: 150 }, (_, i) => `Sentence number ${i} of a very long stem.`).join(" ");
    const r = await pdf([mcq({ stem: long }), mcq({ stem: long })], NONE);
    expect(pages(r.body)).toBeGreaterThanOrEqual(3);
  });

  it("handles many questions within the cap", async () => {
    const items = Array.from({ length: 120 }, (_, i) => (i % 2 ? bnMcq({ stem: `প্রশ্ন ${i}?` }) : mcq({ stem: `Question ${i}?` })));
    const r = await pdf(items, FULL);
    expect(pages(r.body)).toBeGreaterThan(10);
  });

  it("copes with hostile text: very long unbroken words, control characters, unsupported glyphs", async () => {
    const r = await pdf([mcq({ stem: `${"W".repeat(5000)} \u0000\u0007 😀 ∑ → ${"ক".repeat(3000)}` })], NONE);
    expect(ascii(r.body).startsWith("%PDF-")).toBe(true);
  }, 30_000); // font shaping of 8k characters is CPU-bound: keep the limit generous on busy machines

  it.runIf(hasPdftotext)("contains the expected text, in order, with footers", async () => {
    const t = text((await pdf([mcq(), cq()], FULL, "Bio set")).body);
    expect(t).toContain("Bio set");
    expect(t).toContain("Which organelle carries out photosynthesis?");
    expect(t).toContain("Chloroplast");
    expect(t).toContain("Answer key");
    expect(t).toMatch(/Page 1 of \d/);
    expect(t.indexOf("Mitochondrion")).toBeLessThan(t.indexOf("Chloroplast"));
  });
});
