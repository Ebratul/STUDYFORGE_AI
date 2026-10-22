"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, ArrowRight, BookOpenCheck, Bot, ClipboardList, FileText, GitCompare, Info, ListChecks, Loader2, MessageCircleQuestion, PenLine, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SafeMarkdown } from "@/components/chat/safe-markdown";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { describeAnalysisRequestError, describeFailure, FAILURE_TEXT, isPending, pollDelay, readAnalysis, stepHref, type AnalysisView } from "@/lib/analysis";
import { DATA_LEVEL_TEXT, STEP_LABEL } from "@/lib/analytics";
import { useT } from "@/lib/i18n/client";

const STEP_ICON: Record<string, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  REVIEW_NOTES: BookOpenCheck, REVISIT_QUESTIONS: ClipboardList, PRACTICE_MCQ: ListChecks, PRACTICE_CQ: PenLine, COMPARE_ATTEMPTS: GitCompare, ASK_ASSISTANT: MessageCircleQuestion, READ_DOCUMENT: FileText,
};

/** Presentational: every status of the AI feedback. The verified score is rendered elsewhere and never depends on this card. */
export function AiFeedbackBody({ view, busy, onRequest, onRegenerate }: { view: AnalysisView; busy: boolean; onRequest: () => void; onRegenerate: () => void }) {
  const t = useT();
  const c = view.content;
  if (view.status === "PENDING") {
    return (
      <div className="flex items-start gap-3 text-sm" role="status" aria-live="polite" data-testid="ai-pending">
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden />
        <p className="text-muted-foreground">{t("Your feedback is being written from your verified results. This page updates by itself — your score above is already final.")}</p>
      </div>
    );
  }
  if (view.status === "NOT_CONFIGURED") {
    return (
      <div className="space-y-2 text-sm" data-testid="ai-not-configured">
        <p className="text-muted-foreground">{t("AI feedback needs a model. Add your API key and choose a model, then ask again.")}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline" className="rounded-lg"><Link href="/settings/api-keys">{t("API keys")}</Link></Button>
          <Button asChild size="sm" variant="outline" className="rounded-lg"><Link href="/settings/providers">{t("AI providers")}</Link></Button>
          <Button size="sm" className="rounded-lg" onClick={onRequest} disabled={busy}>{busy && <Loader2 className="animate-spin" aria-hidden />} {t("Try again")}</Button>
        </div>
      </div>
    );
  }
  if (view.status === "FAILED") {
    return (
      <Alert className="border-warning/40 bg-warning-soft" data-testid="ai-failed">
        <AlertTriangle aria-hidden />
        <AlertTitle>{t("AI feedback isn't available right now")}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{describeFailure(view.errorCode, t)}</p>
          {view.errorCode && FAILURE_TEXT[view.errorCode] && !FAILURE_TEXT[view.errorCode]!.includes("unaffected") && <p className="text-xs text-muted-foreground">{t("Your score is unaffected.")}</p>}
          {view.canRetry && <Button size="sm" variant="outline" className="rounded-lg" onClick={onRequest} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("Retry")}</Button>}
        </AlertDescription>
      </Alert>
    );
  }
  if (view.status === "NONE" || !c) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="ai-none">
        <p className="min-w-[14rem] flex-1 text-muted-foreground">{t("Get a short, supportive write-up of what went well and what to practise next, based only on your results.")}</p>
        <Button size="sm" className="rounded-lg" onClick={onRequest} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />} {t("Get AI feedback")}</Button>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="ai-ready">
      {c.summary && <SafeMarkdown>{c.summary}</SafeMarkdown>}
      {c.strengths.length > 0 && (
        <section aria-labelledby="ai-strengths">
          <h3 id="ai-strengths" className="mb-1.5 text-sm font-semibold">{t("What went well")}</h3>
          <ul className="space-y-1.5 text-sm">{c.strengths.map((s, i) => <li key={i} className="rounded-lg border border-success/30 bg-success-soft/50 px-3 py-2"><span className="font-medium">{s.topic}</span>{s.detail && <span className="text-muted-foreground"> — {s.detail}</span>}</li>)}</ul>
        </section>
      )}
      {c.weaknesses.length > 0 && (
        <section aria-labelledby="ai-weak">
          <h3 id="ai-weak" className="mb-1.5 text-sm font-semibold">{t("Where to focus")}</h3>
          <ul className="space-y-1.5 text-sm">{c.weaknesses.map((w, i) => (
            <li key={i} className="rounded-lg border bg-background px-3 py-2"><span className="font-medium">{w.topic}</span>{w.detail && <span className="text-muted-foreground"> — {w.detail}</span>}{w.evidence && <span className="mt-0.5 block text-xs text-muted-foreground">{t("From your results: {evidence}", { evidence: w.evidence })}</span>}</li>
          ))}</ul>
        </section>
      )}
      {c.nextSteps.length > 0 && (
        <section aria-labelledby="ai-steps">
          <h3 id="ai-steps" className="mb-1.5 text-sm font-semibold">{t("Next steps")}</h3>
          <ol className="space-y-2 text-sm">
            {c.nextSteps.map((s, i) => {
              const Icon = STEP_ICON[s.type] ?? ArrowRight;
              const href = stepHref(s);
              return (
                <li key={i} className="flex items-start gap-3 rounded-lg border bg-background px-3 py-2.5">
                  <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground"><Icon className="size-4" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    {STEP_LABEL[s.type] && <span className="block text-xs font-medium text-muted-foreground">{t(STEP_LABEL[s.type]!)}{s.topic ? ` · ${s.topic}` : ""}</span>}
                    <span className="block">{s.text}</span>
                    {href && <Link href={href} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">{t("Open")} <ArrowRight className="size-3" aria-hidden /></Link>}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {c.caveats.length > 0 && (
        <div className="rounded-lg bg-accent/50 px-3 py-2 text-xs text-muted-foreground" data-testid="ai-caveats"><Info className="mr-1 inline size-3.5 align-text-bottom" aria-hidden /><span className="font-medium text-foreground">{t("Keep in mind:")} </span>{c.caveats.map((cv) => t(cv)).join(" ")}</div>
      )}
      <p className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span data-testid="ai-disclaimer">{t(view.disclaimer)}{view.dataLevel !== "NONE" && ` ${t(DATA_LEVEL_TEXT[view.dataLevel].label)}.`}</span>
        <Button size="sm" variant="ghost" className="h-7 rounded-md px-2 text-[11px]" onClick={onRegenerate} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("Write it again")}</Button>
      </p>
    </div>
  );
}

/** AI feedback for one released result (docs/PART5_SPEC.md §3). Polls with backoff while PENDING; never blocks the score. */
export function AiFeedbackCard({ attemptId }: { attemptId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const key = ["analysis", attemptId];
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: key,
    queryFn: async () => readAnalysis(await apiGet(`/api/analysis/attempts/${attemptId}`)),
    retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 409)) && count < 1,
    refetchInterval: (query) => (isPending(query.state.data?.status) ? pollDelay(query.state.dataUpdateCount) ?? false : false),
  });

  async function request(regenerate: boolean) {
    setBusy(true);
    try {
      qc.setQueryData(key, readAnalysis(await apiSend("POST", `/api/analysis/attempts/${attemptId}`, regenerate ? { regenerate: true } : {})));
    } catch (err) {
      toast.error(describeAnalysisRequestError(err, t));
    } finally {
      setBusy(false);
    }
  }

  // Not released (409) or unknown (404): nothing to show here; the result page already explains release.
  if (q.isError && q.error instanceof ApiError && (q.error.status === 409 || q.error.status === 404)) return null;
  return (
    <section aria-labelledby="ai-fb-h" className="rounded-2xl border bg-card p-5 shadow-card" data-testid="ai-feedback">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-accent text-accent-foreground"><Bot className="size-4" aria-hidden /></span>
        <div><h2 id="ai-fb-h" className="text-sm font-semibold">{t("AI feedback")}</h2><p className="text-xs text-muted-foreground">{t("Written from your verified results. It never changes your score.")}</p></div>
      </div>
      {q.isLoading && <div className="space-y-2" role="status" aria-label={t("Loading AI feedback")}><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-3/5" /></div>}
      {q.isError && !q.isLoading && (
        <p className="text-sm text-muted-foreground" role="alert">{t("Couldn't load AI feedback right now. Your score and the standard feedback above are unaffected.")} <button className="font-medium text-primary underline" onClick={() => void q.refetch()}>{t("Try again")}</button></p>
      )}
      {q.data && <AiFeedbackBody view={q.data} busy={busy} onRequest={() => void request(false)} onRegenerate={() => void request(true)} />}
    </section>
  );
}
