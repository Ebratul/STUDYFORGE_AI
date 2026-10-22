import { describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "../../src/config/env.js";
import {
  contentHash, cqSettingsSchema, isNearDuplicate, mcqSettingsSchema, normalizeInput, questionInputSchema, resolvePartMarks, stimulusFor, versionedHash,
} from "../../src/modules/questions/schemas.js";

resetEnvCache();
void getEnv();

const mcq = (over: Record<string, unknown> = {}) => ({
  kind: "MCQ", language: "en", stem: "What is the powerhouse of the cell?", difficulty: "EASY",
  options: [{ id: "a1", text: "Nucleus" }, { id: "b2", text: "Mitochondrion" }, { id: "c3", text: "Ribosome" }, { id: "d4", text: "Golgi body" }],
  correctOptionId: "b2", explanation: "Mitochondria make ATP.", tags: ["Biology", " cell "],
  ...over,
});
const issues = (input: unknown) => {
  const r = questionInputSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("questionInputSchema — MCQ integrity", () => {
  it("accepts a valid question and normalises text and tags", () => {
    const r = questionInputSchema.parse(mcq({ stem: "  What is   x?\u0000 " }));
    expect(r.stem).toBe("What is   x?");
    expect(r.tags).toEqual(["biology", "cell"]);
  });

  it("rejects a missing correct answer, an unknown reference and too few/many options", () => {
    expect(issues(mcq({ correctOptionId: null }))).toContain("correctOptionId: Choose the correct answer.");
    expect(issues(mcq({ correctOptionId: "zzzz" }))).toContain("correctOptionId: The correct answer must be one of the options.");
    expect(issues(mcq({ options: [{ text: "only one" }], correctOptionId: "#0" })).join()).toMatch(/options: A multiple-choice question needs 2–6 options/);
    const seven = Array.from({ length: 7 }, (_, i) => ({ text: `opt ${i}` }));
    expect(issues(mcq({ options: seven, correctOptionId: "#0" })).join()).toMatch(/options/);
  });

  it("rejects duplicated options even when they differ only by case, spacing or punctuation", () => {
    const opts = [{ id: "a1", text: "Mitochondrion" }, { id: "b2", text: "  mitochondrion. " }, { id: "c3", text: "Ribosome" }];
    expect(issues(mcq({ options: opts, correctOptionId: "a1" }))).toContain("options.1.text: Two options are the same.");
  });

  it("rejects duplicate ids, empty text and CQ-only fields on an MCQ", () => {
    expect(issues(mcq({ options: [{ id: "a1", text: "x" }, { id: "a1", text: "y" }], correctOptionId: "a1" }))).toContain("options.1.id: Ids must be unique within a question.");
    expect(issues(mcq({ stem: "   " }))).toContain("stem: Enter the question.");
    expect(issues(mcq({ stimulus: "text" }))).toContain("stimulus: A stimulus is only used for creative questions.");
    expect(issues(mcq({ parts: [{ prompt: "p", marks: 1 }] }))).toContain("parts: Multiple-choice questions have no sub-questions.");
  });

  it("enforces size limits, tag limits, marks and unknown keys", () => {
    expect(issues(mcq({ stem: "x".repeat(2001) }))[0]).toMatch(/stem: Use at most 2000/);
    expect(issues(mcq({ explanation: "x".repeat(2001) }))[0]).toMatch(/explanation/);
    expect(issues(mcq({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }))[0]).toMatch(/tags/);
    expect(issues(mcq({ tags: ["x".repeat(41)] }))[0]).toMatch(/Tags can be up to 40/);
    expect(issues(mcq({ marks: 1, negativeMarks: 2 }))).toContain("negativeMarks: Negative marks can't be more than the marks.");
    expect(issues(mcq({ sourceSupport: "SOURCE_QUOTED" }))[0]).toMatch(/sourceSupport|Unrecognized/);
    expect(issues(mcq({ sources: [] }))[0]).toMatch(/Unrecognized/); // provenance can't be supplied by the client
    expect(issues(mcq({ reviewReasons: [] }))[0]).toMatch(/Unrecognized/);
  });

  it("accepts '#index' for options that have no ids yet", () => {
    const r = questionInputSchema.parse(mcq({ options: [{ text: "A" }, { text: "B" }], correctOptionId: "#1" }));
    expect(normalizeInput(r).correctIndex).toBe(1);
    expect(issues(mcq({ options: [{ text: "A" }, { text: "B" }], correctOptionId: "#5" }))).toContain("correctOptionId: The correct answer must be one of the options.");
  });
});

describe("questionInputSchema — CQ", () => {
  const cq = (over: Record<string, unknown> = {}) => ({
    kind: "CQ", language: "bn", stem: "উদ্দীপকটি পড়ো", stimulus: "একটি গল্প", difficulty: "MEDIUM",
    parts: [{ label: "ক", level: "KNOWLEDGE", prompt: "জ্ঞান", marks: 1 }, { label: "খ", level: "COMPREHENSION", prompt: "অনুধাবন", marks: 2 }, { label: "গ", level: "APPLICATION", prompt: "প্রয়োগ", marks: 3 }, { label: "ঘ", level: "HIGHER_ORDER", prompt: "উচ্চতর", marks: 4 }],
    ...over,
  });

  it("accepts a stimulus-based CQ and sums the part marks", () => {
    const n = normalizeInput(questionInputSchema.parse(cq()));
    expect(n.marks).toBe(10);
    expect(n.parts).toHaveLength(4);
    expect(n.options).toEqual([]);
  });
  it("rejects total marks that disagree with the parts, options, explanation and negative marking", () => {
    expect(issues(cq({ marks: 9 }))[0]).toMatch(/marks: Total marks \(9\) must equal the sum/);
    expect(issues(cq({ options: [{ text: "a" }, { text: "b" }] }))).toContain("options: Creative questions have no options.");
    expect(issues(cq({ explanation: "x" }))).toContain("explanation: Creative questions use model answers, not an explanation.");
    expect(issues(cq({ negativeMarks: 1 }))).toContain("negativeMarks: Creative questions have no negative marking.");
  });
  it("allows a single descriptive question with its own answer but needs marks", () => {
    expect(issues(cq({ parts: [], stimulus: null, answerText: "A model answer" }))).toContain("marks: Enter the marks for this question.");
    expect(issues(cq({ parts: [], stimulus: null, marks: 5, answerText: "A model answer" }))).toEqual([]);
    expect(issues(cq({ answerText: "x" }))).toContain("answerText: Write the answers on the sub-questions.");
  });
  it("contains no timer or duration field anywhere (CQ is study content, not an exam)", () => {
    const r = questionInputSchema.safeParse(cq({ durationMinutes: 30 }));
    expect(r.success).toBe(false); // there is nowhere to put a time limit
    expect(cqSettingsSchema().safeParse({ mode: "QUESTIONS_ONLY", structure: "descriptive", grounding: "GENERAL", topic: "x", timeLimitMinutes: 20 }).success).toBe(false);
  });
});

describe("hashing and duplicate detection", () => {
  const n = (over: Record<string, unknown> = {}) => normalizeInput(questionInputSchema.parse(mcq(over)));

  it("exact duplicates share a content hash regardless of option order, case and punctuation", () => {
    const a = n();
    const b = n({ stem: "what is the POWERHOUSE of the cell", options: [{ text: "Golgi body" }, { text: "Ribosome" }, { text: "Mitochondrion!" }, { text: "Nucleus" }], correctOptionId: "#2" });
    expect(contentHash(a)).toBe(contentHash(b));
  });
  it("a different correct answer is a different question", () => {
    expect(contentHash(n())).not.toBe(contentHash(n({ correctOptionId: "a1" })));
  });
  it("detects near-duplicates (same stem wording and options) but not different questions on the same template", () => {
    const a = n({ stem: "Which organelle is known as the powerhouse of the cell and makes ATP?" });
    const b = n({ stem: "Which organelle is known as the powerhouse of the cell and makes ATP ?" });
    expect(isNearDuplicate(a, b)).toBe(true);
    const c = n({ stem: "Which organelle is known as the site of protein synthesis in the cell?", options: [{ id: "a1", text: "Ribosome" }, { id: "b2", text: "Vacuole" }, { id: "c3", text: "Lysosome" }], correctOptionId: "a1" });
    expect(isNearDuplicate(a, c)).toBe(false);
  });
  it("only metadata edits (tags, topic, subject, difficulty) leave the versioned hash unchanged", () => {
    const base = n();
    expect(versionedHash(base)).toBe(versionedHash(n({ tags: ["other"], topic: "Cells", subject: "Bio", difficulty: "HARD" })));
    expect(versionedHash(base)).not.toBe(versionedHash(n({ explanation: "Changed" })));
    expect(versionedHash(base)).not.toBe(versionedHash(n({ stem: "What is the powerhouse of a cell?" })));
  });
});

describe("CQ near-duplicates", () => {
  const cq = (stimulus: string, prompts: string[], stem = "Read the stimulus and answer the questions below.") =>
    normalizeInput(questionInputSchema.parse({ kind: "CQ", language: "en", stem, stimulus, difficulty: "MEDIUM", parts: prompts.map((p, i) => ({ prompt: p, marks: i + 1 })) }));
  it("ignores the shared lead-in: different stimuli are different questions", () => {
    const a = cq("Rivers carry silt from the highlands to the delta over thousands of years.", ["What is silt?", "Why do deltas form?"]);
    const b = cq("Mitochondria convert nutrients into ATP inside every animal cell.", ["What is ATP?", "Why do cells need energy?"]);
    expect(isNearDuplicate(a, b)).toBe(false);
  });
  it("flags the same stimulus with the same sub-questions", () => {
    const a = cq("Rivers carry silt from the highlands to the delta over thousands of years.", ["What is silt?", "Why do deltas form?"]);
    const b = cq("Rivers carry silt from the highlands to the delta over thousands of years!", ["What is silt?", "Why do deltas form?"]);
    expect(isNearDuplicate(a, b)).toBe(true);
  });
  it("the same stimulus with different sub-questions is a different question", () => {
    const a = cq("Rivers carry silt from the highlands to the delta over thousands of years.", ["What is silt?", "Why do deltas form?"]);
    const b = cq("Rivers carry silt from the highlands to the delta over thousands of years.", ["Name one river in Bangladesh.", "How do floods help farmers?"]);
    expect(isNearDuplicate(a, b)).toBe(false);
  });
});

describe("generation settings", () => {
  const base = { grounding: "SOURCE_ONLY", pastedText: "Some notes about cells.", topic: "Cells" };
  it("applies defaults", () => {
    const s = mcqSettingsSchema().parse(base);
    expect(s).toMatchObject({ count: 10, difficulty: "MIXED", language: "en", optionCount: 4, marks: 1, negativeMarks: 0, includeExplanations: true, includeShortNotes: true, crossCheck: true, documentIds: [] });
  });
  it("enforces maximum question counts and option bounds from the environment", () => {
    expect(mcqSettingsSchema().safeParse({ ...base, count: 51 }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ ...base, count: 0 }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ ...base, optionCount: 7 }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ ...base, optionCount: 1 }).success).toBe(false);
    expect(cqSettingsSchema().safeParse({ mode: "WITH_ANSWERS", structure: "descriptive", ...base, count: 21 }).success).toBe(false);
  });
  it("limits input sizes", () => {
    expect(mcqSettingsSchema().safeParse({ ...base, topic: "x".repeat(301) }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ ...base, pastedText: "x".repeat(30_001) }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ ...base, documentIds: Array.from({ length: 11 }, (_, i) => `d${i}`) }).success).toBe(false);
  });
  it("applies the grounding rules: sources are required unless GENERAL, and GENERAL never silently ignores sources", () => {
    expect(mcqSettingsSchema().safeParse({ grounding: "SOURCE_ONLY", topic: "Only a topic" }).success).toBe(false); // a topic is not a source
    expect(mcqSettingsSchema().safeParse({ grounding: "SOURCE_PREFERRED", topic: "t" }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ grounding: "GENERAL", topic: "Photosynthesis" }).success).toBe(true);
    expect(mcqSettingsSchema().safeParse({ grounding: "GENERAL" }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ grounding: "GENERAL", topic: "t", pastedText: "text" }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ grounding: "SOURCE_ONLY", documentIds: ["d1"] }).success).toBe(true);
  });
  it("validates marks and rejects unknown keys", () => {
    expect(mcqSettingsSchema().safeParse({ ...base, marks: 1, negativeMarks: 2 }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ ...base, marks: 0 }).success).toBe(false);
    expect(mcqSettingsSchema().safeParse({ ...base, apiKey: "sk-123" }).success).toBe(false);
  });
});

describe("CQ settings", () => {
  const base = { mode: "WITH_ANSWERS" as const, grounding: "GENERAL" as const, topic: "Rivers" };
  it("stimulus_4part defaults to 1/2/3/4 marks and always has a stimulus", () => {
    const s = cqSettingsSchema().parse({ ...base, structure: "stimulus_4part" });
    expect(resolvePartMarks(s)).toEqual([1, 2, 3, 4]);
    expect(stimulusFor(s)).toBe("required");
    expect(cqSettingsSchema().safeParse({ ...base, structure: "stimulus_4part", stimulus: "none" }).success).toBe(false);
    expect(cqSettingsSchema().safeParse({ ...base, structure: "stimulus_4part", partCount: 3 }).success).toBe(false);
  });
  it("scales default part marks to another total, keeping the sum exact", () => {
    const s = cqSettingsSchema().parse({ ...base, structure: "stimulus_4part", totalMarks: 20 });
    expect(resolvePartMarks(s)).toEqual([2, 4, 6, 8]);
    const odd = cqSettingsSchema().parse({ ...base, structure: "stimulus_4part", totalMarks: 7 });
    expect(resolvePartMarks(odd)!.reduce((a, b) => a + b, 0)).toBeCloseTo(7, 5);
  });
  it("multipart needs a part count or explicit marks that add up", () => {
    expect(cqSettingsSchema().safeParse({ ...base, structure: "multipart" }).success).toBe(false);
    const ok = cqSettingsSchema().parse({ ...base, structure: "multipart", partCount: 3, totalMarks: 9 });
    expect(resolvePartMarks(ok)).toEqual([3, 3, 3]);
    expect(cqSettingsSchema().safeParse({ ...base, structure: "multipart", partCount: 2, partMarks: [4, 4], totalMarks: 10 }).success).toBe(false);
    expect(cqSettingsSchema().safeParse({ ...base, structure: "multipart", partCount: 2, partMarks: [4, 6], totalMarks: 10 }).success).toBe(true);
  });
  it("descriptive questions have no parts and default to no stimulus", () => {
    const s = cqSettingsSchema().parse({ ...base, structure: "descriptive" });
    expect(resolvePartMarks(s)).toBeUndefined();
    expect(stimulusFor(s)).toBe("none");
    expect(cqSettingsSchema().safeParse({ ...base, structure: "descriptive", partCount: 3 }).success).toBe(false);
  });
});
