"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Bot, Clock, GraduationCap, Info, Loader2, NotebookPen, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RevisionPlanButton } from "@/components/analysis/assistant-actions";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { describeAnalysisRequestError, describeFailure, isPending, pollDelay, readPlanData, readPlanView, stepHref, type PlanData, type PlanView } from "@/lib/analysis";
import { DATA_LEVEL_TEXT, STEP_LABEL } from "@/lib/analytics";
import { useFormat, useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const ONE_EXAM = msg("One exam is a snapshot, not proof of mastery. Use these as starting points and check them against your next results.");

function NameList({ title, names, tone, testId }: { title: string; names: string[]; tone: string; testId: string }) {
  const t = useT();
  return (
    <div data-testid={testId}>
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      {names.length === 0 ? <p className="text-sm text-muted-foreground">{t("None yet.")}</p> : <ul className="flex flex-wrap gap-2">{names.map((n) => <li key={n} className={`rounded-full border px-3 py-1 text-xs ${tone}`}>{n}</li>)}</ul>}
    </div>
  );
}

export function PlanCardBody({ plan, busy, onGenerate }: { plan: PlanView | null; busy: boolean; onGenerate: () => void }) {
  const t = useT();
  const format = useFormat();
  if (!plan || plan.status === "NONE") {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="plan-none">
        <p className="min-w-0 flex-1 text-muted-foreground">{t("Ask the AI to turn your verified results into a short, practical plan. It only uses the topics and counts shown above.")}</p>
        <Button className="rounded-xl" onClick={onGenerate} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />} {t("Write my plan")}</Button>
      </div>
    );
  }
  if (plan.status === "PENDING") {
    return <div className="flex items-start gap-3 text-sm" role="status" aria-live="polite" data-testid="plan-pending"><Loader2 className="mt-0.5 size-4 animate-spin text-primary" aria-hidden /><p className="text-muted-foreground">{t("Your plan is being written. This page updates by itself.")}</p></div>;
  }
  if (plan.status === "NOT_CONFIGURED") {
    return (
      <div className="space-y-2 text-sm" data-testid="plan-not-configured">
        <p className="text-muted-foreground">{t("The AI plan needs a model. Add your API key and choose a model first.")}</p>
        <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline" className="rounded-lg"><Link href="/settings/api-keys">{t("API keys")}</Link></Button><Button asChild size="sm" variant="outline" className="rounded-lg"><Link href="/settings/providers">{t("AI providers")}</Link></Button><Button size="sm" className="rounded-lg" onClick={onGenerate} disabled={busy}>{t("Try again")}</Button></div>
      </div>
    );
  }
  if (plan.status === "FAILED" || !plan.content) {
    return (
      <Alert className="border-warning/40 bg-warning-soft" data-testid="plan-failed">
        <AlertTriangle aria-hidden /><AlertTitle>{t("The AI plan isn't available right now")}</AlertTitle>
        <AlertDescription className="space-y-2"><p>{describeFailure(plan.errorCode, t)} {t("The suggestions above come straight from your results and are still available.")}</p>
          <Button size="sm" variant="outline" className="rounded-lg" onClick={onGenerate} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("Retry")}</Button></AlertDescription>
      </Alert>
    );
  }
  const c = plan.content;
  return (
    <div className="space-y-4" data-testid="plan-ready">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="rounded-full" data-testid="plan-label">{plan.label === "BASED_ON_HISTORY" ? t("Based on your history") : t("Initial suggestions")}</Badge>
        <span className="text-xs text-muted-foreground">{t("{results, plural, one {# result} other {# results}} · {topics, plural, one {# topic} other {# topics}} · {answered} questions answered", { results: plan.basis.results, topics: plan.basis.topics, answered: plan.basis.answered })}{plan.generatedAt ? ` · ${t("written {when}", { when: format.dateTime(plan.generatedAt) })}` : ""}</span>
      </div>
      {plan.stale && (
        <Alert data-testid="plan-stale"><Info aria-hidden /><AlertTitle>{t("Your results have changed since this plan was written")}</AlertTitle>
          <AlertDescription className="space-y-2"><p>{t("The plan below reflects older data.")}</p><Button size="sm" variant="outline" className="rounded-lg" onClick={onGenerate} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("Update my plan")}</Button></AlertDescription></Alert>
      )}
      {c.headline && <p className="text-base font-semibold">{c.headline}</p>}
      {c.focus.length > 0 && (
        <section aria-labelledby="plan-focus"><h3 id="plan-focus" className="mb-1.5 text-sm font-semibold">{t("Where to focus")}</h3>
          <ul className="space-y-1.5 text-sm">{c.focus.map((f) => <li key={f.topic} className="rounded-lg border bg-background px-3 py-2"><span className="font-medium">{f.topic}</span><span className="text-muted-foreground"> — {f.reason}</span></li>)}</ul></section>
      )}
      {c.steps.length > 0 && (
        <section aria-labelledby="plan-steps"><h3 id="plan-steps" className="mb-1.5 text-sm font-semibold">{t("Steps")}</h3>
          <ol className="space-y-2 text-sm">
            {c.steps.map((s, i) => {
              const href = stepHref(s);
              return (
                <li key={i} className="flex items-start gap-3 rounded-lg border bg-background px-3 py-2.5">
                  <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground" aria-hidden>{i + 1}</span>
                  <span className="min-w-0 flex-1"><span className="block text-xs font-medium text-muted-foreground">{t(STEP_LABEL[s.type] ?? "Step")}{s.topic ? ` · ${s.topic}` : ""}{s.minutes ? <span className="ml-2 inline-flex items-center gap-0.5"><Clock className="size-3" aria-hidden /> {t("about {minutes} min", { minutes: s.minutes })}</span> : null}</span>
                    <span className="block">{s.text}</span>
                    {href && <Link href={href} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">{t("Open")} <ArrowRight className="size-3" aria-hidden /></Link>}</span>
                </li>
              );
            })}
          </ol></section>
      )}
      {c.caveats.length > 0 && <p className="rounded-lg bg-accent/50 px-3 py-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">{t("Keep in mind:")} </span>{c.caveats.map((cv) => t(cv)).join(" ")}</p>}
      <div className="flex justify-end"><Button size="sm" variant="ghost" className="h-7 rounded-md px-2 text-[11px]" onClick={onGenerate} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("Write it again")}</Button></div>
    </div>
  );
}

export function StudyPlanView() {
  const t = useT();
  const qc = useQueryClient();
  const key = ["study-plan"];
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: key,
    queryFn: async () => readPlanData(await apiGet("/api/analysis/plan")),
    retry: 1,
    refetchInterval: (query) => (isPending(query.state.data?.plan?.status) ? pollDelay(query.state.dataUpdateCount) ?? false : false),
  });

  async function generate() {
    setBusy(true);
    try {
      const raw = await apiSend<{ plan?: unknown }>("POST", "/api/analysis/plan", {});
      const plan = readPlanView(raw?.plan ?? raw);
      qc.setQueryData<PlanData>(key, (cur) => (cur ? { ...cur, plan } : cur));
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(describeAnalysisRequestError(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (q.isLoading) return <div className="space-y-4" role="status" aria-label={t("Loading your study plan")}><Skeleton className="h-24 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;
  if (q.isError || !q.data) {
    return (
      <Card className="rounded-2xl border-destructive/30" role="alert"><CardContent className="flex flex-wrap items-center gap-3 py-6">
        <p className="min-w-0 flex-1 text-sm"><span className="font-semibold">{t("Couldn't load your study plan.")}</span>{q.error instanceof ApiError ? ` ${q.error.message}` : ""}</p>
        <Button variant="outline" className="rounded-xl" onClick={() => void q.refetch()}>{t("Try again")}</Button></CardContent></Card>
    );
  }
  const d = q.data;
  const level = DATA_LEVEL_TEXT[d.dataLevel];
  if (d.dataLevel === "NONE") {
    return (
      <Card className="rounded-2xl border-dashed shadow-none" data-testid="plan-no-data"><CardContent className="flex flex-wrap items-center gap-4 py-8">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><GraduationCap className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">{t("Your plan starts with your first result")}</h2><p className="text-sm text-muted-foreground">{t("There are no released exam results yet, so there is nothing to base suggestions on.")} {t(level.hint)}</p></div>
        <Button asChild variant="outline" className="rounded-xl"><Link href="/exams">{t("Go to exams")}</Link></Button></CardContent></Card>
    );
  }
  return (
    <div className="space-y-4">
      <Alert data-testid="plan-level" data-level={d.dataLevel}><Info aria-hidden />
        <AlertTitle>{d.dataLevel === "BASED_ON_HISTORY" ? t("Based on your history") : t("Initial suggestions")}</AlertTitle>
        <AlertDescription>{t(level.hint)} {d.dataLevel !== "BASED_ON_HISTORY" ? t(ONE_EXAM) : ""}</AlertDescription></Alert>

      <Card className="rounded-2xl shadow-card"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><NotebookPen className="size-4 text-primary" aria-hidden /> {t("From your results")}</CardTitle><CardDescription>{t("Worked out by the app from your released results — no AI involved.")}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <NameList title={t("Needs work")} names={d.weakTopics} tone="border-destructive/30 bg-destructive/5" testId="plan-weak" />
            <NameList title={t("Going well")} names={d.strongTopics} tone="border-success/40 bg-success-soft/60" testId="plan-strong" />
            <NameList title={t("Not enough data yet")} names={d.notEnoughData} tone="border-dashed text-muted-foreground" testId="plan-unknown" />
          </div>
          {d.actions.length > 0 ? (
            <ul className="grid gap-2 sm:grid-cols-2" aria-label={t("Suggested actions")} data-testid="plan-actions">
              {d.actions.map((a, i) => (
                <li key={`${a.type}-${a.topic}-${i}`}><Link href={a.href} className="flex h-full items-start gap-2 rounded-xl border bg-background p-3 text-sm transition hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-ring"><ArrowRight className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /><span><span className="block font-medium">{a.label}</span><span className="block text-xs text-muted-foreground">{a.reason}</span></span></Link></li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">{t("No specific actions yet — keep practising and check back after your next result.")}</p>}
        </CardContent></Card>

      <Card className="rounded-2xl shadow-card" data-testid="ai-plan-card"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Bot className="size-4 text-primary" aria-hidden /> {t("AI study plan")}</CardTitle><CardDescription>{t("Written from the numbers above. It never changes a score and can be wrong — check it against your own judgement.")}</CardDescription></CardHeader>
        <CardContent><PlanCardBody plan={d.plan} busy={busy} onGenerate={() => void generate()} /></CardContent></Card>

      <div className="flex flex-wrap gap-2"><RevisionPlanButton attemptId={undefined} /></div>
    </div>
  );
}
