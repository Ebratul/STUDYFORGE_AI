import type { ExportInclude, ExportItem, QuestionContent } from "../../src/modules/questions/types.js";

export const FULL: ExportInclude = { answers: true, explanations: true, notes: true, sources: true };
export const NONE: ExportInclude = { answers: false, explanations: false, notes: false, sources: false };

const base: QuestionContent = {
  kind: "MCQ", language: "en", stem: "", stimulus: null, options: [], correctOptionId: null, parts: [], answer: null,
  explanation: null, shortNote: null, difficulty: "MEDIUM", subject: null, topic: null, tags: [], marks: 1, negativeMarks: 0,
  sources: [], sourceSupport: "MODEL_ONLY", reviewReasons: [],
};

export const SRC = { documentName: "Biology.pdf", documentId: "doc_PRIVATE_1", page: 12, section: null, quote: "Chloroplasts contain chlorophyll.", quoteVerified: true };

export function mcq(over: Partial<QuestionContent> = {}): QuestionContent {
  return {
    ...base,
    stem: "Which organelle carries out photosynthesis?",
    options: [{ id: "opt_zz1", text: "Mitochondrion" }, { id: "opt_zz2", text: "Chloroplast" }, { id: "opt_zz3", text: "Ribosome" }, { id: "opt_zz4", text: "Nucleus" }],
    correctOptionId: "opt_zz2",
    explanation: "Chloroplasts contain chlorophyll.",
    shortNote: "Light reactions occur in thylakoids.",
    topic: "Photosynthesis", subject: "Biology", tags: ["plants"],
    sources: [SRC], sourceSupport: "SOURCE_QUOTED", reviewReasons: ["SOLVER_DISAGREES"],
    ...over,
  };
}

export function bnMcq(over: Partial<QuestionContent> = {}): QuestionContent {
  return mcq({
    language: "bn",
    stem: "সালোকসংশ্লেষণ প্রক্রিয়ায় কোন গ্যাসটি নির্গত হয়?",
    options: [{ id: "x1", text: "অক্সিজেন" }, { id: "x2", text: "কার্বন ডাই-অক্সাইড" }, { id: "x3", text: "নাইট্রোজেন" }, { id: "x4", text: "হাইড্রোজেন" }],
    correctOptionId: "x1", explanation: "উদ্ভিদ অক্সিজেন ত্যাগ করে।", shortNote: "ক্লোরোফিল আলো শোষণ করে।", subject: "জীববিজ্ঞান", topic: "সালোকসংশ্লেষণ", tags: ["উদ্ভিদ"],
    sources: [{ ...SRC, documentName: "জীববিজ্ঞান.pdf", quote: "সালোকসংশ্লেষণ একটি প্রক্রিয়া" }],
    ...over,
  });
}

export function cq(over: Partial<QuestionContent> = {}): QuestionContent {
  return {
    ...base, kind: "CQ", language: "bn", marks: 10, negativeMarks: 0, difficulty: "HARD",
    stem: "উদ্দীপকটি পড়ে প্রশ্নগুলোর উত্তর দাও।",
    stimulus: "রহিম সাহেব তাঁর বাগানে একটি গাছ লাগালেন।",
    parts: [
      { id: "pp1", label: "ক", level: "KNOWLEDGE", prompt: "সালোকসংশ্লেষণ কী?", marks: 1, answer: { text: "খাদ্য তৈরির প্রক্রিয়া।", basis: "SOURCE_SUPPORTED", sources: [SRC] } },
      { id: "pp2", label: "খ", level: "COMPREHENSION", prompt: "ক্লোরোফিল কেন গুরুত্বপূর্ণ?", marks: 2, answer: { text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] } },
      { id: "pp3", label: "গ", level: "APPLICATION", prompt: "ব্যাখ্যা করো।", marks: 3, answer: null },
      { id: "pp4", label: "ঘ", level: "HIGHER_ORDER", prompt: "বিশ্লেষণ করো।", marks: 4, answer: { text: "সাধারণ যুক্তি।", basis: "GENERAL_REASONING", sources: [] } },
    ],
    sources: [SRC], sourceSupport: "SOURCE_QUOTED",
    ...over,
  };
}

/** Items carrying properties that must never reach an export. */
export function withPrivate(q: QuestionContent): ExportItem {
  return {
    ...q,
    ownerId: "owner_SECRET_42", id: "cuid_QUESTION_ID", provider: "openai", model: "gpt-SECRET", generationRunId: "run_SECRET", apiKey: "sk-SECRETKEY",
    provenance: { provider: "openai", model: "gpt-SECRET" }, createdAt: "2026-01-01T00:00:00Z", email: "someone@example.com",
  } as unknown as ExportItem;
}

export const PRIVATE_MARKERS = ["owner_SECRET_42", "cuid_QUESTION_ID", "gpt-SECRET", "run_SECRET", "sk-SECRETKEY", "someone@example.com", "doc_PRIVATE_1", "opt_zz2", "SOLVER_DISAGREES"];
