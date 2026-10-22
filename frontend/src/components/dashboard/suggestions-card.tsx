"use client";

import Link from "next/link";
import { ArrowRight, BookOpenCheck, ClipboardList, FileText, GitCompare, ListChecks, MessageCircleQuestion, PenLine } from "lucide-react";
import { DATA_LEVEL_TEXT, STEP_LABEL, topicIsWeak, type AnalyticsMe, type Suggestion } from "@/lib/analytics";
import { useFormat, useT } from "@/lib/i18n/client";

const ICON: Record<string, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  REVIEW_NOTES: BookOpenCheck, REVISIT_QUESTIONS: ClipboardList, PRACTICE_MCQ: ListChecks, PRACTICE_CQ: PenLine, COMPARE_ATTEMPTS: GitCompare, ASK_ASSISTANT: MessageCircleQuestion, READ_DOCUMENT: FileText,
};

/** Deterministic suggestions from the server (weak topics and data level). They are shown as "initial" unless the server says history exists. */
export function Suggestions({ a }: { a: AnalyticsMe }) {
  const t = useT();
  const format = useFormat();
  const weak = a.topics.filter(topicIsWeak);
  const unknown = a.topics.filter((tp) => !tp.sufficient);
  const level = DATA_LEVEL_TEXT[a.dataLevel];
  return (
    <div className="space-y-4" data-testid="suggestions">
      <p className="rounded-lg bg-accent/50 px-3 py-2 text-xs text-muted-foreground" data-level={a.dataLevel}><span className="font-semibold text-foreground">{a.dataLevel === "BASED_ON_HISTORY" ? t("Based on your history") : t("Initial suggestions")}.</span> {t(level.hint)}</p>
      {weak.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-sm font-semibold">{t("Topics to work on")}</h3>
          <ul className="flex flex-wrap gap-2" aria-label={t("Weak topics")}>
            {weak.map((tp) => <li key={tp.topic} className="rounded-full border border-destructive/30 bg-destructive/5 px-3 py-1 text-xs">{tp.topic} <span className="tabular-nums text-muted-foreground">· {format.percentBp(tp.accuracyBp)}</span></li>)}
          </ul>
        </div>
      )}
      {weak.length === 0 && a.topics.length > 0 && <p className="text-sm text-muted-foreground">{unknown.length > 0 ? t("No topic is clearly weak yet; {count, plural, one {# topic has} other {# topics have}} too few answers to judge.", { count: unknown.length }) : t("No topic is clearly weak yet.")}</p>}
      {a.suggestions.length > 0 ? (
        <ul className="grid gap-2" aria-label={t("Suggested practice")}>
          {a.suggestions.map((s: Suggestion, i) => {
            const Icon = ICON[s.type] ?? ArrowRight;
            return (
              <li key={`${s.type}-${s.topic}-${i}`}>
                <Link href={s.href} className="flex h-full items-start gap-3 rounded-xl border bg-background p-3 text-sm transition hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Icon className="size-4" aria-hidden /></span>
                  <span className="min-w-0"><span className="block font-medium">{s.label}</span><span className="block text-xs text-muted-foreground">{STEP_LABEL[s.type] ? `${t(STEP_LABEL[s.type]!)} — ` : ""}{s.reason}</span></span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : <p className="text-sm text-muted-foreground">{t("Suggestions appear once your results show where practice would help.")}</p>}
      <Link href="/study-plan" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">{t("Open your study plan")} <ArrowRight className="size-3.5" aria-hidden /></Link>
    </div>
  );
}
