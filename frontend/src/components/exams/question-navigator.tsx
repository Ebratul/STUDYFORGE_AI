"use client";

import { Bookmark } from "lucide-react";
import { navState, type AttemptQuestion, type LocalAnswer, type NavState } from "@/lib/exams";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const STYLE: Record<NavState, string> = {
  current: "border-primary bg-primary text-primary-foreground",
  answered: "border-success/50 bg-success-soft text-success",
  "answered-marked": "border-success/50 bg-success-soft text-success",
  marked: "border-warning/60 bg-warning-soft text-foreground",
  unanswered: "bg-background text-muted-foreground",
};
const LABEL: Record<NavState, string> = { current: msg("current"), answered: msg("answered"), "answered-marked": msg("answered, marked for review"), marked: msg("marked for review"), unanswered: msg("not answered") };

/** Question grid. State is conveyed by text (aria-label) and an icon for "marked", never by colour alone. */
export function QuestionNavigator({ questions, answers, index, onGo }: { questions: AttemptQuestion[]; answers: Map<string, LocalAnswer>; index: number; onGo: (i: number) => void }) {
  const { t, format } = useI18n();
  return (
    <nav aria-label={t("Question navigator")}>
      <ul className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 lg:grid-cols-5">
        {questions.map((q, i) => {
          const a = answers.get(q.id);
          const st = navState(a, i === index);
          const base = navState(a, false);
          return (
            <li key={q.id}>
              <button
                type="button"
                onClick={() => onGo(i)}
                aria-label={`${t("Question {n}", { n: format.number(i + 1) })}, ${t(LABEL[base])}${i === index ? `, ${t("current")}` : ""}`}
                aria-current={i === index ? "true" : undefined}
                data-state={base}
                className={cn("relative flex h-10 w-full items-center justify-center rounded-lg border text-sm font-semibold outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none", STYLE[st])}
              >
                {format.number(i + 1)}
                {(base === "marked" || base === "answered-marked") && <Bookmark className="absolute -right-1 -top-1 size-3.5 fill-warning text-warning" aria-hidden />}
                {base.startsWith("answered") && i !== index && <span className="absolute bottom-0.5 left-1/2 h-0.5 w-3 -translate-x-1/2 rounded bg-success" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t("Legend")}>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded border border-success/50 bg-success-soft" aria-hidden /> {t("Answered")}</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded border bg-background" aria-hidden /> {t("Not answered")}</li>
        <li className="flex items-center gap-1.5"><Bookmark className="size-3 fill-warning text-warning" aria-hidden /> {t("Marked")}</li>
      </ul>
    </nav>
  );
}
