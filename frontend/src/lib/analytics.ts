import { BAND_ORDER, isBand, type FeedbackBand } from "@/lib/bands";
import { EN, type Formatters, type I18n } from "@/lib/format-locale";
import { msg } from "@/lib/i18n/translate";

/**
 * Types and pure helpers for the student dashboard (docs/PART5_SPEC.md §1, §7). Every number is computed by the server from finalized,
 * released results; this module only reads, normalises and formats it. `null` always means "no data", never zero.
 */

export type DataLevel = "NONE" | "INITIAL" | "BASED_ON_HISTORY";
export type TopicStat = { topic: string; questions: number; correct: number; incorrect: number; unanswered: number; accuracyBp: number; sufficient: boolean };
export type TrendPoint = { attemptId: string; examId: string; examTitle: string; finalizedAt: string; percentBp: number; band: FeedbackBand | null };
export type StepType = "REVIEW_NOTES" | "REVISIT_QUESTIONS" | "PRACTICE_MCQ" | "PRACTICE_CQ" | "COMPARE_ATTEMPTS" | "ASK_ASSISTANT" | "READ_DOCUMENT";
export type Suggestion = { type: StepType | string; topic: string | null; label: string; href: string; reason: string };
export type FeedbackStatus = "PENDING" | "READY" | "FAILED" | "NOT_CONFIGURED" | "NONE";
export type RecentFeedback = { attemptId: string; examTitle: string; status: FeedbackStatus; summary: string | null; generatedAt: string | null };
export type SavedContent = { collections: number; mcqQuestions: number; cqQuestions: number; questionsWithNotes: number; recentCollections: { id: string; title: string; questionCount: number }[] };
export type GroupBrief = { id: string; title: string; role: string; nextExam: { examId: string; title: string; opensAt: string | null; closesAt: string | null } | null };
export type Totals = { completed: number; average: number | null; highest: number | null; lowest: number | null; correct: number; incorrect: number; unanswered: number };

export type AnalyticsMe = {
  dataLevel: DataLevel;
  totals: Totals;
  bandCounts: Partial<Record<FeedbackBand, number>>;
  trend: TrendPoint[];
  topics: TopicStat[];
  weakTopics: string[];
  strongTopics: string[];
  recentFeedback: RecentFeedback[];
  suggestions: Suggestion[];
  saved: SavedContent;
  groups: GroupBrief[];
  unreadNotifications: number;
};

export type ResultRow = {
  attemptId: string; examId: string; examTitle: string; finalizedAt: string; scoreCenti: number; maxCenti: number; percentBp: number; band: FeedbackBand | null;
  correct: number; incorrect: number; unanswered: number;
};
export type ResultsPage = { items: ResultRow[]; total: number; page: number; pageSize: number };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => num(v) ?? 0;
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Only same-site paths are ever linked from server-provided hrefs (no protocol-relative or absolute URLs). */
export function safeInternalHref(href: unknown, fallback = "/dashboard"): string {
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//") || href.includes("\\") || /[\u0000-\u001f]/.test(href)) return fallback;
  return href;
}

export function readTopic(raw: unknown): TopicStat {
  const t = isRec(raw) ? raw : {};
  const questions = int(t.questions);
  return {
    topic: str(t.topic, "General") || "General", questions, correct: int(t.correct), incorrect: int(t.incorrect), unanswered: int(t.unanswered), accuracyBp: int(t.accuracyBp),
    sufficient: typeof t.sufficient === "boolean" ? t.sufficient : questions >= 3,
  };
}

const topicNames = (v: unknown): string[] => arr(v).map((x) => (typeof x === "string" ? x : isRec(x) ? str(x.topic) : "")).filter(Boolean);
const FEEDBACK: FeedbackStatus[] = ["PENDING", "READY", "FAILED", "NOT_CONFIGURED", "NONE"];

export function readAnalytics(raw: unknown): AnalyticsMe {
  const r = isRec(raw) ? raw : {};
  const t = isRec(r.totals) ? r.totals : {};
  const sv = isRec(r.saved) ? r.saved : {};
  const bandCounts: Partial<Record<FeedbackBand, number>> = {};
  if (isRec(r.bandCounts)) for (const b of BAND_ORDER) if (num(r.bandCounts[b]) !== null) bandCounts[b] = int(r.bandCounts[b]);
  return {
    dataLevel: r.dataLevel === "INITIAL" || r.dataLevel === "BASED_ON_HISTORY" ? r.dataLevel : "NONE",
    totals: { completed: int(t.completed), average: num(t.average), highest: num(t.highest), lowest: num(t.lowest), correct: int(t.correct), incorrect: int(t.incorrect), unanswered: int(t.unanswered) },
    bandCounts,
    trend: arr(r.trend).map((p) => {
      const x = isRec(p) ? p : {};
      return { attemptId: str(x.attemptId), examId: str(x.examId), examTitle: str(x.examTitle, "Exam"), finalizedAt: str(x.finalizedAt), percentBp: int(x.percentBp), band: isBand(x.band) ? x.band : null };
    }),
    topics: arr(r.topics).map(readTopic),
    weakTopics: topicNames(r.weakTopics),
    strongTopics: topicNames(r.strongTopics),
    recentFeedback: arr(r.recentFeedback).map((f) => {
      const x = isRec(f) ? f : {};
      return { attemptId: str(x.attemptId), examTitle: str(x.examTitle, "Exam"), status: FEEDBACK.includes(x.status as FeedbackStatus) ? (x.status as FeedbackStatus) : "NONE", summary: typeof x.summary === "string" ? x.summary : null, generatedAt: typeof x.generatedAt === "string" ? x.generatedAt : null };
    }),
    suggestions: arr(r.suggestions).map((s) => {
      const x = isRec(s) ? s : {};
      return { type: str(x.type), topic: typeof x.topic === "string" ? x.topic : null, label: str(x.label), href: safeInternalHref(x.href), reason: str(x.reason) };
    }).filter((s) => s.label),
    saved: {
      collections: int(sv.collections), mcqQuestions: int(sv.mcqQuestions), cqQuestions: int(sv.cqQuestions), questionsWithNotes: int(sv.questionsWithNotes),
      recentCollections: arr(sv.recentCollections).map((c) => {
        const x = isRec(c) ? c : {};
        return { id: str(x.id), title: str(x.title, "Collection"), questionCount: int(x.questionCount) };
      }).filter((c) => c.id),
    },
    groups: arr(r.groups).map((g) => {
      const x = isRec(g) ? g : {};
      const ne = isRec(x.nextExam) ? x.nextExam : null;
      return {
        id: str(x.id), title: str(x.title, "Group"), role: str(x.role),
        nextExam: ne ? { examId: str(ne.examId), title: str(ne.title, "Exam"), opensAt: typeof ne.opensAt === "string" ? ne.opensAt : null, closesAt: typeof ne.closesAt === "string" ? ne.closesAt : null } : null,
      };
    }).filter((g) => g.id),
    unreadNotifications: int(r.unreadNotifications),
  };
}

export function readResultsPage(raw: unknown): ResultsPage {
  const r = isRec(raw) ? raw : {};
  const items = arr(r.items).map((i) => {
    const x = isRec(i) ? i : {};
    return {
      attemptId: str(x.attemptId), examId: str(x.examId), examTitle: str(x.examTitle, "Exam"), finalizedAt: str(x.finalizedAt), scoreCenti: int(x.scoreCenti), maxCenti: int(x.maxCenti),
      percentBp: int(x.percentBp), band: isBand(x.band) ? x.band : null, correct: int(x.correct), incorrect: int(x.incorrect), unanswered: int(x.unanswered),
    };
  }).filter((i) => i.attemptId);
  return { items, total: int(r.total) || items.length, page: int(r.page) || 1, pageSize: int(r.pageSize) || (items.length || 1) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Formatting and chart mapping
// ---------------------------------------------------------------------------------------------------------------------
/** Basis points → "87.50%". `null` is "No data yet" — never "0.00%" (a real zero score is a number). */
export function formatAccuracy(bp: number | null | undefined, empty = "No data yet", i18n: I18n = EN): string {
  return bp === null || bp === undefined ? empty : i18n.format.percentBp(bp);
}

export const hasResults = (a: AnalyticsMe): boolean => a.totals.completed > 0;

export function answeredTotal(t: Totals): number {
  return t.correct + t.incorrect + t.unanswered;
}

/** Share of each outcome, in whole-number percent for bar widths only (the exact counts are always shown as text). */
export function breakdown(t: Totals): { key: "correct" | "incorrect" | "unanswered"; label: string; count: number; pct: number }[] {
  const total = answeredTotal(t);
  return (["correct", "incorrect", "unanswered"] as const).map((key) => ({
    key,
    label: key === "correct" ? msg("Correct") : key === "incorrect" ? msg("Incorrect") : msg("Unanswered"),
    count: t[key],
    pct: total > 0 ? Math.round((t[key] / total) * 100) : 0,
  }));
}

export type TrendDatum = { x: number; label: string; fullDate: string; pct: number; examTitle: string; band: FeedbackBand | null };
export function trendChartData(trend: TrendPoint[], format: Formatters = EN.format): TrendDatum[] {
  return trend.map((p, i) => {
    const d = new Date(p.finalizedAt);
    const valid = !Number.isNaN(d.getTime());
    return {
      x: i + 1,
      label: valid ? format.dateShort(d) : `#${i + 1}`,
      fullDate: valid ? format.dateTime(d) : "",
      pct: p.percentBp / 100,
      examTitle: p.examTitle,
      band: p.band,
    };
  });
}

export type TopicDatum = { name: string; pct: number; correct: number; answered: number; sufficient: boolean };
/** Weakest first. Topics without enough answers are kept but flagged, so the chart can show them as neutral — never as weak. */
export function topicChartData(topics: TopicStat[]): TopicDatum[] {
  return [...topics]
    .sort((a, b) => Number(b.sufficient) - Number(a.sufficient) || a.accuracyBp - b.accuracyBp || b.questions - a.questions || a.topic.localeCompare(b.topic))
    .map((t) => ({ name: t.topic, pct: t.accuracyBp / 100, correct: t.correct, answered: t.questions, sufficient: t.sufficient }));
}

export const WEAK_BELOW_BP = 7000;
export const topicIsWeak = (t: TopicStat): boolean => t.sufficient && t.accuracyBp < WEAK_BELOW_BP;

export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  PENDING: msg("Being written"), READY: msg("Ready"), FAILED: msg("Couldn't generate"), NOT_CONFIGURED: msg("Needs a model"), NONE: msg("Not requested"),
};

export const DATA_LEVEL_TEXT: Record<DataLevel, { label: string; hint: string }> = {
  NONE: { label: msg("No results yet"), hint: msg("Once you finish an exam and its results are released, your numbers appear here.") },
  INITIAL: { label: msg("Initial picture"), hint: msg("Based on only a few results, so treat these as early signals — one exam can't show how well you know a topic.") },
  BASED_ON_HISTORY: { label: msg("Based on your history"), hint: msg("Built from several results across your exams. Still a snapshot, not a final verdict.") },
};

export const STEP_LABEL: Record<string, string> = {
  REVIEW_NOTES: msg("Review notes"), REVISIT_QUESTIONS: msg("Revisit questions"), PRACTICE_MCQ: msg("Practice MCQs"), PRACTICE_CQ: msg("Practice CQs"),
  COMPARE_ATTEMPTS: msg("Compare attempts"), ASK_ASSISTANT: msg("Ask the assistant"), READ_DOCUMENT: msg("Read your document"),
};
