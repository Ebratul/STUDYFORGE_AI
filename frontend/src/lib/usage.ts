import { EN, type I18n } from "@/lib/format-locale";
import { msg } from "@/lib/i18n/translate";
/** AI usage as reported by `GET /api/ai/usage` (docs/PART5_SPEC.md §8). Tokens are what the provider reports; no cost is estimated. */

export type UsageWindow = { tokens: number; requests: number; tokenLimit: number; requestLimit: number; resetsAt: string | null };
export type UsageByTask = { task: string; requests: number; tokens: number };
export type UsageData = { daily: UsageWindow; monthly: UsageWindow | null; byTask: UsageByTask[]; note: string };
export const DEFAULT_USAGE_NOTE = msg("Tokens are what your provider reports. StudyForge does not know your provider's prices and shows no cost estimate.");

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function readWindow(raw: unknown): UsageWindow | null {
  if (!isRec(raw)) return null;
  return { tokens: int(raw.tokens), requests: int(raw.requests), tokenLimit: int(raw.tokenLimit), requestLimit: int(raw.requestLimit), resetsAt: typeof raw.resetsAt === "string" ? raw.resetsAt : null };
}

export function readUsage(raw: unknown): UsageData | null {
  if (!isRec(raw)) return null;
  const daily = readWindow(raw.daily) ?? readWindow(raw); // older servers return the daily window at the top level
  if (!daily) return null;
  return {
    daily,
    monthly: readWindow(raw.monthly),
    byTask: (Array.isArray(raw.byTask) ? raw.byTask : []).map((t) => {
      const x = isRec(t) ? t : {};
      return { task: typeof x.task === "string" ? x.task : "OTHER", requests: int(x.requests), tokens: int(x.tokens) };
    }),
    note: typeof raw.note === "string" && raw.note ? raw.note : DEFAULT_USAGE_NOTE,
  };
}

/** A limit of 0 means unlimited: the bar stays empty and the label says so. */
export function usageBar(used: number, limit: number, { t, format }: I18n = EN): { pct: number; unlimited: boolean; label: string; nearLimit: boolean } {
  if (limit <= 0) return { pct: 0, unlimited: true, label: t("{used} used · no limit", { used: format.number(used) }), nearLimit: false };
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return { pct, unlimited: false, label: `${format.number(used)} / ${format.number(limit)}`, nearLimit: pct >= 90 };
}

export const TASK_LABEL_USAGE: Record<string, string> = {
  CHAT: msg("Conversation"), EMBEDDING: msg("Document search"), MCQ: msg("MCQ generation"), CQ: msg("CQ generation"), ANALYSIS: msg("AI feedback and plans"), DEFAULT: msg("Other"),
};
export const taskLabel = (t: string): string => TASK_LABEL_USAGE[t] ?? t.toLowerCase().replace(/_/g, " ");
