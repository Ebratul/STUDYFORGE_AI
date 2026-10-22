import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DIFFICULTY_LABEL, isInsufficient, optionLabel, partLabel, type AnswerObj, type QuestionContent } from "@/lib/questions";
import { cn } from "@/lib/utils";
import { BasisBadge, EvidenceList, LevelBadge } from "./question-badges";

export function MetaChips({ q }: { q: QuestionContent }) {
  return (
    <ul className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Question details">
      <li><Badge variant="secondary" className="rounded-full">{q.kind}</Badge></li>
      <li><Badge variant="outline" className="rounded-full">{DIFFICULTY_LABEL[q.difficulty]}</Badge></li>
      {q.subject && <li><Badge variant="outline" className="rounded-full">{q.subject}</Badge></li>}
      {q.topic && <li><Badge variant="outline" className="rounded-full">{q.topic}</Badge></li>}
      <li className="text-muted-foreground">{q.marks} {q.marks === 1 ? "mark" : "marks"}{q.kind === "MCQ" && q.negativeMarks > 0 ? ` · −${q.negativeMarks} if wrong` : ""}</li>
      {q.tags.map((t) => <li key={t}><Badge variant="outline" className="rounded-full font-normal text-muted-foreground">#{t}</Badge></li>)}
    </ul>
  );
}

function AnswerBlock({ answer, language }: { answer: AnswerObj | null; language: QuestionContent["language"] }) {
  if (!answer) return null;
  return (
    <div className="mt-2 rounded-lg border bg-muted/30 p-2.5 text-sm" lang={language}>
      <div className="mb-1 flex flex-wrap items-center gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Model answer</span><BasisBadge answer={answer} /></div>
      {isInsufficient(answer) ? (
        <p className="italic text-foreground/80">Your sources don&apos;t contain enough to answer this part. No answer was written.</p>
      ) : (
        <p className="whitespace-pre-wrap">{answer.text}</p>
      )}
      <EvidenceList sources={answer.sources} label="Quotes behind this answer" />
    </div>
  );
}

export function QuestionBody({ q, showAnswers = true }: { q: QuestionContent; showAnswers?: boolean }) {
  if (q.kind === "MCQ") {
    return (
      <div className="space-y-3" lang={q.language}>
        <p className="whitespace-pre-wrap text-base font-medium leading-snug">{q.stem}</p>
        <ol className="space-y-1.5" aria-label="Options">
          {q.options.map((o, i) => {
            const correct = showAnswers && o.id === q.correctOptionId;
            return (
              <li key={o.id} className={cn("flex items-start gap-2.5 rounded-xl border px-3 py-2 text-sm", correct && "border-success/50 bg-success-soft")}>
                <span className={cn("mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-semibold", correct && "border-success bg-success text-success-foreground")} aria-hidden>{optionLabel(i, q.language)}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{o.text}</span>
                {correct && <><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /><span className="sr-only">Correct answer</span></>}
              </li>
            );
          })}
        </ol>
        {showAnswers && q.explanation && <p className="text-sm"><span className="font-semibold">Explanation: </span>{q.explanation}</p>}
        {showAnswers && q.shortNote && <p className="rounded-lg bg-accent/60 px-3 py-2 text-sm"><span className="font-semibold">Short note: </span>{q.shortNote}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-3" lang={q.language}>
      {q.stimulus && (
        <div className="rounded-xl border-l-4 border-primary/50 bg-accent/40 p-3 text-sm">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Stimulus</p>
          <p className="whitespace-pre-wrap">{q.stimulus}</p>
        </div>
      )}
      <p className="whitespace-pre-wrap text-base font-medium leading-snug">{q.stem}</p>
      {q.parts.length > 0 && (
        <ol className="space-y-3" aria-label="Parts">
          {q.parts.map((p, i) => (
            <li key={p.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-start gap-2">
                <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md border text-xs font-semibold" aria-hidden>{p.label ?? partLabel(i, q.language)}</span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm font-medium">{p.prompt}</p>
                <span className="text-xs text-muted-foreground">{p.marks} {p.marks === 1 ? "mark" : "marks"}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5 pl-8"><LevelBadge level={p.level} language={q.language} /></div>
              {showAnswers && <div className="pl-8"><AnswerBlock answer={p.answer} language={q.language} /></div>}
            </li>
          ))}
        </ol>
      )}
      {showAnswers && q.parts.length === 0 && <AnswerBlock answer={q.answer} language={q.language} />}
    </div>
  );
}
