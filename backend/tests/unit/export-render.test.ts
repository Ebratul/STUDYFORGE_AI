import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors.js";
import { exportJsonSchema, MAX_EXPORT_QUESTIONS, renderExport } from "../../src/modules/questions/export/index.js";
import type { ExportInclude } from "../../src/modules/questions/types.js";
import { bnMcq, cq, FULL, mcq, NONE, PRIVATE_MARKERS, withPrivate } from "./export-helpers.js";

const NOW = new Date("2026-10-22T10:00:00Z");
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const json = async (items: Parameters<typeof renderExport>[0], include: ExportInclude, title?: string) => {
  const r = await renderExport(items, { format: "json", include, title, now: NOW });
  expect(r.contentType).toContain("application/json");
  return JSON.parse(dec(r.body));
};

describe("JSON export", () => {
  it("has the documented envelope, passes its own schema, and uses export-local ids", async () => {
    const out = await json([mcq(), cq()], FULL, "  My   set ");
    expect(exportJsonSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({ format: "studyforge.questions", version: 1, title: "My set", exportedAt: NOW.toISOString() });
    expect(out.questions.map((q: any) => q.id)).toEqual(["q1", "q2"]);
    const q = out.questions[0];
    expect(q.options.map((o: any) => o.id)).toEqual(["a", "b", "c", "d"]);
    expect(q.correctOptionId).toBe("b"); // remapped from the internal option id
    expect(out.questions[1].parts.map((p: any) => p.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.questions[1].correctOptionId).toBeNull();
    expect(q.sourceSupport).toBe("SOURCE_QUOTED");
  });

  it("strips document ids and review reasons and never leaks extra properties (all formats)", async () => {
    const items = [withPrivate(mcq()), withPrivate(cq()), withPrivate(bnMcq())];
    for (const format of ["json", "txt", "pdf"] as const) {
      const r = await renderExport(items, { format, include: FULL, now: NOW });
      // PDF text is compressed/encoded, so scan the raw bytes and (for json/txt) the decoded text.
      const text = format === "pdf" ? Buffer.from(r.body).toString("latin1") : dec(r.body);
      for (const marker of PRIVATE_MARKERS) expect(text, `${format} leaked ${marker}`).not.toContain(marker);
    }
    const out = await json(items, FULL);
    const keys = new Set(out.questions.flatMap((q: any) => Object.keys(q)));
    for (const k of ["ownerId", "provider", "model", "apiKey", "provenance", "createdAt", "email", "reviewReasons", "generationRunId"]) expect(keys.has(k)).toBe(false);
    expect(Object.keys(out.questions[0].sources[0]).sort()).toEqual(["documentName", "page", "quote", "quoteVerified", "section"]);
  });

  it("honours the include flags", async () => {
    const withOnly = await json([mcq(), cq()], NONE);
    const [m, c] = withOnly.questions;
    expect(m).not.toHaveProperty("correctOptionId");
    expect(m).not.toHaveProperty("explanation");
    expect(m).not.toHaveProperty("shortNote");
    expect(m).not.toHaveProperty("sources");
    expect(m).not.toHaveProperty("answer");
    expect(c.parts.every((p: any) => !("answer" in p))).toBe(true);
    expect(JSON.stringify(withOnly)).not.toContain("Chloroplasts contain");
    expect(JSON.stringify(withOnly)).not.toContain("Light reactions");

    const answersOnly = await json([mcq()], { ...NONE, answers: true });
    expect(answersOnly.questions[0].correctOptionId).toBe("b");
    expect(answersOnly.questions[0]).not.toHaveProperty("explanation");

    const expl = await json([mcq()], { ...NONE, explanations: true });
    expect(expl.questions[0].explanation).toBe("Chloroplasts contain chlorophyll.");
    expect(expl.questions[0]).not.toHaveProperty("shortNote");

    const notes = await json([mcq()], { ...NONE, notes: true });
    expect(notes.questions[0].shortNote).toBe("Light reactions occur in thylakoids.");

    const src = await json([cq()], { ...NONE, sources: true });
    expect(src.questions[0].sources).toHaveLength(1);
  });

  it("answers=false keeps CQ answers out even when sources are included", async () => {
    const out = await json([cq()], { ...NONE, sources: true });
    expect(JSON.stringify(out)).not.toContain("খাদ্য তৈরির প্রক্রিয়া");
  });

  it("rejects an empty selection, more than the cap, and an unusable answer key", async () => {
    await expect(renderExport([], { format: "json", include: FULL })).rejects.toBeInstanceOf(AppError);
    const many = Array.from({ length: MAX_EXPORT_QUESTIONS + 1 }, (_, i) => mcq({ stem: `Q ${i}` }));
    await expect(renderExport(many, { format: "json", include: NONE })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(renderExport(many, { format: "pdf", include: NONE })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(renderExport([mcq({ correctOptionId: "nope" })], { format: "json", include: FULL })).rejects.toMatchObject({ code: "VALIDATION" });
    // ...but the same item is exportable without answers
    await expect(renderExport([mcq({ correctOptionId: "nope" })], { format: "json", include: NONE })).resolves.toBeTruthy();
  });

  it("accepts exactly the cap", async () => {
    const items = Array.from({ length: MAX_EXPORT_QUESTIONS }, (_, i) => mcq({ stem: `Question number ${i}`, explanation: null, shortNote: null, sources: [] }));
    const r = await renderExport(items, { format: "json", include: FULL });
    expect(JSON.parse(dec(r.body)).questions).toHaveLength(MAX_EXPORT_QUESTIONS);
  });

  it("bounds total size", async () => {
    const huge = "x".repeat(400_000);
    const items = Array.from({ length: 6 }, (_, i) => mcq({ stem: `${i} ${huge}` }));
    await expect(renderExport(items, { format: "json", include: NONE })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("normalises text: NFC, control characters removed, title trimmed and capped", async () => {
    const out = await json([mcq({ stem: "Café \u0000question\u0007?" })], NONE, `${"t".repeat(300)}`);
    expect(out.questions[0].stem).toBe("Café question?");
    expect(out.title).toHaveLength(120);
    expect((await json([mcq()], NONE, "   ")).title).toBe("StudyForge questions");
  });

  it("schema is strict", () => {
    const ok = { format: "studyforge.questions", version: 1, title: "t", exportedAt: "x", questions: [] };
    expect(exportJsonSchema.safeParse(ok).success).toBe(true);
    expect(exportJsonSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(exportJsonSchema.safeParse({ ...ok, version: 2 }).success).toBe(false);
  });
});

describe("TXT export", () => {
  const txt = async (items: Parameters<typeof renderExport>[0], include: ExportInclude, title?: string) => {
    const r = await renderExport(items, { format: "txt", include, title, now: NOW });
    expect(r.contentType).toBe("text/plain; charset=utf-8");
    expect(r.extension).toBe("txt");
    return dec(r.body);
  };

  it("lays out an English MCQ with A) labels, answer, explanation, note, sources and an answer key", async () => {
    const t = await txt([mcq()], FULL, "Bio set");
    expect(t.startsWith("Bio set\n")).toBe(true);
    expect(t).not.toContain("\r");
    expect(t.charCodeAt(0)).not.toBe(0xfeff);
    expect(t).toContain("1. [MCQ · Medium · 1 mark]");
    expect(t).toContain("   A) Mitochondrion");
    expect(t).toContain("   B) Chloroplast");
    expect(t).toContain("Answer: B) Chloroplast");
    expect(t).toContain("Explanation: Chloroplasts contain chlorophyll.");
    expect(t).toContain("Note: Light reactions occur in thylakoids.");
    expect(t).toContain("Biology.pdf (p. 12): “Chloroplasts contain chlorophyll.”");
    expect(t).toMatch(/Answer key\n-+\n1\. B/);
    expect(t.endsWith("\n")).toBe(true);
  });

  it("uses Bangla option labels and headings for bn questions", async () => {
    const t = await txt([bnMcq()], FULL);
    expect(t).toContain("   ক) অক্সিজেন");
    expect(t).toContain("   ঘ) হাইড্রোজেন");
    expect(t).toContain("উত্তর: ক) অক্সিজেন");
    expect(t).toContain("ব্যাখ্যা:");
    expect(t).toMatch(/1\. ক/);
  });

  it("renders a CQ with stimulus, labelled parts, levels, marks and answer bases", async () => {
    const t = await txt([cq()], FULL);
    expect(t).toContain("উদ্দীপক:");
    expect(t).toContain("   ক) সালোকসংশ্লেষণ কী? (জ্ঞানমূলক) [1 নম্বর]");
    expect(t).toContain("   ঘ) বিশ্লেষণ করো। (উচ্চতর দক্ষতামূলক) [4 নম্বর]");
    expect(t).toContain("[আপনার উৎস দ্বারা সমর্থিত]");
    expect(t).toContain("[নির্বাচিত উৎসে পর্যাপ্ত তথ্য নেই]");
    expect(t).toContain("[সাধারণ যুক্তি (আপনার উৎস থেকে নয়)]");
    expect(t).not.toContain("Answer key"); // no MCQs, so no key
  });

  it("omits answers, explanations, notes, sources and the key when not included", async () => {
    const t = await txt([mcq(), cq()], NONE);
    for (const s of ["Answer:", "Explanation", "Note:", "Sources", "Answer key", "Chloroplasts contain", "খাদ্য তৈরির প্রক্রিয়া", "নমুনা উত্তর"]) expect(t).not.toContain(s);
    expect(t).toContain("B) Chloroplast");
  });

  it("wraps long lines and keeps very long words intact", async () => {
    const t = await txt([mcq({ stem: `${"word ".repeat(60)}${"y".repeat(200)}` })], NONE);
    const lines = t.split("\n");
    expect(Math.max(...lines.filter((l) => !l.includes("yyyy")).map((l) => l.length))).toBeLessThanOrEqual(92);
    expect(t).toContain("y".repeat(200));
  });

  it("shows context metadata", async () => {
    const t = await txt([mcq({ negativeMarks: 0.25 })], NONE);
    expect(t).toContain("negative marking 0.25");
    expect(t).toContain("Subject: Biology · Topic: Photosynthesis · Tags: plants");
  });
});
