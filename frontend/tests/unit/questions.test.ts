import { describe, expect, it } from "vitest";
import {
  addOption, blankMcq, defaultGrounding, defaultPartMarks, describeFieldPath, draftToInput, editableSnapshot, effectiveGrounding, forcedStimulus, hasSources,
  LEVEL_LABEL, mapQuestionFieldErrors, moveItem, newId, normalizeText, optionLabel, partLabel, questionsToText, removeOption, resolveLimits,
  reviewReasonText, validateContent, validateCqSettings, validateMcqSettings, viewToInput,
  type CqSettings, type McqSettings, type QuestionContent, type QuestionDraft, type QuestionView,
} from "@/lib/questions";

function mcq(over: Partial<QuestionContent> = {}): QuestionContent {
  return {
    ...blankMcq("en"),
    stem: "What organelle produces ATP?",
    options: [{ id: "a", text: "Mitochondria" }, { id: "b", text: "Ribosome" }, { id: "c", text: "Nucleus" }, { id: "d", text: "Golgi body" }],
    correctOptionId: "a",
    explanation: "Mitochondria make ATP.",
    shortNote: "Powerhouse of the cell.",
    ...over,
  };
}

function cq(over: Partial<QuestionContent> = {}): QuestionContent {
  return {
    ...mcq(), kind: "CQ", stem: "Read the stimulus and answer.", stimulus: "A farmer notices wilting plants.", options: [], correctOptionId: null, explanation: null, shortNote: null, marks: 3,
    parts: [
      { id: "p1", label: "a", level: "KNOWLEDGE", prompt: "Define transpiration.", marks: 1, answer: null },
      { id: "p2", label: "b", level: "COMPREHENSION", prompt: "Explain wilting.", marks: 2, answer: { text: "Water loss.", basis: "SOURCE_SUPPORTED", sources: [] } },
    ],
    ...over,
  };
}

describe("labels", () => {
  it("uses A–F in English and ক–চ in Bangla", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => optionLabel(i, "en"))).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect([0, 1, 2, 3, 4, 5].map((i) => optionLabel(i, "bn"))).toEqual(["ক", "খ", "গ", "ঘ", "ঙ", "চ"]);
    expect(partLabel(0, "en")).toBe("a");
    expect(partLabel(3, "bn")).toBe("ঘ");
  });
  it("names the four Bangla CQ levels", () => {
    expect(LEVEL_LABEL.bn).toEqual({ KNOWLEDGE: "জ্ঞানমূলক", COMPREHENSION: "অনুধাবনমূলক", APPLICATION: "প্রয়োগমূলক", HIGHER_ORDER: "উচ্চতর দক্ষতামূলক" });
    expect(LEVEL_LABEL.en.HIGHER_ORDER).toBe("Higher-order skills");
  });
  it("never invents a reason text for unknown codes", () => {
    expect(reviewReasonText("SOLVER_DISAGREES")).toMatch(/second AI pass/);
    expect(reviewReasonText("SOMETHING_NEW")).toBe("Flagged for review.");
  });
});

describe("option editing helpers", () => {
  it("adds options up to the maximum and gives them unique ids", () => {
    let q = mcq();
    q = addOption(q, 6);
    q = addOption(q, 6);
    q = addOption(q, 6);
    expect(q.options).toHaveLength(6);
    expect(new Set(q.options.map((o) => o.id)).size).toBe(6);
  });
  it("won't remove below the minimum, and clears the key when the correct option is removed", () => {
    expect(removeOption(mcq({ options: [{ id: "a", text: "x" }, { id: "b", text: "y" }] }), "a", 2).options).toHaveLength(2);
    const r = removeOption(mcq(), "a", 2);
    expect(r.options.map((o) => o.id)).toEqual(["b", "c", "d"]);
    expect(r.correctOptionId).toBeNull();
    expect(removeOption(mcq(), "b", 2).correctOptionId).toBe("a");
  });
  it("moveItem reorders without mutating and ignores out-of-range moves", () => {
    const src = ["a", "b", "c"];
    expect(moveItem(src, 0, 2)).toEqual(["b", "c", "a"]);
    expect(src).toEqual(["a", "b", "c"]);
    expect(moveItem(src, 0, -1)).toBe(src);
    expect(moveItem(src, 2, 3)).toBe(src);
  });
  it("newId matches the id pattern the server accepts", () => {
    expect(newId("o")).toMatch(/^[A-Za-z0-9_-]{2,40}$/);
  });
});

describe("validateContent (instant feedback only)", () => {
  it("accepts a good MCQ", () => {
    expect(validateContent(mcq())).toEqual({});
  });
  it("flags empty stem, empty and duplicated options, and a missing key", () => {
    const e = validateContent(mcq({ stem: "  ", options: [{ id: "a", text: "Same!" }, { id: "b", text: "same" }, { id: "c", text: "" }], correctOptionId: "zzz" }));
    expect(e.stem).toBeTruthy();
    expect(e["option:b"]).toMatch(/same thing/);
    expect(e["option:c"]).toMatch(/Enter/);
    expect(e.correctOptionId).toBeTruthy();
  });
  it("enforces option count bounds and negative marks <= marks", () => {
    expect(validateContent(mcq({ options: [{ id: "a", text: "x" }], correctOptionId: "a" })).options).toBeTruthy();
    expect(validateContent(mcq({ marks: 1, negativeMarks: 2 })).negativeMarks).toBeTruthy();
  });
  it("checks CQ part prompts, marks and that parts add up to the total", () => {
    expect(validateContent(cq())).toEqual({});
    const e = validateContent(cq({ marks: 10 }));
    expect(e.marks).toMatch(/sum of the parts/);
    const bad = cq();
    bad.parts[0]!.prompt = "";
    bad.parts[1]!.marks = 0;
    const e2 = validateContent(bad);
    expect(e2["part:p1:prompt"]).toBeTruthy();
    expect(e2["part:p2:marks"]).toBeTruthy();
  });
  it("allows a single descriptive CQ with no parts", () => {
    expect(validateContent(cq({ parts: [], stimulus: null, marks: 5 }))).toEqual({});
  });
});

describe("normalizeText", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(normalizeText("  Mitochondria!  ")).toBe(normalizeText("mitochondria"));
    expect(normalizeText("ক খ")).toBe("ক খ");
  });
});

describe("generator settings validation", () => {
  const base: McqSettings = { topic: "Cells", count: 10, difficulty: "MIXED", language: "en", optionCount: 4, marks: 1, negativeMarks: 0, includeExplanations: true, includeShortNotes: true, grounding: "GENERAL", crossCheck: true };
  it("accepts topic-only general generation", () => {
    expect(validateMcqSettings(base)).toEqual({});
  });
  it("rejects GENERAL with sources attached, and source policies without sources", () => {
    expect(validateMcqSettings({ ...base, pastedText: "some text" }).grounding).toMatch(/General AI/);
    expect(validateMcqSettings({ ...base, grounding: "SOURCE_ONLY" }).grounding).toMatch(/need pasted text/);
    expect(validateMcqSettings({ ...base, grounding: "SOURCE_ONLY", documentIds: ["d1"] })).toEqual({});
  });
  it("requires a topic for GENERAL and bounds count, marks and option count", () => {
    expect(validateMcqSettings({ ...base, topic: "" }).topic).toBeTruthy();
    expect(validateMcqSettings({ ...base, count: 51 }).count).toBeTruthy();
    expect(validateMcqSettings({ ...base, count: 51 }, resolveLimits({ limits: { mcqMaxQuestionsPerRun: 80 }, models: { MCQ: null, CQ: null, EMBEDDING: null } })).count).toBeUndefined();
    expect(validateMcqSettings({ ...base, optionCount: 7 }).optionCount).toBeTruthy();
    expect(validateMcqSettings({ ...base, marks: 1, negativeMarks: 2 }).negativeMarks).toBeTruthy();
  });
  it("validates CQ part marks against the total", () => {
    const s: CqSettings = { topic: "Cells", mode: "QUESTIONS_ONLY", structure: "multipart", partCount: 3, partMarks: [2, 3, 5], totalMarks: 10, stimulus: "optional", count: 2, difficulty: "MEDIUM", language: "en", grounding: "GENERAL" };
    expect(validateCqSettings(s)).toEqual({});
    expect(validateCqSettings({ ...s, partMarks: [2, 3, 4] }).partMarks).toMatch(/add up to 10/);
    expect(validateCqSettings({ ...s, partCount: 1 }).partCount).toBeTruthy();
    expect(validateCqSettings({ ...s, structure: "stimulus_4part", partMarks: [1, 2, 3, 4] })).toEqual({});
  });
  it("picks a grounding that is allowed for the current sources", () => {
    expect(defaultGrounding({})).toBe("GENERAL");
    expect(defaultGrounding({ pastedText: "x" })).toBe("SOURCE_ONLY");
    expect(effectiveGrounding("SOURCE_PREFERRED", { pastedText: "x" })).toBe("SOURCE_PREFERRED");
    expect(effectiveGrounding("GENERAL", { documentIds: ["d"] })).toBe("SOURCE_ONLY");
    expect(effectiveGrounding("SOURCE_ONLY", {})).toBe("GENERAL");
    expect(hasSources({ pastedText: "   " })).toBe(false);
  });
  it("derives CQ defaults per structure", () => {
    expect(defaultPartMarks("stimulus_4part", 4, 10)).toEqual([1, 2, 3, 4]);
    expect(defaultPartMarks("multipart", 3, 10)).toEqual([3.33, 3.33, 3.34]);
    expect(defaultPartMarks("descriptive", 0, 5)).toBeUndefined();
    expect(forcedStimulus("stimulus_4part")).toBe("required");
    expect(forcedStimulus("descriptive")).toBeNull();
  });
});

describe("limits", () => {
  it("uses server values when valid and falls back otherwise", () => {
    const l = resolveLimits({ limits: { mcqMaxQuestionsPerRun: 30, genTextMaxChars: -1 }, models: { MCQ: null, CQ: null, EMBEDDING: null } });
    expect(l.mcqMaxQuestions).toBe(30);
    expect(l.textMaxChars).toBe(30_000);
    expect(resolveLimits(null).cqMaxQuestions).toBe(20);
  });
});

describe("to-input conversion", () => {
  it("carries the draft id as runQuestionId and never sends server-owned provenance", () => {
    const draft: QuestionDraft = { ...mcq({ sources: [{ documentName: "d", documentId: "x", page: 1, section: null, quote: "q", quoteVerified: true }], sourceSupport: "SOURCE_QUOTED", reviewReasons: ["SOLVER_DISAGREES"] }), id: "g_1" };
    const input = draftToInput(draft);
    expect(input.runQuestionId).toBe("g_1");
    expect(input.options).toEqual(draft.options);
    expect(input.correctOptionId).toBe("a");
    for (const forbidden of ["sources", "sourceSupport", "reviewReasons", "provider", "model", "origin", "id"]) expect(input).not.toHaveProperty(forbidden);
  });
  it("converts CQ parts with answer text only", () => {
    const input = draftToInput({ ...cq(), id: "g_2" });
    expect(input.parts).toEqual([
      { id: "p1", label: "a", level: "KNOWLEDGE", prompt: "Define transpiration.", marks: 1, answerText: null },
      { id: "p2", label: "b", level: "COMPREHENSION", prompt: "Explain wilting.", marks: 2, answerText: "Water loss." },
    ]);
    expect(input.options).toBeUndefined();
  });
  it("viewToInput has no runQuestionId", () => {
    const view = { ...mcq(), id: "q1", schemaVersion: 1, version: 3, origin: "AI_GENERATED", modifiedByUser: false, reviewedAt: null, needsReview: false, provenance: null, createdAt: "", updatedAt: "" } as QuestionView;
    expect(viewToInput(view)).not.toHaveProperty("runQuestionId");
  });
});

describe("editableSnapshot", () => {
  it("changes only when editable content changes", () => {
    const a = mcq();
    expect(editableSnapshot(a)).toBe(editableSnapshot({ ...a, reviewReasons: ["NEAR_DUPLICATE"], sourceSupport: "MODEL_ONLY" }));
    expect(editableSnapshot(a)).not.toBe(editableSnapshot({ ...a, stem: "Different?" }));
    expect(editableSnapshot(a)).not.toBe(editableSnapshot({ ...a, correctOptionId: "b" }));
  });
});

describe("server field errors", () => {
  it("splits dotted paths per question", () => {
    const { byIndex, general } = mapQuestionFieldErrors({ "questions.3.options": "bad", "questions.3.correctOptionId": "no", "questions.0.stem": "empty", topic: "x", questions: "too many" });
    expect(byIndex[3]).toEqual({ options: "bad", correctOptionId: "no" });
    expect(byIndex[0]).toEqual({ stem: "empty" });
    expect(general).toEqual({ topic: "x", questions: "too many" });
    expect(describeFieldPath("options.1.text")).toBe("Options");
  });
});

describe("plain-text copy", () => {
  it("numbers questions, labels options per language and appends the key on request", () => {
    const text = questionsToText([mcq(), mcq({ language: "bn" })], { answers: true, explanations: true, notes: false });
    expect(text).toContain("1. What organelle produces ATP? [1]");
    expect(text).toContain("A) Mitochondria");
    expect(text).toContain("Answer: A) Mitochondria");
    expect(text).toContain("ক) Mitochondria");
    expect(text).toContain("Explanation: Mitochondria make ATP.");
    expect(text).not.toContain("Powerhouse");
    expect(questionsToText([mcq()], { answers: false, explanations: true, notes: true })).not.toContain("Answer:");
  });
  it("renders insufficient-evidence answers without inventing text, and has no timer wording", () => {
    const c = cq();
    c.parts[1]!.answer = { text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] };
    const text = questionsToText([c], { answers: true, explanations: false, notes: false });
    expect(text).toContain("Insufficient evidence in the sources.");
    expect(text).not.toMatch(/timer|duration|minutes|countdown/i);
  });
});
