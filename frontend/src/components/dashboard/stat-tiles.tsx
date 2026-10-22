"use client";

import { Award, CheckCircle2, GraduationCap, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { answeredTotal, formatAccuracy, type AnalyticsMe } from "@/lib/analytics";
import { useI18n, useT } from "@/lib/i18n/client";

/** One headline figure. `value === null` is "No data yet" (dashed, muted) and is deliberately different from a real 0. */
export function StatTile({ label, value, hint, icon: Icon, testId }: { label: string; value: string | null; hint?: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>; testId?: string }) {
  const t = useT();
  const empty = value === null;
  return (
    <div className={cn("flex items-start justify-between gap-3 rounded-2xl border bg-card p-5 shadow-card", empty && "border-dashed bg-card/60 shadow-none")} data-state={empty ? "empty" : "value"} data-testid={testId}>
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        {empty ? <p className="mt-2 text-base font-medium text-muted-foreground">{t("No data yet")}</p> : <p className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>}
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <span className={cn("inline-flex size-11 shrink-0 items-center justify-center rounded-2xl", empty ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground")}><Icon className="size-5" aria-hidden /></span>
    </div>
  );
}

export function StatTiles({ a }: { a: AnalyticsMe }) {
  const i18n = useI18n();
  const { t, format } = i18n;
  const tot = a.totals;
  const none = tot.completed === 0;
  const answered = answeredTotal(tot);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="exam-performance">
      <StatTile label={t("Exams completed")} value={format.number(tot.completed)} hint={none ? t("Finish an exam to start your history") : t("Results released to you")} icon={GraduationCap} testId="stat-completed" />
      <StatTile label={t("Average score")} value={tot.average === null ? null : formatAccuracy(tot.average, undefined, i18n)} hint={tot.average === null ? undefined : t("Lowest {score}", { score: formatAccuracy(tot.lowest, undefined, i18n) })} icon={Target} testId="stat-average" />
      <StatTile label={t("Highest score")} value={tot.highest === null ? null : formatAccuracy(tot.highest, undefined, i18n)} icon={Award} testId="stat-highest" />
      <StatTile label={t("Correct answers")} value={none ? null : format.number(tot.correct)} hint={none ? undefined : t("{incorrect} incorrect · {unanswered} unanswered · {answered} questions", { incorrect: tot.incorrect, unanswered: tot.unanswered, answered })} icon={CheckCircle2} testId="stat-correct" />
    </div>
  );
}
