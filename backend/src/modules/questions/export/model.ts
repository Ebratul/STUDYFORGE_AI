import { z } from "zod";
import { AppError } from "../../../lib/errors.js";
import type { AnswerBasis, CqLevel, Difficulty, ExportInclude, ExportItem, Language, QuestionKind, SourceSupport } from "../types.js";

/** Hard cap for one export (PART3_SPEC §4.6). */
export const MAX_EXPORT_QUESTIONS = 500;
/** Total characters across all exported fields; keeps memory/CPU bounded even if upstream limits regress. */
export const MAX_EXPORT_CHARS = 2_000_000;
export const MAX_TITLE_CHARS = 120;
export const DEFAULT_TITLE = "StudyForge questions";

const OPTION_IDS = ["a", "b", "c", "d", "e", "f"] as const;

const exportSource = z.strictObject({
  documentName: z.string(),
  page: z.number().int().nullable(),
  section: z.string().nullable(),
  quote: z.string(),
  quoteVerified: z.boolean(),
});
const exportAnswer = z.strictObject({
  text: z.string(),
  basis: z.enum(["SOURCE_SUPPORTED", "GENERAL_REASONING", "INSUFFICIENT_EVIDENCE", "USER_PROVIDED"]),
  sources: z.array(exportSource).optional(),
});

const exportQuestion = z
  .strictObject({
    id: z.string().regex(/^q\d{1,3}$/),
    kind: z.enum(["MCQ", "CQ"]),
    language: z.enum(["en", "bn"]),
    stem: z.string(),
    stimulus: z.string().nullable(),
    options: z.array(z.strictObject({ id: z.string().regex(/^[a-f]$/), text: z.string() })).max(6),
    correctOptionId: z.string().regex(/^[a-f]$/).nullable().optional(),
    parts: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-f]$/),
          label: z.string().nullable(),
          level: z.enum(["KNOWLEDGE", "COMPREHENSION", "APPLICATION", "HIGHER_ORDER"]).nullable(),
          prompt: z.string(),
          marks: z.number(),
          answer: exportAnswer.nullable().optional(),
        }),
      )
      .max(6),
    answer: exportAnswer.nullable().optional(),
    explanation: z.string().nullable().optional(),
    shortNote: z.string().nullable().optional(),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
    subject: z.string().nullable(),
    topic: z.string().nullable(),
    tags: z.array(z.string()),
    marks: z.number(),
    negativeMarks: z.number(),
    sources: z.array(exportSource).optional(),
    sourceSupport: z.enum(["SOURCE_QUOTED", "MODEL_ONLY", "NONE"]),
  })
  .superRefine((q, ctx) => {
    if (q.correctOptionId && !q.options.some((o) => o.id === q.correctOptionId)) {
      ctx.addIssue({ code: "custom", message: "correctOptionId must reference an option", path: ["correctOptionId"] });
    }
  });

/** Validates the JSON export before it is sent. Strict: any unexpected property is an error. */
export const exportJsonSchema = z.strictObject({
  format: z.literal("studyforge.questions"),
  version: z.literal(1),
  title: z.string(),
  exportedAt: z.string(),
  questions: z.array(exportQuestion).max(MAX_EXPORT_QUESTIONS),
});

export type ExportJson = z.infer<typeof exportJsonSchema>;
export type ExportQuestion = z.infer<typeof exportQuestion>;
export type ExportAnswer = z.infer<typeof exportAnswer>;
export type ExportSource = z.infer<typeof exportSource>;

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u2028\\u2029\\uFEFF]", "g");

/** NFC, no control characters (newline and tab survive). */
export function clean(s: string): string {
  return s.normalize("NFC").replace(/\r\n?/g, "\n").replace(CONTROL, "");
}
const cleanOrNull = (s: string | null | undefined) => (s == null ? null : clean(s));

export function cleanTitle(title: string | undefined): string {
  const t = clean(title ?? "").replace(/\s+/g, " ").trim();
  return (t || DEFAULT_TITLE).slice(0, MAX_TITLE_CHARS);
}

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

function bad(message: string): never {
  throw new AppError("VALIDATION", message);
}

/**
 * Builds export questions field by field. Nothing is spread from the input, so private or unexpected
 * properties on the items can never reach an export (all three formats render from this shape).
 */
export function toExportQuestions(items: readonly ExportItem[], include: ExportInclude): ExportQuestion[] {
  if (items.length === 0) bad("Choose at least one question to export.");
  if (items.length > MAX_EXPORT_QUESTIONS) bad(`You can export up to ${MAX_EXPORT_QUESTIONS} questions at a time.`);

  let chars = 0;
  const count = (s: string | null | undefined) => {
    chars += s?.length ?? 0;
    if (chars > MAX_EXPORT_CHARS) bad("That selection is too large to export. Choose fewer questions.");
  };

  const source = (s: ExportItem["sources"][number]): ExportSource => {
    const out = { documentName: clean(s.documentName), page: s.page ?? null, section: cleanOrNull(s.section), quote: clean(s.quote), quoteVerified: Boolean(s.quoteVerified) };
    count(out.documentName);
    count(out.quote);
    count(out.section);
    return out;
  };
  const answer = (a: NonNullable<ExportItem["answer"]>): ExportAnswer => {
    const out: ExportAnswer = { text: clean(a.text), basis: a.basis };
    count(out.text);
    if (include.sources) out.sources = a.sources.map(source);
    return out;
  };

  return items.map((it, qi) => {
    const optionIds = new Map<string, string>();
    const options = it.options.slice(0, OPTION_IDS.length).map((o, i) => {
      const id = OPTION_IDS[i]!;
      optionIds.set(o.id, id);
      count(o.text);
      return { id, text: clean(o.text) };
    });
    if (it.options.length > OPTION_IDS.length) bad("A question has more answer options than can be exported.");

    const q: ExportQuestion = {
      id: `q${qi + 1}`,
      kind: it.kind,
      language: it.language,
      stem: clean(it.stem),
      stimulus: cleanOrNull(it.stimulus),
      options,
      parts: it.parts.slice(0, OPTION_IDS.length).map((p, i) => {
        count(p.prompt);
        const part: ExportQuestion["parts"][number] = { id: OPTION_IDS[i]!, label: cleanOrNull(p.label), level: p.level ?? null, prompt: clean(p.prompt), marks: round2(p.marks) };
        if (include.answers) part.answer = p.answer ? answer(p.answer) : null;
        return part;
      }),
      difficulty: it.difficulty,
      subject: cleanOrNull(it.subject),
      topic: cleanOrNull(it.topic),
      tags: it.tags.map(clean),
      marks: round2(it.marks),
      negativeMarks: round2(it.negativeMarks),
      sourceSupport: it.sourceSupport,
    };
    count(q.stem);
    count(q.stimulus);
    if (include.answers) {
      if (it.kind === "MCQ") {
        const mapped = it.correctOptionId ? optionIds.get(it.correctOptionId) : undefined;
        if (!mapped) bad(`Question ${qi + 1} has no valid correct answer, so answers cannot be exported.`);
        q.correctOptionId = mapped;
      } else {
        q.correctOptionId = null;
      }
      q.answer = it.answer ? answer(it.answer) : null;
    }
    if (include.explanations) {
      q.explanation = cleanOrNull(it.explanation);
      count(q.explanation);
    }
    if (include.notes) {
      q.shortNote = cleanOrNull(it.shortNote);
      count(q.shortNote);
    }
    if (include.sources) q.sources = it.sources.map(source);
    return q;
  });
}

// ---------------------------------------------------------------- labels (shared by txt + pdf)

const BN_LABELS = ["ক", "খ", "গ", "ঘ", "ঙ", "চ"];
const EN_LABELS = ["A", "B", "C", "D", "E", "F"];

export const optionLabel = (language: Language, index: number) => (language === "bn" ? BN_LABELS : EN_LABELS)[index] ?? String(index + 1);
export const partLabel = (language: Language, index: number, given: string | null) => given?.trim() || (language === "bn" ? BN_LABELS : ["a", "b", "c", "d", "e", "f"])[index] || String(index + 1);

type Strings = {
  answer: string; modelAnswer: string; explanation: string; note: string; sources: string; stimulus: string; key: string;
  mark: string; marks: string; negative: string; page: string; of: string; questions: string; exported: string; question: string; topic: string; tags: string; subject: string;
};
const EN: Strings = {
  answer: "Answer", modelAnswer: "Model answer", explanation: "Explanation", note: "Note", sources: "Sources", stimulus: "Stimulus", key: "Answer key",
  mark: "mark", marks: "marks", negative: "negative marking", page: "Page", of: "of", questions: "questions", exported: "Exported", question: "Question", topic: "Topic", tags: "Tags", subject: "Subject",
};
const BN: Strings = {
  answer: "উত্তর", modelAnswer: "নমুনা উত্তর", explanation: "ব্যাখ্যা", note: "টীকা", sources: "উৎস", stimulus: "উদ্দীপক", key: "উত্তরমালা",
  mark: "নম্বর", marks: "নম্বর", negative: "ঋণাত্মক নম্বর", page: "পৃষ্ঠা", of: "/", questions: "প্রশ্ন", exported: "রপ্তানি", question: "প্রশ্ন", topic: "প্রসঙ্গ", tags: "ট্যাগ", subject: "বিষয়",
};
export const strings = (language: Language): Strings => (language === "bn" ? BN : EN);

const DIFFICULTY: Record<Language, Record<Difficulty, string>> = {
  en: { EASY: "Easy", MEDIUM: "Medium", HARD: "Hard" },
  bn: { EASY: "সহজ", MEDIUM: "মাঝারি", HARD: "কঠিন" },
};
export const difficultyLabel = (language: Language, d: Difficulty) => DIFFICULTY[language][d];

const LEVEL: Record<Language, Record<CqLevel, string>> = {
  en: { KNOWLEDGE: "Knowledge", COMPREHENSION: "Comprehension", APPLICATION: "Application", HIGHER_ORDER: "Higher-order skills" },
  bn: { KNOWLEDGE: "জ্ঞানমূলক", COMPREHENSION: "অনুধাবনমূলক", APPLICATION: "প্রয়োগমূলক", HIGHER_ORDER: "উচ্চতর দক্ষতামূলক" },
};
export const levelLabel = (language: Language, l: CqLevel) => LEVEL[language][l];

const BASIS: Record<Language, Record<AnswerBasis, string>> = {
  en: {
    SOURCE_SUPPORTED: "Supported by your sources",
    GENERAL_REASONING: "General reasoning (not from your sources)",
    INSUFFICIENT_EVIDENCE: "Insufficient evidence in the selected sources",
    USER_PROVIDED: "Written by you",
  },
  bn: {
    SOURCE_SUPPORTED: "আপনার উৎস দ্বারা সমর্থিত",
    GENERAL_REASONING: "সাধারণ যুক্তি (আপনার উৎস থেকে নয়)",
    INSUFFICIENT_EVIDENCE: "নির্বাচিত উৎসে পর্যাপ্ত তথ্য নেই",
    USER_PROVIDED: "আপনার লেখা",
  },
};
export const basisLabel = (language: Language, b: AnswerBasis) => BASIS[language][b];

const SUPPORT: Record<Language, Record<SourceSupport, string>> = {
  en: { SOURCE_QUOTED: "Evidence quoted from source", MODEL_ONLY: "AI-generated, not source-checked", NONE: "Written by you" },
  bn: { SOURCE_QUOTED: "উৎস থেকে প্রমাণ উদ্ধৃত", MODEL_ONLY: "এআই-তৈরি, উৎস যাচাই করা হয়নি", NONE: "আপনার লেখা" },
};
export const supportLabel = (language: Language, s: SourceSupport) => SUPPORT[language][s];

export const kindLabel = (k: QuestionKind) => k;

export function formatMarks(language: Language, n: number): string {
  const s = String(round2(n));
  const t = strings(language);
  return `${s} ${n === 1 && language === "en" ? t.mark : t.marks}`;
}

/** "MCQ · Medium · 1 mark · negative marking 0.25" */
export function metaLine(q: ExportQuestion): string {
  const t = strings(q.language);
  const bits: string[] = [kindLabel(q.kind), difficultyLabel(q.language, q.difficulty), formatMarks(q.language, q.marks)];
  if (q.negativeMarks > 0) bits.push(`${t.negative} ${round2(q.negativeMarks)}`);
  return bits.join(" · ");
}

export function contextLine(q: ExportQuestion): string | null {
  const t = strings(q.language);
  const bits: string[] = [];
  if (q.subject) bits.push(`${t.subject}: ${q.subject}`);
  if (q.topic) bits.push(`${t.topic}: ${q.topic}`);
  if (q.tags.length) bits.push(`${t.tags}: ${q.tags.join(", ")}`);
  return bits.length ? bits.join(" · ") : null;
}

export function sourceLine(s: ExportSource): string {
  const loc = s.page != null ? ` (p. ${s.page})` : s.section ? ` (${s.section})` : "";
  return `${s.documentName}${loc}: “${s.quote}”`;
}

export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
