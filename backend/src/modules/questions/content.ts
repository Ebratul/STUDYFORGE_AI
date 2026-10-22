import { randomBytes } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";
import { normalizeTags } from "./text.js";
import { round2, type NormalizedQuestion } from "./schemas.js";
import type { AnswerObj, QuestionContent, QuestionDraft, QuestionView, SourceRef } from "./types.js";

export const newId = () => `c${randomBytes(12).toString("hex")}`;

/** What every read of a saved question loads. Options/parts are position-ordered; sources are split into question-level and answer-level. */
export const questionInclude = {
  options: { orderBy: { position: "asc" } },
  parts: { orderBy: { position: "asc" }, include: { answer: { include: { sources: { orderBy: { ordinal: "asc" } } } } } },
  answers: { where: { partId: null }, include: { sources: { orderBy: { ordinal: "asc" } } } },
  sources: { where: { answerId: null }, orderBy: { ordinal: "asc" } },
} satisfies Prisma.QuestionInclude;

export type QuestionRow = Prisma.QuestionGetPayload<{ include: typeof questionInclude }>;

type SourceRow = { documentId: string | null; documentName: string; page: number | null; section: string | null; quote: string; quoteVerified: boolean };

export const sourceRef = (s: SourceRow): SourceRef => ({
  documentName: s.documentName,
  documentId: s.documentId,
  page: s.page,
  section: s.section,
  quote: s.quote,
  quoteVerified: s.quoteVerified,
});

const answerObj = (a: { text: string; basis: AnswerObj["basis"]; sources: SourceRow[] } | null | undefined): AnswerObj | null =>
  a ? { text: a.text, basis: a.basis, sources: a.sources.map(sourceRef) } : null;

export function contentFromRow(r: QuestionRow): QuestionContent {
  const correct = r.options.find((o) => o.isCorrect);
  return {
    kind: r.kind,
    language: r.language,
    stem: r.stem,
    stimulus: r.stimulus,
    options: r.options.map((o) => ({ id: o.id, text: o.text })),
    correctOptionId: correct?.id ?? null,
    parts: r.parts.map((p) => ({ id: p.id, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks, answer: answerObj(p.answer) })),
    answer: answerObj(r.answers[0]),
    explanation: r.explanation,
    shortNote: r.shortNote,
    difficulty: r.difficulty,
    subject: r.subject,
    topic: r.topic,
    tags: r.tags,
    marks: r.marks,
    negativeMarks: r.negativeMarks,
    sources: r.sources.map(sourceRef),
    sourceSupport: r.sourceSupport,
    reviewReasons: r.reviewReasons,
  };
}

export function toView(r: QuestionRow, collections?: { id: string; title: string }[]): QuestionView {
  return {
    ...contentFromRow(r),
    id: r.id,
    schemaVersion: 1,
    version: r.version,
    origin: r.origin,
    modifiedByUser: r.modifiedByUser,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    needsReview: r.reviewReasons.length > 0 && !r.reviewedAt,
    provenance:
      r.origin === "AI_GENERATED"
        ? { provider: r.provenanceProvider ?? "", model: r.provenanceModel ?? "", generationRunId: r.generationRunId, generatedAt: (r.generatedAt ?? r.createdAt).toISOString() }
        : null,
    ...(collections ? { collections } : {}),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Provenance decided by the server (never taken from the client): see docs/PART3_SPEC.md §0.1. */
export type Derived = {
  origin: "AI_GENERATED" | "USER_AUTHORED";
  sourceSupport: QuestionContent["sourceSupport"];
  reviewReasons: string[];
  sources: SourceRef[];
  modifiedByUser: boolean;
  /** Answer for each part (by index) and for a part-less CQ. */
  partAnswers: (AnswerObj | null)[];
  answer: AnswerObj | null;
};

export function buildContent(n: NormalizedQuestion, d: Derived, ids?: { options?: string[]; parts?: string[] }): QuestionContent {
  const optionIds = n.options.map((_, i) => ids?.options?.[i] ?? n.options[i]?.clientId ?? `o${i + 1}`);
  const partIds = n.parts.map((_, i) => ids?.parts?.[i] ?? n.parts[i]?.clientId ?? `p${i + 1}`);
  return {
    kind: n.kind,
    language: n.language,
    stem: n.stem,
    stimulus: n.stimulus,
    options: n.options.map((o, i) => ({ id: optionIds[i]!, text: o.text })),
    correctOptionId: n.correctIndex !== null && n.correctIndex >= 0 ? (optionIds[n.correctIndex] ?? null) : null,
    parts: n.parts.map((p, i) => ({ id: partIds[i]!, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks, answer: d.partAnswers[i] ?? null })),
    answer: d.answer,
    explanation: n.explanation,
    shortNote: n.shortNote,
    difficulty: n.difficulty,
    subject: n.subject,
    topic: n.topic,
    tags: normalizeTags(n.tags),
    marks: round2(n.marks),
    negativeMarks: round2(n.negativeMarks),
    sources: d.sources,
    sourceSupport: d.sourceSupport,
    reviewReasons: d.reviewReasons,
  };
}

/** Normalised (id-free) form of stored/draft content: used to compare a draft with what the user submits. */
export function normalizedFromContent(c: QuestionContent): NormalizedQuestion {
  const idx = c.correctOptionId ? c.options.findIndex((o) => o.id === c.correctOptionId) : -1;
  return {
    runQuestionId: undefined,
    kind: c.kind,
    language: c.language,
    stem: c.stem,
    stimulus: c.stimulus,
    options: c.options.map((o) => ({ clientId: o.id, text: o.text })),
    correctIndex: c.kind === "MCQ" ? idx : null,
    parts: c.parts.map((p) => ({ clientId: p.id, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks, answerText: p.answer?.text ?? null })),
    answerText: c.answer?.text ?? null,
    explanation: c.explanation,
    shortNote: c.shortNote,
    difficulty: c.difficulty,
    subject: c.subject,
    topic: c.topic,
    tags: c.tags,
    marks: c.marks,
    negativeMarks: c.negativeMarks,
  };
}

export const draftFromContent = (id: string, c: QuestionContent): QuestionDraft => ({ id, ...c });
