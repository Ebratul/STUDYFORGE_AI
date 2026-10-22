"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { BookOpenCheck, CheckCircle2, CircleHelp, Hourglass, Loader2, RotateCcw, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, apiSend } from "@/lib/api";
import {
  BAND_INFO, BAND_ORDER, describeExamError, feedbackText, formatCenti, formatDateTime, formatPercentBp, optionLetter, RELEASE_TEXT,
  type FeedbackBand, type Outcome, type ResultReview, type ResultView as ResultData,
} from "@/lib/exams";
import { BAND_TONE_CLASS } from "@/lib/bands";
import { AiFeedbackCard } from "@/components/analysis/ai-feedback-card";
import { ExplainButton, RevisionPlanButton } from "@/components/analysis/assistant-actions";
import { cn } from "@/lib/utils";
import { useI18n, useRich } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const TONE = BAND_TONE_CLASS;

export function ResultView({ result, attemptId, examId, examTitle, attemptNo }: { result: ResultData; attemptId: string; examId: string | null; examTitle: string | null; attemptNo: number | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  const title = examTitle ?? result.exam?.title ?? t("Exam result");
  const timedOut = result.status === "TIMED_OUT";
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("Result")}{attemptNo ? ` · ${t("attempt {n}", { n: attemptNo })}` : ""}</p>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="result-title">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {timedOut ? t("Submitted automatically when time ran out") : t("Submitted")} {formatDateTime(result.finalizedAt ?? result.submittedAt, i18n)}
        </p>
      </header>

      {timedOut && (
        <Alert className="border-warning/50 bg-warning-soft">
          <Hourglass className="text-amber-700" aria-hidden />
          <AlertTitle>{t("Time ran out")}</AlertTitle>
          <AlertDescription>{t("Your attempt was finalized at the deadline using the answers the server had saved by then.")}</AlertDescription>
        </Alert>
      )}

      {!result.release.released || !result.score ? (
        <NotReleased result={result} />
      ) : (
        <>
          <ScoreCard result={result} />
          <BandGuide current={result.score.band} />
          <AiFeedbackCard attemptId={attemptId} />
          {result.topics && result.topics.length > 0 && <TopicPerformance topics={result.topics} />}
          <Review result={result} attemptId={attemptId} />
          <Actions result={result} attemptId={attemptId} examId={examId} />
        </>
      )}
      {(!result.release.released || !result.score) && examId && (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline"><Link href={`/exams/${examId}`}>{t("Back to the exam")}</Link></Button>
          <Button asChild variant="ghost"><Link href="/exams">{t("All exams")}</Link></Button>
        </div>
      )}
    </div>
  );
}

function NotReleased({ result }: { result: ResultData }) {
  const i18n = useI18n();
  const { t } = i18n;
  const rich = useRich();
  const r = result.release;
  return (
    <section className="rounded-2xl border bg-card p-6 text-center shadow-card sm:p-8" data-testid="not-released" aria-labelledby="nr-h">
      <span className="mx-auto mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Hourglass className="size-5" aria-hidden /></span>
      <h2 id="nr-h" className="text-lg font-semibold">{t("Your answers are in — results aren't released yet")}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {r.releasesAt ? rich("Results will be released on {when}.", { when: <strong className="text-foreground">{formatDateTime(r.releasesAt, i18n)}</strong> }) : t(RELEASE_TEXT[r.mode].hint)}
        {" "}{t("Your score and the correct answers stay hidden until then, for everyone.")}
      </p>
      <Button variant="outline" className="mt-4 rounded-xl" onClick={() => window.location.reload()}>{t("Check again")}</Button>
    </section>
  );
}

function ScoreCard({ result }: { result: ResultData }) {
  const i18n = useI18n();
  const { t } = i18n;
  const rich = useRich();
  const s = result.score!;
  const band = BAND_INFO[s.band];
  return (
    <section aria-labelledby="score-h" className="rounded-2xl border bg-card p-5 shadow-card sm:p-7" data-testid="score-card">
      <h2 id="score-h" className="sr-only">{t("Your score")}</h2>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <div>
          <p className="text-5xl font-semibold tabular-nums tracking-tight" data-testid="percentage">{formatPercentBp(s.percentBp, i18n)}</p>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="score-fraction">
            {rich("{score} out of {max} marks", { score: <span className="font-medium text-foreground">{formatCenti(s.scoreCenti, i18n)}</span> }, { max: formatCenti(s.maxCenti, i18n) })}
          </p>
        </div>
        <div className="min-w-[14rem] flex-1">
          <Badge variant="outline" className={cn("h-auto min-h-8 whitespace-normal rounded-full px-3.5 py-1 text-left text-sm font-semibold", TONE[band.tone])} data-testid="band-chip">{t(band.label)}</Badge>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground" data-testid="feedback">{i18n.format.locale === "en" ? feedbackText(s.feedback) || band.message : t(band.message)}</p>
        </div>
      </div>
      <dl className="mt-6 grid grid-cols-3 gap-3 text-center">
        <Count icon={<CheckCircle2 className="size-4 text-success" aria-hidden />} label={t("Correct")} value={s.correct} testId="count-correct" />
        <Count icon={<XCircle className="size-4 text-destructive" aria-hidden />} label={t("Incorrect")} value={s.incorrect} testId="count-incorrect" />
        <Count icon={<CircleHelp className="size-4 text-muted-foreground" aria-hidden />} label={t("Unanswered")} value={s.unanswered} testId="count-unanswered" />
      </dl>
    </section>
  );
}
function Count({ icon, label, value, testId }: { icon: React.ReactNode; label: string; value: number; testId: string }) {
  const { format } = useI18n();
  return (
    <div className="rounded-xl border bg-background p-3">
      <dt className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">{icon} {label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums" data-testid={testId}>{format.number(value)}</dd>
    </div>
  );
}

/** The exact thresholds, with the user's band marked (text + icon, not just colour). */
function BandGuide({ current }: { current: FeedbackBand }) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="bands-h" className="rounded-2xl border bg-card p-5 shadow-card">
      <h2 id="bands-h" className="text-sm font-semibold">{t("How results are rated")}</h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-5">
        {BAND_ORDER.map((b) => {
          const info = BAND_INFO[b];
          const on = b === current;
          return (
            <li key={b} aria-current={on ? "true" : undefined} className={cn("rounded-xl border p-3 text-xs", on ? cn(TONE[info.tone], "ring-2 ring-current/30") : "bg-background text-muted-foreground")}>
              <p className="font-semibold">{t(info.label)}{on && <span className="ml-1">{t("← you")}</span>}</p>
              <p className="mt-0.5">{t(info.range)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TopicPerformance({ topics }: { topics: NonNullable<ResultData["topics"]> }) {
  const i18n = useI18n();
  const { t, format } = i18n;
  const data = topics.map((tp) => ({ name: tp.topic || t("General"), pct: tp.percentBp / 100, correct: tp.correct, total: tp.questions }));
  const height = Math.max(140, data.length * 46 + 40);
  return (
    <section aria-labelledby="topics-h" className="rounded-2xl border bg-card p-5 shadow-card" data-testid="topic-performance">
      <h2 id="topics-h" className="text-sm font-semibold">{t("Performance by topic")}</h2>
      <div className="mt-3 w-full" style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart accessibilityLayer={false} data={data} layout="vertical" margin={{ left: 8, right: 36, top: 4, bottom: 4 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${format.number(Number(v))}%`} fontSize={12} />
            <YAxis type="category" dataKey="name" width={110} fontSize={12} />
            <Bar dataKey="pct" radius={[0, 6, 6, 0]} isAnimationActive={false}>
              {data.map((d, i) => <Cell key={i} fill={d.pct >= 70 ? "var(--chart-2)" : d.pct >= 60 ? "var(--chart-3)" : "var(--chart-4)"} />)}
              <LabelList dataKey="pct" position="right" formatter={(v: unknown) => `${format.number(Math.round(Number(v)))}%`} fontSize={12} className="fill-foreground" />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* the same numbers as text, for screen readers and anyone who prefers them */}
      <table className="mt-2 w-full text-sm">
        <caption className="sr-only">{t("Topic performance")}</caption>
        <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">{t("Topic")}</th><th className="py-1 font-medium">{t("Correct")}</th><th className="py-1 text-right font-medium">{t("Score")}</th></tr></thead>
        <tbody>
          {topics.map((tp, i) => (
            <tr key={i} className="border-t">
              <td className="py-1.5">{tp.topic || t("General")}</td>
              <td className="py-1.5 text-muted-foreground">{t("{correct} of {total}", { correct: tp.correct, total: tp.questions })}{tp.unanswered > 0 ? ` · ${t("{count} unanswered", { count: tp.unanswered })}` : ""}</td>
              <td className="py-1.5 text-right tabular-nums">{formatPercentBp(tp.percentBp, i18n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const OUTCOME: Record<Outcome, { label: string; icon: React.ReactNode; cls: string }> = {
  CORRECT: { label: msg("Correct"), icon: <CheckCircle2 className="size-3.5" aria-hidden />, cls: "border-success/40 bg-success-soft text-success" },
  INCORRECT: { label: msg("Incorrect"), icon: <XCircle className="size-3.5" aria-hidden />, cls: "border-destructive/40 bg-destructive/10 text-destructive" },
  UNANSWERED: { label: msg("Not answered"), icon: <CircleHelp className="size-3.5" aria-hidden />, cls: "text-muted-foreground" },
};

function Review({ result, attemptId }: { result: ResultData; attemptId: string }) {
  const { t } = useI18n();
  if (!result.review) {
    return <p className="rounded-2xl border border-dashed bg-card/60 p-5 text-sm text-muted-foreground" data-testid="no-review">{t("This exam doesn't show a question-by-question review.")}</p>;
  }
  const showKey = result.review.some((r) => r.correctOptionId);
  return (
    <section aria-labelledby="review-h" data-testid="review">
      <h2 id="review-h" className="mb-3 text-lg font-semibold">{t("Question review")}</h2>
      {!showKey && <p className="mb-3 text-sm text-muted-foreground">{t("For this exam you can see which questions were right or wrong. The correct answers aren't shown.")}</p>}
      <ol className="space-y-3">
        {result.review.map((r) => <ReviewItem key={r.questionId} r={r} attemptId={attemptId} />)}
      </ol>
    </section>
  );
}

function ReviewItem({ r, attemptId }: { r: ResultReview; attemptId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const o = OUTCOME[r.outcome];
  return (
    <li className="rounded-2xl border bg-card p-4 shadow-card sm:p-5" data-testid="review-item" data-outcome={r.outcome}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{t("Question {n}", { n: r.position })}</span>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("h-6 gap-1 rounded-full px-2 text-[11px]", o.cls)}>{o.icon}{t(o.label)}</Badge>
          <span className="text-xs tabular-nums text-muted-foreground">{t("{marks} marks", { marks: `${r.awardedCenti > 0 ? "+" : ""}${formatCenti(r.awardedCenti, i18n)}` })}</span>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap font-medium">{r.stem}</p>
      <ul className="mt-3 space-y-1.5">
        {r.options.map((opt, i) => {
          const mine = r.selectedOptionId === opt.id;
          const correct = r.correctOptionId === opt.id;
          return (
            <li key={opt.id} className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm", correct && "border-success/50 bg-success-soft", mine && !correct && "border-destructive/40 bg-destructive/5")}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted text-xs font-bold" aria-hidden>{optionLetter(i)}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words"><span className="sr-only">{t("Option {letter}", { letter: optionLetter(i) })}: </span>{opt.text}</span>
              <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] font-medium">
                {mine && <span>{t("Your answer")}</span>}
                {correct && <span className="text-success">{t("Correct answer")}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {r.selectedOptionId === null && <p className="mt-2 text-xs text-muted-foreground">{t("You didn't answer this question.")}</p>}
      {r.explanation && <p className="mt-3 text-sm"><span className="font-semibold">{t("Explanation:")} </span>{r.explanation}</p>}
      {r.shortNote && <p className="mt-2 rounded-lg bg-accent/60 px-3 py-2 text-sm"><span className="font-semibold">{t("Short note:")} </span>{r.shortNote}</p>}
      {r.outcome !== "CORRECT" && r.correctOptionId && <ExplainButton attemptId={attemptId} questionId={r.questionId} />}
      {r.sources && r.sources.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">{t("Sources ({count})", { count: r.sources.length })}</summary>
          <ul className="mt-1 space-y-1">{r.sources.map((s, i) => <li key={i}><span className="font-medium text-foreground">{s.documentName}{s.page ? `, ${t("page {n}", { n: s.page })}` : ""}</span> — “{s.quote}”</li>)}</ul>
        </details>
      )}
    </li>
  );
}

function Actions({ result, attemptId, examId }: { result: ResultData; attemptId: string; examId: string | null }) {
  const { t } = useI18n();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function retry() {
    if (!examId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiSend<{ attempt: { id: string } }>("POST", `/api/exams/${examId}/attempts`, {});
      router.push(`/attempts/${res.attempt.id}`);
    } catch (err) {
      setBusy(false);
      const e = err instanceof ApiError ? describeExamError(err.code, err.message, t) : describeExamError("NETWORK", t("Couldn't reach the server."), t);
      setError(`${e.title}. ${e.message}`);
    }
  }
  const weak = (result.topics ?? []).filter((tp) => tp.percentBp < 7000).length;
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-card" aria-labelledby="next-h">
      <h2 id="next-h" className="text-sm font-semibold">{t("What next?")}</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {result.retry?.allowed && examId && (
          <Button onClick={() => void retry()} disabled={busy} data-testid="retry">
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />} {t("Try again · {count, plural, one {# attempt} other {# attempts}} left", { count: result.retry.attemptsLeft })}
          </Button>
        )}
        <Button asChild variant="outline"><Link href="/question-bank"><BookOpenCheck aria-hidden /> {t("Revise in the question bank")}</Link></Button>
        <RevisionPlanButton attemptId={attemptId} />
        {examId && <Button asChild variant="ghost"><Link href={`/exams/${examId}`}>{t("Back to the exam")}</Link></Button>}
      </div>
      {weak > 0 && <p className="mt-3 text-xs text-muted-foreground">{t("{count, plural, one {# topic is} other {# topics are}} below 70% — start your revision there.", { count: weak })}</p>}
      {error && <p role="alert" className="mt-2 text-sm font-medium text-destructive">{error}</p>}
    </section>
  );
}
