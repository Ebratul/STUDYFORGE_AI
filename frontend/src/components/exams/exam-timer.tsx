"use client";

import { Clock } from "lucide-react";
import { formatClock, timerTone } from "@/lib/exams";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

/**
 * Circular countdown. It only DISPLAYS the value handed to it (derived from the server's remainingMs + monotonic time);
 * it has no clock of its own. The ring is decorative; the numbers carry the meaning.
 */
export function ExamTimer({ remainingMs, totalMs, className }: { remainingMs: number; totalMs: number; className?: string }) {
  const t = useT();
  const tone = timerTone(remainingMs);
  const r = 26;
  const c = 2 * Math.PI * r;
  const frac = totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="relative size-16 shrink-0" aria-hidden>
        <svg viewBox="0 0 64 64" className="size-16 -rotate-90">
          <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-muted" />
          <circle
            cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)}
            className={cn("transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none", tone === "danger" ? "stroke-destructive" : tone === "warning" ? "stroke-warning" : "stroke-primary")}
          />
        </svg>
        <Clock className={cn("absolute inset-0 m-auto size-5", tone === "danger" ? "text-destructive" : "text-muted-foreground")} />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{t("Time left")}</p>
        <p
          role="timer"
          aria-live="off"
          aria-label={t("Time left: {time}", { time: formatClock(remainingMs) })}
          data-testid="exam-timer"
          className={cn("font-mono text-2xl font-semibold tabular-nums leading-none", tone === "danger" && "text-destructive", tone === "warning" && "text-amber-700 dark:text-amber-300")}
        >
          {formatClock(remainingMs)}
        </p>
      </div>
    </div>
  );
}
