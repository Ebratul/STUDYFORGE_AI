"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Info, Loader2, Lock, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiGet } from "@/lib/api";
import { factsFromDraft, formatMarks, optionLetter, rulesInWords, stepForField, type ExamDraftInput, type ExamPreview, type PreviewIssue } from "@/lib/exams";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/client";

type Step = "details" | "questions" | "rules";

export function PreviewStep({ examId, draft, ready, flush, onPublish, publishing, publishFields, publishError, goto }: {
  examId: string; draft: ExamDraftInput; ready: boolean; flush: () => Promise<boolean>; onPublish: () => void; publishing: boolean;
  publishFields: Record<string, string>; publishError: string | null; goto: (s: Step) => void;
}) {
  const i18n = useI18n();
  const { t, format } = i18n;
  const [saved, setSaved] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  // Make sure the server has the latest draft before it validates it.
  useEffect(() => {
    let alive = true;
    void flush().then((ok) => { if (alive) setSaved(ok); });
    return () => { alive = false; };
  }, [flush, ready]);

  const preview = useQuery({
    queryKey: ["exam-preview", examId, saved, JSON.stringify(draft)],
    enabled: saved === true,
    retry: false,
    queryFn: async () => { const r = await apiGet<{ preview: ExamPreview } | ExamPreview>(`/api/exams/${examId}/preview`); return "preview" in r ? r.preview : r; },
    staleTime: 0,
  });

  if (saved === null || preview.isLoading) return <p role="status" className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground shadow-card"><Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden /> {t("Checking your exam…")}</p>;
  if (saved === false) {
    return (
      <Alert variant="destructive" role="alert"><XCircle aria-hidden /><AlertTitle>{t("The draft couldn't be saved")}</AlertTitle>
        <AlertDescription>{t("Go back and fix the highlighted fields, then return here to preview.")}<div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => goto("rules")}>{t("Rules")}</Button><Button size="sm" variant="outline" onClick={() => goto("questions")}>{t("Questions")}</Button></div></AlertDescription>
      </Alert>
    );
  }
  if (preview.isError || !preview.data) return <Alert variant="destructive" role="alert"><AlertTitle>{t("Couldn't build the preview")}</AlertTitle><AlertDescription>{t("Please try again in a moment.")}</AlertDescription></Alert>;

  const p = preview.data;
  const issues: PreviewIssue[] = [
    ...p.issues,
    ...Object.entries(publishFields).filter(([path]) => !p.issues.some((i) => i.path === path)).map(([path, message]): PreviewIssue => ({ path, message, severity: "error" })),
  ];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const facts = factsFromDraft(draft, { questionCount: p.totals.questionCount, totalMarks: p.totals.totalMarks });

  return (
    <div className="space-y-5">
      {errors.length > 0 && (
        <Alert variant="destructive" role="alert" data-testid="preview-errors"><XCircle aria-hidden /><AlertTitle>{t("Fix these before publishing")}</AlertTitle>
          <AlertDescription><ul className="mt-1 space-y-1">{errors.map((i, n) => (
            <li key={n} className="flex flex-wrap items-center gap-2"><span>{t(i.message)}</span><Button size="xs" variant="outline" className="h-6" onClick={() => goto(stepForField(i.path))}>{t("Fix")}</Button></li>
          ))}</ul></AlertDescription>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert className="border-warning/50 bg-warning-soft" data-testid="preview-warnings"><AlertTriangle className="text-amber-700" aria-hidden /><AlertTitle>{t("Worth a look")}</AlertTitle>
          <AlertDescription><ul className="mt-1 list-disc space-y-1 pl-4">{warnings.map((i, n) => <li key={n}>{t(i.message)}</li>)}</ul></AlertDescription>
        </Alert>
      )}
      {errors.length === 0 && <Alert className="border-success/40 bg-success-soft"><CheckCircle2 className="text-success" aria-hidden /><AlertTitle>{t("Ready to publish")}</AlertTitle><AlertDescription>{t("The checks passed. Review the exam below, then publish.")}</AlertDescription></Alert>}
      {publishError && <Alert variant="destructive" role="alert"><AlertDescription>{publishError}</AlertDescription></Alert>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="pv-q" className="min-w-0 rounded-2xl border bg-card p-4 shadow-card sm:p-5">
          <h3 id="pv-q" className="text-base font-semibold">{t("Questions and answer key")} <span className="text-sm font-normal text-muted-foreground">{t("(only you can see the key)")}</span></h3>
          <ol className="mt-3 space-y-3" data-testid="preview-questions">
            {p.questions.map((q) => (
              <li key={q.position} className="rounded-xl border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium"><span className="mr-1.5 text-muted-foreground">{format.number(q.position)}.</span>{q.stem}</p>
                  <Badge variant="secondary" className="shrink-0 rounded-full text-[10px] font-normal">{t("{count, plural, one {# mark} other {# marks}}", { count: q.marks, text: formatMarks(q.marks, i18n) })}</Badge>
                </div>
                <ul className="mt-2 space-y-1">
                  {q.options.map((o, i) => {
                    const correct = o.id === q.correctOptionId;
                    return (
                      <li key={o.id} className={cn("flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-sm", correct && "border-success/50 bg-success-soft")}>
                        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-bold" aria-hidden>{optionLetter(i)}</span>
                        <span className="min-w-0 flex-1 break-words"><span className="sr-only">{t("Option {letter}", { letter: optionLetter(i) })}: </span>{o.text}</span>
                        {correct && <span className="shrink-0 text-[11px] font-semibold text-success">{t("Correct")}</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        </section>

        <aside className="space-y-4">
          <section aria-labelledby="pv-t" className="rounded-2xl border bg-card p-4 shadow-card">
            <h3 id="pv-t" className="text-base font-semibold">{draft.title || t("Untitled exam")}</h3>
            <dl className="mt-3 grid grid-cols-2 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">{t("Questions")}</dt><dd className="text-right font-medium" data-testid="pv-count">{format.number(p.totals.questionCount)}</dd>
              <dt className="text-muted-foreground">{t("Total marks")}</dt><dd className="text-right font-medium" data-testid="pv-marks">{formatMarks(p.totals.totalMarks, i18n)}</dd>
            </dl>
          </section>
          <section aria-labelledby="pv-r" className="rounded-2xl border bg-card p-4 shadow-card">
            <h3 id="pv-r" className="text-sm font-semibold">{t("The rules, in words")}</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">{rulesInWords(facts, i18n).map((line, i) => <li key={i}>{line}</li>)}</ul>
          </section>
          <Button className="h-11 w-full rounded-xl" disabled={errors.length > 0 || publishing} onClick={() => setConfirm(true)} data-testid="publish-button"><Lock aria-hidden /> {t("Publish exam")}</Button>
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t("Publishing takes a frozen copy of the questions, answers and rules.")}</p>
        </aside>
      </div>

      <Dialog open={confirm} onOpenChange={(o) => { if (!publishing) setConfirm(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Publish this exam?")}</DialogTitle>
            <DialogDescription>{t("A published exam is frozen: its questions, answer key, marks and rules can't be edited, and later changes to your question bank won't affect it. To change something you'd duplicate it into a new draft.")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={publishing}>{t("Not yet")}</Button>
            <Button onClick={() => { onPublish(); setConfirm(false); }} disabled={publishing} data-testid="confirm-publish">{publishing ? <><Loader2 className="animate-spin" aria-hidden /> {t("Publishing…")}</> : t("Publish")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
