"use client";

import { topicChartData, type TopicStat } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useFormat, useT } from "@/lib/i18n/client";

/**
 * Topic accuracy, weakest first. Bars are plain HTML (so the values are real text), and the state is also spelled out in words:
 * topics with too few answers are shown neutrally as "Not enough data" and never coloured or labelled as weak.
 */
export function TopicBars({ topics }: { topics: TopicStat[] }) {
  const t = useT();
  const format = useFormat();
  const data = topicChartData(topics);
  return (
    <ul className="space-y-3" aria-label={t("Accuracy by topic, weakest first")} data-testid="topic-bars">
      {data.map((d) => {
        const state = !d.sufficient ? "unknown" : d.pct < 70 ? "weak" : d.pct >= 85 ? "strong" : "ok";
        return (
          <li key={d.name} data-state={state}>
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="min-w-0 truncate font-medium" title={d.name}>{d.name}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="tabular-nums text-foreground">{format.percentBp(Math.round(d.pct * 100))}</span> · {t("{correct} of {answered} correct", { correct: d.correct, answered: d.answered })}
                {state === "unknown" && <span className="rounded-full border border-dashed px-2 py-0.5">{t("Not enough data")}</span>}
                {state === "weak" && <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-destructive">{t("Needs work")}</span>}
                {state === "strong" && <span className="rounded-full border border-success/40 bg-success-soft px-2 py-0.5 text-success">{t("Strong")}</span>}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className={cn("h-full rounded-full", state === "weak" ? "bg-destructive/70" : state === "unknown" ? "bg-muted-foreground/40" : state === "strong" ? "bg-success" : "bg-primary")} style={{ width: `${Math.max(2, Math.min(100, d.pct))}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
