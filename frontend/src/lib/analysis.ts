import { isBand, type FeedbackBand } from "@/lib/bands";
import { safeInternalHref, type DataLevel, type FeedbackStatus, type StepType } from "@/lib/analytics";
import { ApiError } from "@/lib/api";
import { EN } from "@/lib/format-locale";
import { msg, type TFunction } from "@/lib/i18n/translate";

/** Types and helpers for AI feedback (docs/PART5_SPEC.md §3–§5). AI text is derived, disposable and never changes a score. */

export type AnalysisStep = { type: StepType | string; topic: string | null; text: string };
export type AnalysisContent = {
  summary: string;
  strengths: { topic: string; detail: string }[];
  weaknesses: { topic: string; detail: string; evidence: string }[];
  nextSteps: AnalysisStep[];
  caveats: string[];
};
export type AnalysisView = {
  attemptId: string;
  status: FeedbackStatus;
  deterministic: { band: FeedbackBand | null; label: string; message: string; percentBp: number | null } | null;
  content: AnalysisContent | null;
  generatedAt: string | null;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  canRetry: boolean;
  dataLevel: DataLevel;
  disclaimer: string;
};
export const DEFAULT_DISCLAIMER = msg("AI-generated from your verified results. It does not change your score.");

export type PlanContent = { headline: string; focus: { topic: string; reason: string }[]; steps: (AnalysisStep & { minutes: number | null })[]; caveats: string[] };
export type PlanView = {
  id: string; status: FeedbackStatus; label: "INITIAL_SUGGESTIONS" | "BASED_ON_HISTORY"; content: PlanContent | null;
  basis: { results: number; topics: number; answered: number }; generatedAt: string | null; errorCode: string | null; stale: boolean; canRetry: boolean;
};
export type PlanAction = { type: StepType | string; topic: string | null; label: string; href: string; reason: string };
export type PlanData = {
  dataLevel: DataLevel;
  weakTopics: string[];
  strongTopics: string[];
  notEnoughData: string[];
  actions: PlanAction[];
  plan: PlanView | null;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const nstr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const STATUSES: FeedbackStatus[] = ["PENDING", "READY", "FAILED", "NOT_CONFIGURED", "NONE"];
const status = (v: unknown): FeedbackStatus => (STATUSES.includes(v as FeedbackStatus) ? (v as FeedbackStatus) : "NONE");
const level = (v: unknown): DataLevel => (v === "INITIAL" || v === "BASED_ON_HISTORY" ? v : "NONE");
const names = (v: unknown): string[] => arr(v).map((x) => (typeof x === "string" ? x : isRec(x) ? str(x.topic) : "")).filter(Boolean);

function readStep(raw: unknown): AnalysisStep {
  const s = isRec(raw) ? raw : {};
  return { type: str(s.type), topic: nstr(s.topic), text: str(s.text) };
}

export function readContent(raw: unknown): AnalysisContent | null {
  if (!isRec(raw)) return null;
  return {
    summary: str(raw.summary),
    strengths: arr(raw.strengths).map((x) => (isRec(x) ? { topic: str(x.topic), detail: str(x.detail) } : { topic: "", detail: "" })).filter((x) => x.topic || x.detail),
    weaknesses: arr(raw.weaknesses).map((x) => (isRec(x) ? { topic: str(x.topic), detail: str(x.detail), evidence: str(x.evidence) } : { topic: "", detail: "", evidence: "" })).filter((x) => x.topic || x.detail),
    nextSteps: arr(raw.nextSteps).map(readStep).filter((s) => s.text),
    caveats: arr(raw.caveats).map((c) => str(c)).filter(Boolean),
  };
}

/** Accepts `{ analysis: … }` or the bare object. */
export function readAnalysis(raw: unknown): AnalysisView {
  const a = isRec(raw) && isRec(raw.analysis) ? raw.analysis : isRec(raw) ? raw : {};
  const d = isRec(a.deterministic) ? a.deterministic : null;
  return {
    attemptId: str(a.attemptId),
    status: status(a.status),
    deterministic: d ? { band: isBand(d.band) ? d.band : null, label: str(d.label), message: str(d.message), percentBp: num(d.percentBp) } : null,
    content: readContent(a.content),
    generatedAt: nstr(a.generatedAt), provider: nstr(a.provider), model: nstr(a.model), errorCode: nstr(a.errorCode),
    canRetry: a.canRetry === true, dataLevel: level(a.dataLevel), disclaimer: str(a.disclaimer) || DEFAULT_DISCLAIMER,
  };
}

export function readPlanView(raw: unknown): PlanView | null {
  const p = isRec(raw) ? raw : null;
  if (!p) return null;
  const c = isRec(p.content) ? p.content : null;
  const b = isRec(p.basis) ? p.basis : {};
  return {
    id: str(p.id), status: status(p.status), label: p.label === "BASED_ON_HISTORY" ? "BASED_ON_HISTORY" : "INITIAL_SUGGESTIONS",
    content: c
      ? {
          headline: str(c.headline),
          focus: arr(c.focus).map((x) => (isRec(x) ? { topic: str(x.topic), reason: str(x.reason) } : { topic: "", reason: "" })).filter((x) => x.topic),
          steps: arr(c.steps).map((x) => ({ ...readStep(x), minutes: isRec(x) ? num(x.minutes) : null })).filter((s) => s.text),
          caveats: arr(c.caveats).map((x) => str(x)).filter(Boolean),
        }
      : null,
    basis: { results: num(b.results) ?? 0, topics: num(b.topics) ?? 0, answered: num(b.answered) ?? 0 },
    generatedAt: nstr(p.generatedAt), errorCode: nstr(p.errorCode), stale: p.stale === true, canRetry: p.canRetry === true,
  };
}

/** `GET /api/analysis/plan`: the deterministic part (always present) plus the latest AI plan, if any. */
export function readPlanData(raw: unknown): PlanData {
  const r = isRec(raw) ? raw : {};
  const actions = arr(r.actions ?? r.suggestions).map((s) => {
    const x = isRec(s) ? s : {};
    return { type: str(x.type), topic: nstr(x.topic), label: str(x.label), href: safeInternalHref(x.href, "/question-bank"), reason: str(x.reason) };
  }).filter((a) => a.label);
  return {
    dataLevel: level(r.dataLevel), weakTopics: names(r.weakTopics), strongTopics: names(r.strongTopics), notEnoughData: names(r.notEnoughData),
    actions, plan: readPlanView(r.plan),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Polling and error wording
// ---------------------------------------------------------------------------------------------------------------------
/** Poll delays (ms) while an AI job is PENDING: quick at first, then backing off; `null` = stop polling (the user can refresh). */
export function pollDelay(attempt: number): number | null {
  const steps = [1500, 2500, 4000, 6000, 8000, 12_000, 15_000];
  if (attempt >= 20) return null;
  return steps[Math.min(attempt, steps.length - 1)]!;
}

export const isPending = (s: FeedbackStatus | undefined | null): boolean => s === "PENDING";

export const FAILURE_TEXT: Record<string, string> = {
  QUOTA_EXCEEDED: msg("You've reached your AI usage limit for now, so feedback couldn't be written. Your score is unaffected."),
  PROVIDER_AUTH_INVALID: msg("Your AI provider rejected the API key. Check it in Settings → AI connection."),
  PROVIDER_RATE_LIMITED: msg("Your AI provider is rate-limiting requests. Try again in a minute."),
  PROVIDER_TIMEOUT: msg("Your AI provider took too long to answer. Try again."),
  PROVIDER_UNAVAILABLE: msg("Your AI provider is unavailable right now. Try again shortly."),
  UPSTREAM_UNAVAILABLE: msg("The AI service is unavailable right now. Try again shortly."),
  MODEL_NOT_FOUND: msg("The selected model isn't available for your key. Choose another in Settings → AI connection."),
  INVALID_OUTPUT: msg("The AI's answer didn't pass our checks, so nothing was kept. Try again."),
  UNGROUNDED_OUTPUT: msg("The AI's answer mentioned things your results don't support, so it was discarded. Try again."),
};
export const describeFailure = (code: string | null | undefined, t: TFunction = EN.t): string => t((code && FAILURE_TEXT[code]) || msg("AI feedback couldn't be generated this time. Your verified score and the standard feedback above are unaffected."));

export function describeAnalysisRequestError(err: unknown, t: TFunction = EN.t): string {
  if (err instanceof ApiError) {
    if (err.code === "RATE_LIMITED") return t("You've asked for AI feedback a lot recently. Please wait a little and try again.");
    if (err.code === "QUOTA_EXCEEDED") return err.message;
    if (err.code === "CONFLICT") return t("These results haven't been released yet, so AI feedback isn't available.");
    return err.message;
  }
  return t("Couldn't reach the server. Check your connection and try again.");
}

/** Next-step links: only for step types that map to a place in the app; everything else is plain text. */
export function stepHref(step: { type: string; topic: string | null }): string | null {
  const t = step.topic ? encodeURIComponent(step.topic.slice(0, 120)) : null;
  switch (step.type) {
    case "REVIEW_NOTES":
    case "REVISIT_QUESTIONS": return t ? `/question-bank?topic=${t}` : "/question-bank";
    case "PRACTICE_MCQ": return t ? `/mcq?topic=${t}&grounding=GENERAL` : "/mcq";
    case "PRACTICE_CQ": return t ? `/cq?topic=${t}&grounding=GENERAL` : "/cq";
    case "READ_DOCUMENT": return "/documents";
    case "ASK_ASSISTANT": return "/chat";
    default: return null;
  }
}
