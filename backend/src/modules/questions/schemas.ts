import { z } from "zod";
import { getEnv } from "../../config/env.js";
import { FIELD } from "./limits.js";
import { cleanText, jaccard, normKey, normalizeTags, sha256, tokens } from "./text.js";

export const KINDS = ["MCQ", "CQ"] as const;
export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export const DIFFICULTY_SETTINGS = ["EASY", "MEDIUM", "HARD", "MIXED"] as const;
export const LANGUAGES = ["en", "bn"] as const;
export const GROUNDINGS = ["SOURCE_ONLY", "SOURCE_PREFERRED", "GENERAL"] as const;
export const CQ_LEVELS = ["KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER"] as const;
export const CQ_MODES = ["QUESTIONS_ONLY", "WITH_ANSWERS"] as const;
export const CQ_STRUCTURES = ["stimulus_4part", "descriptive", "multipart"] as const;
export const ANSWER_BASES = ["SOURCE_SUPPORTED", "GENERAL_REASONING", "INSUFFICIENT_EVIDENCE", "USER_PROVIDED"] as const;
export const SOURCE_SUPPORTS = ["SOURCE_QUOTED", "MODEL_ONLY", "NONE"] as const;

export const REVIEW_REASONS = [
  "SOLVER_DISAGREES",
  "EXPLANATION_NAMES_OTHER_OPTION",
  "KEY_NOT_IN_EVIDENCE",
  "NEAR_DUPLICATE",
  "LANGUAGE_MISMATCH",
  "PART_INSUFFICIENT_EVIDENCE",
  "MARKS_ADJUSTED",
  "NEAR_DUPLICATE_IN_BANK",
] as const;

export const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------------
// Field helpers: every string is NFC-normalised, control characters are removed, whitespace trimmed.
// ---------------------------------------------------------------------------------------------------------------------
const reqStr = (max: number, what: string) =>
  z
    .string({ error: `Enter ${what}.` })
    .transform(cleanText)
    .pipe(z.string().min(1, `Enter ${what}.`).max(max, `Use at most ${max} characters.`));

const optStr = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null ? null : cleanText(v) || null))
    .pipe(z.string().max(max, `Use at most ${max} characters.`).nullable());

const marksNum = z.number({ error: "Enter a number." }).finite().min(0, "Marks can't be negative.").max(FIELD.marksMax, `Use at most ${FIELD.marksMax}.`).transform(round2);
const idStr = z.string().regex(/^[A-Za-z0-9_-]{2,40}$/, "Invalid id.");
const tagsField = z
  .array(z.string().max(80))
  .max(FIELD.tagsMax * 2, `Use at most ${FIELD.tagsMax} tags.`)
  .optional()
  .transform((t) => normalizeTags(t ?? []))
  .pipe(z.array(z.string().max(FIELD.tag, `Tags can be up to ${FIELD.tag} characters.`)).max(FIELD.tagsMax, `Use at most ${FIELD.tagsMax} tags.`));

// ---------------------------------------------------------------------------------------------------------------------
// QuestionInput (save / edit). Sources, source support, review flags and answer basis are NOT accepted: the server derives them.
// ---------------------------------------------------------------------------------------------------------------------
export const questionInputSchema = z
  .strictObject({
    runQuestionId: z.string().max(64).optional(),
    kind: z.enum(KINDS),
    language: z.enum(LANGUAGES),
    stem: reqStr(FIELD.stem, "the question"),
    stimulus: optStr(FIELD.stimulus),
    options: z
      .array(z.strictObject({ id: idStr.optional(), text: reqStr(FIELD.option, "the option text") }))
      .max(FIELD.optionsMax, `Use at most ${FIELD.optionsMax} options.`)
      .optional(),
    correctOptionId: z.string().max(60).nullish(),
    parts: z
      .array(
        z.strictObject({
          id: idStr.optional(),
          label: optStr(16),
          level: z.enum(CQ_LEVELS).nullish(),
          prompt: reqStr(FIELD.partPrompt, "the sub-question"),
          marks: marksNum.refine((m) => m > 0, "Marks must be more than 0."),
          answerText: optStr(FIELD.answer),
        }),
      )
      .max(FIELD.partsMax, `Use at most ${FIELD.partsMax} sub-questions.`)
      .optional(),
    answerText: optStr(FIELD.answer),
    explanation: optStr(FIELD.explanation),
    shortNote: optStr(FIELD.shortNote),
    difficulty: z.enum(DIFFICULTIES),
    subject: optStr(FIELD.subject),
    topic: optStr(FIELD.topic),
    tags: tagsField,
    marks: marksNum.optional(),
    negativeMarks: marksNum.optional(),
  })
  .superRefine((q, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const dupIds = (items: { id?: string }[] | undefined, key: string) => {
      const seen = new Set<string>();
      items?.forEach((it, i) => {
        if (!it.id) return;
        if (seen.has(it.id)) add([key, i, "id"], "Ids must be unique within a question.");
        seen.add(it.id);
      });
    };
    dupIds(q.options, "options");
    dupIds(q.parts, "parts");
    if (q.kind === "MCQ") {
      const opts = q.options ?? [];
      if (opts.length < FIELD.optionsMin || opts.length > FIELD.optionsMax) add(["options"], `A multiple-choice question needs ${FIELD.optionsMin}–${FIELD.optionsMax} options.`);
      const seen = new Map<string, number>();
      opts.forEach((o, i) => {
        const k = normKey(o.text);
        const first = seen.get(k);
        if (first !== undefined) add(["options", i, "text"], "Two options are the same.");
        else seen.set(k, i);
      });
      if (!q.correctOptionId) add(["correctOptionId"], "Choose the correct answer.");
      else if (resolveCorrectIndex(opts, q.correctOptionId) === -1) add(["correctOptionId"], "The correct answer must be one of the options.");
      if (q.parts?.length) add(["parts"], "Multiple-choice questions have no sub-questions.");
      if (q.answerText) add(["answerText"], "Use the explanation for a multiple-choice question.");
      if (q.stimulus) add(["stimulus"], "A stimulus is only used for creative questions.");
      const marks = q.marks ?? 1;
      if (marks <= 0) add(["marks"], "Marks must be more than 0.");
      if ((q.negativeMarks ?? 0) > marks) add(["negativeMarks"], "Negative marks can't be more than the marks.");
    } else {
      if (q.options?.length || q.correctOptionId) add(["options"], "Creative questions have no options.");
      if (q.explanation) add(["explanation"], "Creative questions use model answers, not an explanation.");
      if (q.shortNote) add(["shortNote"], "Short notes are only used for multiple-choice questions.");
      if (q.negativeMarks) add(["negativeMarks"], "Creative questions have no negative marking.");
      const parts = q.parts ?? [];
      if (parts.length) {
        if (q.answerText) add(["answerText"], "Write the answers on the sub-questions.");
        const sum = round2(parts.reduce((a, p) => a + p.marks, 0));
        if (q.marks !== undefined && round2(q.marks) !== sum) add(["marks"], `Total marks (${q.marks}) must equal the sum of the sub-question marks (${sum}).`);
      } else if (!(q.marks && q.marks > 0)) add(["marks"], "Enter the marks for this question.");
    }
  });

export type QuestionInputParsed = z.infer<typeof questionInputSchema>;

/** "#<index>" refers to an option by position (for options that have no id yet). Returns -1 when unresolved. */
export function resolveCorrectIndex(options: { id?: string }[], correct: string | null | undefined): number {
  if (!correct) return -1;
  const byId = options.findIndex((o) => o.id === correct);
  if (byId !== -1) return byId;
  const m = /^#(\d{1,2})$/.exec(correct);
  if (m) {
    const i = Number(m[1]);
    if (i >= 0 && i < options.length) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Normalised, id-free content used for hashing, duplicate detection, persistence and snapshots.
// ---------------------------------------------------------------------------------------------------------------------
export type NormalizedQuestion = {
  runQuestionId: string | undefined;
  kind: "MCQ" | "CQ";
  language: "en" | "bn";
  stem: string;
  stimulus: string | null;
  options: { clientId: string | undefined; text: string }[];
  correctIndex: number | null;
  parts: { clientId: string | undefined; label: string | null; level: (typeof CQ_LEVELS)[number] | null; prompt: string; marks: number; answerText: string | null }[];
  answerText: string | null;
  explanation: string | null;
  shortNote: string | null;
  difficulty: (typeof DIFFICULTIES)[number];
  subject: string | null;
  topic: string | null;
  tags: string[];
  marks: number;
  negativeMarks: number;
};

export function normalizeInput(q: QuestionInputParsed): NormalizedQuestion {
  const parts = (q.parts ?? []).map((p) => ({ clientId: p.id, label: p.label ?? null, level: p.level ?? null, prompt: p.prompt, marks: p.marks, answerText: p.answerText ?? null }));
  const options = (q.options ?? []).map((o) => ({ clientId: o.id, text: o.text }));
  const idx = q.kind === "MCQ" ? resolveCorrectIndex(q.options ?? [], q.correctOptionId) : -1;
  return {
    runQuestionId: q.runQuestionId,
    kind: q.kind,
    language: q.language,
    stem: q.stem,
    stimulus: q.kind === "CQ" ? (q.stimulus ?? null) : null,
    options: q.kind === "MCQ" ? options : [],
    correctIndex: q.kind === "MCQ" ? idx : null,
    parts: q.kind === "CQ" ? parts : [],
    answerText: q.kind === "CQ" && parts.length === 0 ? (q.answerText ?? null) : null,
    explanation: q.kind === "MCQ" ? (q.explanation ?? null) : null,
    shortNote: q.kind === "MCQ" ? (q.shortNote ?? null) : null,
    difficulty: q.difficulty,
    subject: q.subject ?? null,
    topic: q.topic ?? null,
    tags: q.tags,
    marks: q.kind === "CQ" && parts.length ? round2(parts.reduce((a, p) => a + p.marks, 0)) : (q.marks ?? 1),
    negativeMarks: q.kind === "MCQ" ? (q.negativeMarks ?? 0) : 0,
  };
}

/** Identity of a question for exact-duplicate detection (stable under option order and punctuation/case). */
export function contentHash(n: NormalizedQuestion): string {
  const correct = n.correctIndex !== null && n.correctIndex >= 0 ? normKey(n.options[n.correctIndex]?.text ?? "") : "";
  return sha256(
    JSON.stringify([
      n.kind,
      normKey(n.stem),
      normKey(n.stimulus ?? ""),
      n.options.map((o) => normKey(o.text)).sort(),
      correct,
      n.parts.map((p) => normKey(p.prompt)),
    ]),
  );
}

/**
 * Hash of everything an examinee could see or be scored by. A change here creates a new version/revision; metadata-only edits
 * (tags, subject, topic, difficulty) do not, so published exams (Part 4) pin to a version that only moves when content moves.
 */
export function versionedHash(n: NormalizedQuestion): string {
  return sha256(
    JSON.stringify([
      n.kind,
      n.language,
      n.stem,
      n.stimulus,
      n.options.map((o) => o.text),
      n.correctIndex,
      n.parts.map((p) => [p.label, p.level, p.prompt, p.marks, p.answerText ?? ""]),
      n.answerText ?? "",
      n.explanation,
      n.shortNote,
      n.marks,
      n.negativeMarks,
    ]),
  );
}

export function isNearDuplicate(a: NormalizedQuestion, b: NormalizedQuestion, threshold = 0.8): boolean {
  if (a.kind !== b.kind) return false;
  if (contentHash(a) === contentHash(b)) return true;
  if (a.kind === "CQ") {
    // A creative question is identified by its stimulus and sub-questions; the lead-in ("Read the stimulus…") is boilerplate.
    const ps = (n: NormalizedQuestion) => new Set(n.parts.map((p) => normKey(p.prompt)));
    if (a.stimulus || b.stimulus) {
      if (jaccard(tokens(a.stimulus ?? ""), tokens(b.stimulus ?? "")) < threshold) return false;
      return a.parts.length === 0 && b.parts.length === 0 ? jaccard(tokens(a.stem), tokens(b.stem)) >= threshold : jaccard(ps(a), ps(b)) >= 0.5;
    }
    if (jaccard(tokens(a.stem), tokens(b.stem)) < threshold) return false;
    return a.parts.length === 0 && b.parts.length === 0 ? true : jaccard(ps(a), ps(b)) >= 0.5;
  }
  if (jaccard(tokens(a.stem), tokens(b.stem)) < threshold) return false;
  const sa = new Set(a.options.map((o) => normKey(o.text)));
  const sb = new Set(b.options.map((o) => normKey(o.text)));
  const ca = a.correctIndex !== null ? normKey(a.options[a.correctIndex]?.text ?? "") : "";
  const cb = b.correctIndex !== null ? normKey(b.options[b.correctIndex]?.text ?? "") : "";
  return jaccard(sa, sb) >= 0.5 || (ca !== "" && ca === cb);
}

// ---------------------------------------------------------------------------------------------------------------------
// Generation settings (limits come from the environment at parse time)
// ---------------------------------------------------------------------------------------------------------------------
const modelOverride = z.strictObject({ provider: z.string().min(1).max(20), modelId: z.string().trim().min(1).max(200) }).optional();

function sourceFields() {
  const env = getEnv();
  return {
    topic: z.string().nullish().transform((v) => (v == null ? undefined : cleanText(v) || undefined)).pipe(z.string().max(env.GEN_TOPIC_MAX_CHARS, `Use at most ${env.GEN_TOPIC_MAX_CHARS} characters.`).optional()),
    pastedText: z.string().nullish().transform((v) => (v == null ? undefined : cleanText(v) || undefined)).pipe(z.string().max(env.GEN_TEXT_MAX_CHARS, `Pasted text can be up to ${env.GEN_TEXT_MAX_CHARS} characters.`).optional()),
    documentIds: z.array(z.string().min(1).max(64)).max(env.GEN_MAX_DOCUMENTS, `Choose at most ${env.GEN_MAX_DOCUMENTS} documents.`).optional().transform((d) => [...new Set(d ?? [])]),
    subject: optStr(FIELD.subject).transform((v) => v ?? undefined),
  };
}

type SourceShape = { topic?: string | undefined; pastedText?: string | undefined; documentIds: string[]; grounding: (typeof GROUNDINGS)[number] };

function checkSources(s: SourceShape, add: (path: string, message: string) => void) {
  const hasSources = Boolean(s.pastedText) || s.documentIds.length > 0;
  if (s.grounding === "GENERAL") {
    if (hasSources) add("grounding", "Remove the pasted text and documents, or choose a source-grounded policy. General AI mode never uses attached sources.");
    if (!s.topic) add("topic", "Enter a topic for General AI mode.");
  } else if (!hasSources) {
    add("grounding", "Add pasted text or at least one document, or choose General AI.");
  }
}

export function mcqSettingsSchema() {
  const env = getEnv();
  return z
    .strictObject({
      ...sourceFields(),
      count: z.number().int().min(1, "Choose at least 1 question.").max(env.MCQ_MAX_QUESTIONS_PER_RUN, `You can generate up to ${env.MCQ_MAX_QUESTIONS_PER_RUN} questions at a time.`).default(10),
      difficulty: z.enum(DIFFICULTY_SETTINGS).default("MIXED"),
      language: z.enum(LANGUAGES).default("en"),
      optionCount: z.number().int().min(FIELD.optionsMin).max(FIELD.optionsMax).default(4),
      marks: marksNum.refine((m) => m >= 0.25, "Marks must be at least 0.25.").default(1),
      negativeMarks: marksNum.default(0),
      includeExplanations: z.boolean().default(true),
      includeShortNotes: z.boolean().default(true),
      grounding: z.enum(GROUNDINGS),
      crossCheck: z.boolean().default(true),
      model: modelOverride,
    })
    .superRefine((s, ctx) => {
      checkSources(s, (path, message) => ctx.addIssue({ code: "custom", path: [path], message }));
      if (s.negativeMarks > s.marks) ctx.addIssue({ code: "custom", path: ["negativeMarks"], message: "Negative marks can't be more than the marks." });
    });
}
export type McqSettings = z.infer<ReturnType<typeof mcqSettingsSchema>>;

export function cqSettingsSchema() {
  const env = getEnv();
  return z
    .strictObject({
      ...sourceFields(),
      mode: z.enum(CQ_MODES),
      structure: z.enum(CQ_STRUCTURES),
      partCount: z.number().int().min(2).max(FIELD.partsMax).optional(),
      partMarks: z.array(marksNum.refine((m) => m > 0, "Marks must be more than 0.")).min(1).max(FIELD.partsMax).optional(),
      totalMarks: marksNum.refine((m) => m > 0, "Marks must be more than 0.").default(10),
      stimulus: z.enum(["required", "optional", "none"]).optional(),
      count: z.number().int().min(1).max(env.CQ_MAX_QUESTIONS_PER_RUN, `You can generate up to ${env.CQ_MAX_QUESTIONS_PER_RUN} questions at a time.`).default(3),
      difficulty: z.enum(DIFFICULTY_SETTINGS).default("MEDIUM"),
      language: z.enum(LANGUAGES).default("en"),
      grounding: z.enum(GROUNDINGS),
      model: modelOverride,
    })
    .superRefine((s, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
      checkSources(s, issue);
      if (s.structure === "stimulus_4part") {
        if (s.partCount !== undefined && s.partCount !== 4) issue("partCount", "A stimulus-based question has exactly 4 sub-questions.");
        if (s.stimulus === "none" || s.stimulus === "optional") issue("stimulus", "A stimulus-based question always has a stimulus.");
      }
      if (s.structure === "descriptive") {
        if (s.partCount !== undefined) issue("partCount", "A descriptive question has no sub-questions.");
        if (s.partMarks) issue("partMarks", "A descriptive question has a single mark total.");
      }
      if (s.structure === "multipart" && s.partCount === undefined && !s.partMarks) issue("partCount", "Choose how many sub-questions each question has.");
      if (s.partMarks) {
        const n = s.structure === "stimulus_4part" ? 4 : (s.partCount ?? s.partMarks.length);
        if (s.partMarks.length !== n) issue("partMarks", `Enter marks for each of the ${n} sub-questions.`);
        else if (round2(s.partMarks.reduce((a, b) => a + b, 0)) !== round2(s.totalMarks)) issue("partMarks", "Sub-question marks must add up to the total marks.");
      }
    });
}
export type CqSettings = z.infer<ReturnType<typeof cqSettingsSchema>>;

/** Final per-part marks for a CQ run (undefined for descriptive questions). */
export function resolvePartMarks(s: CqSettings): number[] | undefined {
  if (s.structure === "descriptive") return undefined;
  if (s.partMarks) return s.partMarks;
  const weights = s.structure === "stimulus_4part" ? [1, 2, 3, 4] : Array.from({ length: s.partCount ?? 2 }, () => 1);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const marks = weights.map((w) => round2((w * s.totalMarks) / wsum));
  marks[marks.length - 1] = round2(s.totalMarks - marks.slice(0, -1).reduce((a, b) => a + b, 0));
  return marks;
}

export const stimulusFor = (s: CqSettings): "required" | "optional" | "none" => (s.structure === "stimulus_4part" ? "required" : (s.stimulus ?? (s.structure === "descriptive" ? "none" : "optional")));

// ---------------------------------------------------------------------------------------------------------------------
// Other request bodies
// ---------------------------------------------------------------------------------------------------------------------
const cuid = z.string().min(1).max(64);
export const collectionFields = {
  title: reqStr(FIELD.title, "a title"),
  description: optStr(FIELD.description),
  subject: optStr(FIELD.subject),
};

export const saveSchema = () => {
  const env = getEnv();
  return z.strictObject({
    runId: cuid.optional(),
    questions: z.array(questionInputSchema).min(1, "Add at least one question.").max(env.SAVE_BATCH_MAX, `Save at most ${env.SAVE_BATCH_MAX} questions at a time.`),
    collection: z
      .union([z.strictObject({ id: cuid }), z.strictObject({ create: z.strictObject(collectionFields) })])
      .optional(),
  });
};

export const patchQuestionSchema = z.strictObject({
  question: questionInputSchema.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  markReviewed: z.boolean().optional(),
});

export const bulkSchema = () =>
  z.strictObject({
    action: z.enum(["delete", "addToCollection", "removeFromCollection", "markReviewed", "addTags", "setDifficulty"]),
    ids: z.array(cuid).min(1).max(200),
    collectionId: cuid.optional(),
    tags: tagsField.optional(),
    difficulty: z.enum(DIFFICULTIES).optional(),
  });

export const regenerateSchema = z.strictObject({
  questionId: z.string().min(1).max(64),
  avoid: z.array(z.string().transform(cleanText).pipe(z.string().max(FIELD.avoidChars))).max(FIELD.avoidMax).optional(),
});

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(KINDS).optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  subject: z.string().trim().max(FIELD.subject).optional(),
  topic: z.string().trim().max(FIELD.topic).optional(),
  tag: z.string().trim().max(FIELD.tag).optional(),
  language: z.enum(LANGUAGES).optional(),
  collectionId: cuid.optional(),
  needsReview: z.enum(["true", "false"]).optional(),
  sort: z.enum(["created", "updated", "difficulty"]).default("created"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const exportSchema = z.strictObject({
  source: z.union([
    z.strictObject({ questionIds: z.array(cuid).min(1).max(500) }),
    z.strictObject({ collectionId: cuid }),
    z.strictObject({ runId: cuid }),
    z.strictObject({ drafts: z.array(questionInputSchema).min(1).max(500), runId: cuid.optional() }),
  ]),
  format: z.enum(["json", "txt", "pdf"]),
  include: z.strictObject({ answers: z.boolean(), explanations: z.boolean(), notes: z.boolean(), sources: z.boolean() }),
  title: z.string().transform(cleanText).pipe(z.string().max(FIELD.title)).optional(),
});
