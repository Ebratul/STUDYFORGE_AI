/**
 * Part 3 types and pure helpers (see backend/docs/PART3_SPEC.md).
 * Everything that validates here is for instant feedback only: the server re-validates every save, edit and export.
 */

export type QuestionKind = "MCQ" | "CQ";
export type Difficulty = "EASY" | "MEDIUM" | "HARD";
export type DifficultySetting = Difficulty | "MIXED";
export type Language = "en" | "bn";
export type Grounding = "SOURCE_ONLY" | "SOURCE_PREFERRED" | "GENERAL";
export type SourceSupport = "SOURCE_QUOTED" | "MODEL_ONLY" | "NONE";
export type Origin = "AI_GENERATED" | "USER_AUTHORED";
export type CqMode = "QUESTIONS_ONLY" | "WITH_ANSWERS";
export type CqStructure = "stimulus_4part" | "descriptive" | "multipart";
export type CqLevel = "KNOWLEDGE" | "COMPREHENSION" | "APPLICATION" | "HIGHER_ORDER";
export type AnswerBasis = "SOURCE_SUPPORTED" | "GENERAL_REASONING" | "INSUFFICIENT_EVIDENCE" | "USER_PROVIDED";
export type RunKind = "MCQ" | "CQ";
export type RunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "INTERRUPTED";

export type SourceRef = { documentName: string; documentId: string | null; page: number | null; section: string | null; quote: string; quoteVerified: boolean };
export type AnswerObj = { text: string; basis: AnswerBasis; sources: SourceRef[] };
export type QuestionPartContent = { id: string; label: string | null; level: CqLevel | null; prompt: string; marks: number; answer: AnswerObj | null };

export type QuestionContent = {
  kind: QuestionKind;
  language: Language;
  stem: string;
  stimulus: string | null;
  options: { id: string; text: string }[];
  correctOptionId: string | null;
  parts: QuestionPartContent[];
  answer: AnswerObj | null;
  explanation: string | null;
  shortNote: string | null;
  difficulty: Difficulty;
  subject: string | null;
  topic: string | null;
  tags: string[];
  marks: number;
  negativeMarks: number;
  sources: SourceRef[];
  sourceSupport: SourceSupport;
  reviewReasons: string[];
};

export type QuestionDraft = QuestionContent & { id: string };

export type QuestionView = QuestionContent & {
  id: string;
  schemaVersion: 1;
  version: number;
  origin: Origin;
  modifiedByUser: boolean;
  reviewedAt: string | null;
  needsReview: boolean;
  provenance: { provider: string; model: string; generationRunId: string | null; generatedAt: string } | null;
  collections?: { id: string; title: string }[];
  createdAt: string;
  updatedAt: string;
};

export type QuestionInput = {
  runQuestionId?: string;
  kind: QuestionKind;
  language: Language;
  stem: string;
  stimulus?: string | null;
  options?: { id?: string; text: string }[];
  correctOptionId?: string | null;
  parts?: { id?: string; label?: string | null; level?: CqLevel | null; prompt: string; marks: number; answerText?: string | null }[];
  answerText?: string | null;
  explanation?: string | null;
  shortNote?: string | null;
  difficulty: Difficulty;
  subject?: string | null;
  topic?: string | null;
  tags?: string[];
  marks?: number;
  negativeMarks?: number;
};

export type ModelRef = { provider: string; modelId: string };

export type McqSettings = {
  topic?: string;
  pastedText?: string;
  documentIds?: string[];
  subject?: string;
  count: number;
  difficulty: DifficultySetting;
  language: Language;
  optionCount: number;
  marks: number;
  negativeMarks: number;
  includeExplanations: boolean;
  includeShortNotes: boolean;
  grounding: Grounding;
  crossCheck: boolean;
  model?: ModelRef;
};

export type CqSettings = {
  topic?: string;
  pastedText?: string;
  documentIds?: string[];
  subject?: string;
  mode: CqMode;
  structure: CqStructure;
  partCount?: number;
  partMarks?: number[];
  totalMarks: number;
  stimulus: "required" | "optional" | "none";
  count: number;
  difficulty: DifficultySetting;
  language: Language;
  grounding: Grounding;
  model?: ModelRef;
};

export type RunWarning = { code: string; message: string };
export type RunView = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  settings: McqSettings | CqSettings;
  provider: string;
  model: string;
  questions: QuestionDraft[];
  rejectedCount: number;
  warnings: RunWarning[];
  usage: { promptTokens: number | null; completionTokens: number | null; llmCalls: number };
  sources: { topic: string | null; pastedTextChars: number; documents: { id: string; name: string }[] };
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
};
export type RunSummary = { id: string; kind: RunKind; status: RunStatus; provider: string; model: string; createdAt: string; questionCount: number; topic: string | null };

export type CollectionView = { id: string; title: string; description: string | null; subject: string | null; questionCount: number; createdAt: string; updatedAt: string };
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type Facet = { value: string; count: number };
export type Facets = { subjects: Facet[]; topics: Facet[]; tags: Facet[] };

// ---------------------------------------------------------------------------------------------------------------------
// Limits (server is the single source of truth; these are only the fallbacks used before/without the response)
// ---------------------------------------------------------------------------------------------------------------------

export type QuestionLimitsResponse = {
  limits: Record<string, number>;
  fields?: Record<string, number>;
  models: { MCQ: ModelRef | null; CQ: ModelRef | null; EMBEDDING: ModelRef | null };
};

export type Limits = {
  mcqMaxQuestions: number;
  cqMaxQuestions: number;
  topicMaxChars: number;
  textMaxChars: number;
  maxDocuments: number;
  saveBatchMax: number;
  collectionMaxQuestions: number;
  stem: number;
  option: number;
  explanation: number;
  shortNote: number;
  stimulus: number;
  partPrompt: number;
  answer: number;
  parts: number;
  topic: number;
  tags: number;
  tag: number;
  title: number;
  description: number;
  maxOptions: number;
  minOptions: number;
};

export const DEFAULT_LIMITS: Limits = {
  mcqMaxQuestions: 50, cqMaxQuestions: 20, topicMaxChars: 300, textMaxChars: 30_000, maxDocuments: 10, saveBatchMax: 100, collectionMaxQuestions: 500,
  stem: 2000, option: 500, explanation: 2000, shortNote: 600, stimulus: 3000, partPrompt: 1000, answer: 4000, parts: 6, topic: 120, tags: 10, tag: 40,
  title: 120, description: 500, maxOptions: 6, minOptions: 2,
};

/** Merges the server's limits over the spec defaults. Unknown or non-numeric entries are ignored. */
export function resolveLimits(res?: QuestionLimitsResponse | null): Limits {
  const l = res?.limits ?? {};
  const f = res?.fields ?? {};
  const pick = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  const d = DEFAULT_LIMITS;
  return {
    ...d,
    mcqMaxQuestions: pick(l.mcqMaxQuestionsPerRun, d.mcqMaxQuestions),
    cqMaxQuestions: pick(l.cqMaxQuestionsPerRun, d.cqMaxQuestions),
    topicMaxChars: pick(l.genTopicMaxChars, d.topicMaxChars),
    textMaxChars: pick(l.genTextMaxChars, d.textMaxChars),
    maxDocuments: pick(l.genMaxDocuments, d.maxDocuments),
    saveBatchMax: pick(l.saveBatchMax, d.saveBatchMax),
    collectionMaxQuestions: pick(l.collectionMaxQuestions, d.collectionMaxQuestions),
    stem: pick(f.stem, d.stem), option: pick(f.option ?? f.optionText, d.option), explanation: pick(f.explanation, d.explanation),
    shortNote: pick(f.shortNote, d.shortNote), stimulus: pick(f.stimulus, d.stimulus), partPrompt: pick(f.partPrompt, d.partPrompt),
    answer: pick(f.answer ?? f.answerText, d.answer), parts: pick(f.parts, d.parts), topic: pick(f.topic, d.topic), tags: pick(f.tags, d.tags),
    tag: pick(f.tag, d.tag), title: pick(f.title, d.title), description: pick(f.description, d.description),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels and display strings
// ---------------------------------------------------------------------------------------------------------------------

const BN_LABELS = ["ক", "খ", "গ", "ঘ", "ঙ", "চ"];
const EN_UPPER = ["A", "B", "C", "D", "E", "F"];
const EN_LOWER = ["a", "b", "c", "d", "e", "f"];

/** Option label by position: A–F in English, ক–চ in Bangla. */
export const optionLabel = (index: number, lang: Language) => (lang === "bn" ? BN_LABELS : EN_UPPER)[index] ?? String(index + 1);
/** CQ part label by position: a–f in English, ক–চ in Bangla. */
export const partLabel = (index: number, lang: Language) => (lang === "bn" ? BN_LABELS : EN_LOWER)[index] ?? String(index + 1);

export const LEVEL_LABEL: Record<Language, Record<CqLevel, string>> = {
  en: { KNOWLEDGE: "Knowledge", COMPREHENSION: "Comprehension", APPLICATION: "Application", HIGHER_ORDER: "Higher-order skills" },
  bn: { KNOWLEDGE: "জ্ঞানমূলক", COMPREHENSION: "অনুধাবনমূলক", APPLICATION: "প্রয়োগমূলক", HIGHER_ORDER: "উচ্চতর দক্ষতামূলক" },
};
export const LEVELS: CqLevel[] = ["KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER"];

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { EASY: "Easy", MEDIUM: "Medium", HARD: "Hard" };
export const DIFFICULTY_SETTING_LABEL: Record<DifficultySetting, string> = { ...DIFFICULTY_LABEL, MIXED: "Mixed" };
export const LANGUAGE_LABEL: Record<Language, string> = { en: "English", bn: "বাংলা (Bangla)" };

export const SUPPORT_LABEL: Record<SourceSupport, { label: string; hint: string }> = {
  SOURCE_QUOTED: { label: "Source-quoted", hint: "At least one quote was found word-for-word in your source. This does not guarantee the answer key is correct." },
  MODEL_ONLY: { label: "Model knowledge", hint: "Not checked against your sources — the AI wrote this from its own knowledge." },
  NONE: { label: "Written by you", hint: "You wrote this question yourself." },
};

export const BASIS_LABEL: Record<AnswerBasis, { label: string; hint: string }> = {
  SOURCE_SUPPORTED: { label: "Source-supported", hint: "Backed by a quote found in your source." },
  GENERAL_REASONING: { label: "General reasoning", hint: "Not found in your sources — written from general knowledge, which your grounding policy permits." },
  INSUFFICIENT_EVIDENCE: { label: "Insufficient evidence in your sources", hint: "Your sources don't contain enough to answer this part, so no answer was invented." },
  USER_PROVIDED: { label: "Written by you", hint: "You wrote or changed this answer." },
};

export const REVIEW_REASON_TEXT: Record<string, string> = {
  SOLVER_DISAGREES: "A second AI pass chose a different answer than the key.",
  EXPLANATION_NAMES_OTHER_OPTION: "The explanation seems to name a different option than the answer key.",
  KEY_NOT_IN_EVIDENCE: "The marked answer isn't clearly supported by the quoted evidence.",
  NEAR_DUPLICATE: "Very similar to another question in this set.",
  LANGUAGE_MISMATCH: "The text may not be in the language you asked for.",
  PART_INSUFFICIENT_EVIDENCE: "At least one part couldn't be answered from your sources.",
  MARKS_ADJUSTED: "Part marks were adjusted to add up to the total.",
  NEAR_DUPLICATE_IN_BANK: "Very similar to a question already in your bank.",
};
export const reviewReasonText = (code: string) => REVIEW_REASON_TEXT[code] ?? "Flagged for review.";

export const GROUNDING_LABEL: Record<Grounding, { label: string; text: string }> = {
  SOURCE_ONLY: { label: "Source only", text: "Every question must be backed by a quote from your text or documents. Questions that can't be backed are dropped." },
  SOURCE_PREFERRED: { label: "Source preferred", text: "Uses your text or documents first. Anything the AI adds from its own knowledge is marked “Model knowledge”." },
  GENERAL: { label: "General AI", text: "The AI writes from its own knowledge of the topic. Nothing is checked against a source." },
};

export const WARNING_TEXT: Record<string, string> = {
  FEWER_THAN_REQUESTED: "Fewer questions than requested passed validation.",
  SOME_REJECTED: "Some generated questions were rejected by validation.",
  LANGUAGE_MISMATCH: "Some questions may not be in the requested language.",
  NO_STRUCTURED_OUTPUT_NATIVE: "This model has no native structured output, so a slower JSON fallback was used.",
  CROSS_CHECK_SKIPPED: "The answer-key double-check was skipped.",
  CONTEXT_TRUNCATED: "Your sources were longer than the model can read at once, so only part of them was used.",
  MARKS_ADJUSTED: "Some part marks were adjusted to add up to the total.",
};

// ---------------------------------------------------------------------------------------------------------------------
// Text normalisation, ids
// ---------------------------------------------------------------------------------------------------------------------

/** NFKC, lower-case, punctuation removed, whitespace collapsed (mirrors the server's duplicate/option comparison). */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function newId(prefix = "o"): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Draft helpers
// ---------------------------------------------------------------------------------------------------------------------

export function blankMcq(language: Language, optionCount = 4): QuestionContent {
  const options = Array.from({ length: optionCount }, () => ({ id: newId("o"), text: "" }));
  return {
    kind: "MCQ", language, stem: "", stimulus: null, options, correctOptionId: options[0]?.id ?? null, parts: [], answer: null, explanation: null, shortNote: null,
    difficulty: "MEDIUM", subject: null, topic: null, tags: [], marks: 1, negativeMarks: 0, sources: [], sourceSupport: "NONE", reviewReasons: [],
  };
}

export function addOption<T extends QuestionContent>(q: T, max: number): T {
  if (q.options.length >= max) return q;
  return { ...q, options: [...q.options, { id: newId("o"), text: "" }] };
}

export function removeOption<T extends QuestionContent>(q: T, id: string, min: number): T {
  if (q.options.length <= min) return q;
  const options = q.options.filter((o) => o.id !== id);
  const correctOptionId = q.correctOptionId === id ? null : q.correctOptionId;
  return { ...q, options, correctOptionId };
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
}

export const sumMarks = (parts: { marks: number }[]) => Math.round(parts.reduce((s, p) => s + (Number.isFinite(p.marks) ? p.marks : 0), 0) * 100) / 100;

/** The editable fields only (sources, support and review flags are server-owned). Used to detect edits. */
export function editableSnapshot(q: QuestionContent): string {
  return JSON.stringify({
    kind: q.kind, language: q.language, stem: q.stem, stimulus: q.stimulus ?? null,
    options: q.options.map((o) => [o.id, o.text]), correct: q.correctOptionId,
    parts: q.parts.map((p) => [p.id, p.label, p.level, p.prompt, p.marks, p.answer?.text ?? null]),
    answer: q.answer?.text ?? null, explanation: q.explanation ?? null, shortNote: q.shortNote ?? null, difficulty: q.difficulty,
    subject: q.subject ?? null, topic: q.topic ?? null, tags: q.tags, marks: q.marks, negativeMarks: q.negativeMarks,
  });
}

export function toInput(q: QuestionContent, runQuestionId?: string): QuestionInput {
  const blank = (s: string | null | undefined) => (s && s.trim() ? s : null);
  const input: QuestionInput = {
    kind: q.kind, language: q.language, stem: q.stem, difficulty: q.difficulty,
    subject: blank(q.subject), topic: blank(q.topic), tags: q.tags, marks: q.marks, negativeMarks: q.negativeMarks,
  };
  if (runQuestionId) input.runQuestionId = runQuestionId;
  if (q.kind === "MCQ") {
    input.options = q.options.map((o) => ({ id: o.id, text: o.text }));
    input.correctOptionId = q.correctOptionId;
    input.explanation = blank(q.explanation);
    input.shortNote = blank(q.shortNote);
  } else {
    input.stimulus = blank(q.stimulus);
    input.parts = q.parts.map((p) => ({ id: p.id, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks, answerText: blank(p.answer?.text) }));
    if (q.parts.length === 0) input.answerText = blank(q.answer?.text);
  }
  return input;
}

/** A generated draft → what the save endpoint accepts. Carries the draft id so the server can match it to the run. */
export const draftToInput = (d: QuestionDraft): QuestionInput => toInput(d, d.id);
/** A saved question → what PATCH accepts. */
export const viewToInput = (v: QuestionView): QuestionInput => toInput(v);

// ---------------------------------------------------------------------------------------------------------------------
// Instant local validation (the server is authoritative)
// ---------------------------------------------------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;

export function validateContent(q: QuestionContent, lim: Limits = DEFAULT_LIMITS): FieldErrors {
  const e: FieldErrors = {};
  const stem = q.stem.trim();
  if (!stem) e.stem = "Enter the question.";
  else if (stem.length > lim.stem) e.stem = `Use at most ${lim.stem} characters.`;
  if (q.explanation && q.explanation.length > lim.explanation) e.explanation = `Use at most ${lim.explanation} characters.`;
  if (q.shortNote && q.shortNote.length > lim.shortNote) e.shortNote = `Use at most ${lim.shortNote} characters.`;
  if (q.topic && q.topic.length > lim.topic) e.topic = `Use at most ${lim.topic} characters.`;
  if (q.subject && q.subject.length > lim.topic) e.subject = `Use at most ${lim.topic} characters.`;
  if (q.tags.length > lim.tags) e.tags = `Use at most ${lim.tags} tags.`;
  else if (q.tags.some((t) => t.length > lim.tag)) e.tags = `Each tag can be up to ${lim.tag} characters.`;
  if (!Number.isFinite(q.marks) || q.marks < 0 || q.marks > 100) e.marks = "Marks must be between 0 and 100.";
  if (!Number.isFinite(q.negativeMarks) || q.negativeMarks < 0 || q.negativeMarks > q.marks) e.negativeMarks = "Negative marks can't be less than 0 or more than the marks.";

  if (q.kind === "MCQ") {
    if (q.options.length < lim.minOptions || q.options.length > lim.maxOptions) e.options = `Use between ${lim.minOptions} and ${lim.maxOptions} options.`;
    const seen = new Map<string, string>();
    for (const o of q.options) {
      const t = o.text.trim();
      if (!t) e[`option:${o.id}`] = "Enter the option text.";
      else if (t.length > lim.option) e[`option:${o.id}`] = `Use at most ${lim.option} characters.`;
      else {
        const n = normalizeText(t);
        if (seen.has(n)) e[`option:${o.id}`] = "Another option says the same thing.";
        else seen.set(n, o.id);
      }
    }
    if (!q.correctOptionId || !q.options.some((o) => o.id === q.correctOptionId)) e.correctOptionId = "Choose the correct option.";
  } else {
    if (q.stimulus && q.stimulus.length > lim.stimulus) e.stimulus = `Use at most ${lim.stimulus} characters.`;
    if (q.parts.length > lim.parts) e.parts = `Use at most ${lim.parts} parts.`;
    for (const p of q.parts) {
      if (!p.prompt.trim()) e[`part:${p.id}:prompt`] = "Enter the part's question.";
      else if (p.prompt.length > lim.partPrompt) e[`part:${p.id}:prompt`] = `Use at most ${lim.partPrompt} characters.`;
      if (!Number.isFinite(p.marks) || p.marks <= 0) e[`part:${p.id}:marks`] = "Marks must be more than 0.";
      if (p.answer && p.answer.text.length > lim.answer) e[`part:${p.id}:answer`] = `Use at most ${lim.answer} characters.`;
    }
    if (q.parts.length && !e.parts && Math.abs(sumMarks(q.parts) - q.marks) > 0.001) e.marks = `Marks (${q.marks}) must equal the sum of the parts (${sumMarks(q.parts)}).`;
    if (q.answer && q.answer.text.length > lim.answer) e.answer = `Use at most ${lim.answer} characters.`;
  }
  return e;
}

/** Instant form check for the generator. Returns field → message. */
export function validateMcqSettings(s: McqSettings, lim: Limits = DEFAULT_LIMITS): FieldErrors {
  const e = validateSourcesAndGrounding(s, lim);
  if (!Number.isInteger(s.count) || s.count < 1 || s.count > lim.mcqMaxQuestions) e.count = `Choose 1–${lim.mcqMaxQuestions} questions.`;
  if (!Number.isInteger(s.optionCount) || s.optionCount < 2 || s.optionCount > 6) e.optionCount = "Choose 2–6 options.";
  if (!Number.isFinite(s.marks) || s.marks < 0.25 || s.marks > 100) e.marks = "Marks must be between 0.25 and 100.";
  if (!Number.isFinite(s.negativeMarks) || s.negativeMarks < 0 || s.negativeMarks > s.marks) e.negativeMarks = "Between 0 and the marks per question.";
  return e;
}

export function validateCqSettings(s: CqSettings, lim: Limits = DEFAULT_LIMITS): FieldErrors {
  const e = validateSourcesAndGrounding(s, lim);
  if (!Number.isInteger(s.count) || s.count < 1 || s.count > lim.cqMaxQuestions) e.count = `Choose 1–${lim.cqMaxQuestions} questions.`;
  if (!Number.isFinite(s.totalMarks) || s.totalMarks <= 0 || s.totalMarks > 100) e.totalMarks = "Total marks must be between 1 and 100.";
  if (s.structure === "multipart") {
    if (!s.partCount || !Number.isInteger(s.partCount) || s.partCount < 2 || s.partCount > lim.parts) e.partCount = `Choose 2–${lim.parts} parts.`;
    else if (s.partMarks) {
      if (s.partMarks.length !== s.partCount) e.partMarks = "Give marks for every part.";
      else if (s.partMarks.some((m) => !Number.isFinite(m) || m <= 0)) e.partMarks = "Each part needs marks above 0.";
      else if (Math.abs(sumMarks(s.partMarks.map((marks) => ({ marks }))) - s.totalMarks) > 0.001) e.partMarks = `Part marks must add up to ${s.totalMarks}.`;
    }
  }
  if (s.structure === "stimulus_4part" && s.partMarks) {
    if (s.partMarks.length !== 4) e.partMarks = "A 4-part CQ needs marks for 4 parts.";
    else if (Math.abs(sumMarks(s.partMarks.map((marks) => ({ marks }))) - s.totalMarks) > 0.001) e.partMarks = `Part marks must add up to ${s.totalMarks}.`;
  }
  return e;
}

type SourceFields = { topic?: string; pastedText?: string; documentIds?: string[]; grounding: Grounding };
export const hasSources = (s: { pastedText?: string; documentIds?: string[] }) => Boolean(s.pastedText?.trim()) || (s.documentIds?.length ?? 0) > 0;

function validateSourcesAndGrounding(s: SourceFields, lim: Limits): FieldErrors {
  const e: FieldErrors = {};
  const sources = hasSources(s);
  if ((s.topic?.length ?? 0) > lim.topicMaxChars) e.topic = `Use at most ${lim.topicMaxChars} characters.`;
  if ((s.pastedText?.length ?? 0) > lim.textMaxChars) e.pastedText = `Use at most ${lim.textMaxChars.toLocaleString()} characters.`;
  if ((s.documentIds?.length ?? 0) > lim.maxDocuments) e.documentIds = `Choose at most ${lim.maxDocuments} documents.`;
  if (s.grounding === "GENERAL") {
    if (sources) e.grounding = "General AI can't be used with pasted text or documents. Choose a source-based policy or remove the sources.";
    else if (!s.topic?.trim()) e.topic = "Enter a topic.";
  } else if (!sources) {
    e.grounding = "Source-based policies need pasted text or at least one document.";
  }
  return e;
}

/** Sensible default: source-based when there are sources, otherwise general. */
export const defaultGrounding = (s: { pastedText?: string; documentIds?: string[] }): Grounding => (hasSources(s) ? "SOURCE_ONLY" : "GENERAL");
export function effectiveGrounding(choice: Grounding | null, s: { pastedText?: string; documentIds?: string[] }): Grounding {
  const sources = hasSources(s);
  if (choice && (choice === "GENERAL" ? !sources : sources)) return choice;
  return defaultGrounding(s);
}

export function defaultPartMarks(structure: CqStructure, partCount: number, totalMarks: number): number[] | undefined {
  if (structure === "stimulus_4part" && totalMarks === 10) return [1, 2, 3, 4];
  if (structure === "stimulus_4part" || structure === "multipart") {
    const n = structure === "stimulus_4part" ? 4 : partCount;
    if (!Number.isInteger(n) || n < 1) return undefined;
    const each = Math.floor((totalMarks / n) * 100) / 100;
    const marks = Array.from({ length: n }, () => each);
    marks[n - 1] = Math.round((totalMarks - each * (n - 1)) * 100) / 100;
    return marks;
  }
  return undefined;
}

/** The structure decides whether a stimulus is needed. 4-part CQs always have one; descriptive questions default to none. */
export const forcedStimulus = (structure: CqStructure): "required" | null => (structure === "stimulus_4part" ? "required" : null);

// ---------------------------------------------------------------------------------------------------------------------
// Server error mapping
// ---------------------------------------------------------------------------------------------------------------------

/** Splits `questions.3.options.1.text` style keys into a per-question map (key is the path after the index). */
export function mapQuestionFieldErrors(fields: Record<string, string>): { byIndex: Record<number, Record<string, string>>; general: Record<string, string> } {
  const byIndex: Record<number, Record<string, string>> = {};
  const general: Record<string, string> = {};
  for (const [path, message] of Object.entries(fields)) {
    const m = /^questions\.(\d+)\.?(.*)$/.exec(path);
    if (m) (byIndex[Number(m[1])] ??= {})[m[2] || "_"] = message;
    else general[path] = message;
  }
  return { byIndex, general };
}

const PATH_LABEL: Record<string, string> = {
  stem: "Question", stimulus: "Stimulus", options: "Options", correctOptionId: "Correct answer", explanation: "Explanation", shortNote: "Short note",
  difficulty: "Difficulty", subject: "Subject", topic: "Topic", tags: "Tags", marks: "Marks", negativeMarks: "Negative marks", parts: "Parts", answerText: "Answer", _: "Question",
};
export function describeFieldPath(path: string): string {
  const head = path.split(".")[0] ?? path;
  return PATH_LABEL[head] ?? head;
}

// ---------------------------------------------------------------------------------------------------------------------
// Plain-text serialisation (Copy)
// ---------------------------------------------------------------------------------------------------------------------

export type TextOptions = { answers: boolean; explanations: boolean; notes: boolean };

export function questionToText(q: QuestionContent, n: number, o: TextOptions): string {
  const lines: string[] = [];
  if (q.kind === "MCQ") {
    lines.push(`${n}. ${q.stem}${q.marks ? ` [${q.marks}]` : ""}`);
    q.options.forEach((opt, i) => lines.push(`   ${optionLabel(i, q.language)}) ${opt.text}`));
    if (o.answers) {
      const i = q.options.findIndex((x) => x.id === q.correctOptionId);
      lines.push(`   Answer: ${i >= 0 ? `${optionLabel(i, q.language)}) ${q.options[i]?.text ?? ""}` : "—"}`);
    }
    if (o.explanations && q.explanation) lines.push(`   Explanation: ${q.explanation}`);
    if (o.notes && q.shortNote) lines.push(`   Note: ${q.shortNote}`);
  } else {
    lines.push(`${n}. ${q.stem}${q.marks ? ` [${q.marks}]` : ""}`);
    if (q.stimulus) lines.push(`   ${q.stimulus.replace(/\n/g, "\n   ")}`);
    q.parts.forEach((p, i) => {
      lines.push(`   ${p.label ?? partLabel(i, q.language)}) ${p.prompt} [${p.marks}]${p.level ? ` (${LEVEL_LABEL[q.language][p.level]})` : ""}`);
      if (o.answers && p.answer) lines.push(`      Answer: ${p.answer.basis === "INSUFFICIENT_EVIDENCE" ? "Insufficient evidence in the sources." : p.answer.text}`);
    });
    if (o.answers && !q.parts.length && q.answer) lines.push(`   Answer: ${q.answer.basis === "INSUFFICIENT_EVIDENCE" ? "Insufficient evidence in the sources." : q.answer.text}`);
  }
  return lines.join("\n");
}

export function questionsToText(list: QuestionContent[], o: TextOptions): string {
  return list.map((q, i) => questionToText(q, i + 1, o)).join("\n\n");
}

/** Whether any text in the answer says nothing (used to render INSUFFICIENT_EVIDENCE without inventing content). */
export const isInsufficient = (a: AnswerObj | null | undefined) => a?.basis === "INSUFFICIENT_EVIDENCE";
