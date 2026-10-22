"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bookmark, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CloudOff, Keyboard, Loader2, RotateCcw, Send, TimerOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import {
  AutosaveQueue, countAnswered, countMarked, crossedMilestone, describeExamError, milestoneText, optionLetter, remainingFromSync, syncClock,
  type AttemptView, type ClockSync, type SaveItem,
} from "@/lib/exams";
import { fetchAttempt, sendAnswers, submitAttempt } from "@/lib/exams-api";
import { cn } from "@/lib/utils";
import { ExamTimer } from "./exam-timer";
import { QuestionNavigator } from "./question-navigator";

type Phase = "loading" | "error" | "active" | "timeup" | "submitting" | "done";
const mono = () => performance.now();

/**
 * The focused exam screen. Time comes ONLY from the server: the countdown is the `remainingMs` of the last server response
 * plus elapsed monotonic time (performance.now), so changing the device clock or any JS state cannot extend the exam.
 * An answer is shown as "Saved" only after the server confirmed that exact selection.
 */
export function TakeExam({ attemptId }: { attemptId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const queue = useRef<AutosaveQueue | null>(null);
  const [q, setQ] = useState<AutosaveQueue | null>(null); // same object as `queue.current`, held in state so render may read it
  const [totalMs, setTotalMs] = useState(1);
  const clock = useRef<ClockSync>(syncClock(0, mono()));
  const prevRemaining = useRef<number | null>(null);
  const timeUpHandled = useRef(false);

  const resync = useCallback((remainingMs: number) => {
    clock.current = syncClock(remainingMs, mono());
  }, []);

  // ---- load (always fresh from the server: never trust a render-time snapshot for the clock) ----
  const load = useCallback(async () => {
    try {
      const a = await fetchAttempt(attemptId);
      if (a.status !== "IN_PROGRESS") {
        setPhase("done");
        router.replace(`/attempts/${attemptId}/result`);
        return;
      }
      resync(a.remainingMs);
      setRemaining(a.remainingMs);
      setTotalMs(Math.max(1, new Date(a.deadlineAt).getTime() - new Date(a.startedAt).getTime())); // two SERVER timestamps: no device clock involved
      if (!queue.current) {
        queue.current = new AutosaveQueue({
          initial: a.answers,
          send: (items) => sendAnswers(attemptId, items),
          onResponse: (r) => resync(r.remainingMs),
          onChange: rerender,
        });
        setQ(queue.current);
      } else queue.current.mergeServer(a.answers);
      setAttempt(a);
      setPhase((p) => (p === "loading" || p === "error" ? "active" : p));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setLoadError({ code: "NOT_FOUND", message: "We couldn't find that attempt." });
      else setLoadError({ code: err instanceof ApiError ? err.code : "NETWORK", message: err instanceof ApiError ? err.message : "Couldn't reach the server." });
      setPhase((p) => (p === "loading" ? "error" : p));
    }
  }, [attemptId, resync, router]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => { clearTimeout(t); queue.current?.dispose(); };
  }, [load]);

  const handleTimeUp = useCallback(async () => {
    setPhase("timeup");
    // Server decides. Ask for the truth; if it still has time (our clock was early) keep going, else submit what the server has.
    for (let i = 0; i < 40; i++) {
      try {
        const a = await fetchAttempt(attemptId);
        if (a.status !== "IN_PROGRESS") break;
        if (a.remainingMs > 1500) { resync(a.remainingMs); timeUpHandled.current = false; setPhase("active"); return; }
        await submitAttempt(attemptId, queue.current?.status === "expired" ? [] : queue.current?.pendingItems() ?? []);
        break;
      } catch (err) {
        if (err instanceof ApiError && err.code === "ATTEMPT_EXPIRED") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    queue.current?.markExpired();
    setPhase("done");
    router.replace(`/attempts/${attemptId}/result`);
  }, [attemptId, resync, router]);

  // ---- tick: display only ----
  useEffect(() => {
    if (phase !== "active") return;
    const id = setInterval(() => {
      const r = remainingFromSync(clock.current, mono());
      setRemaining(r);
      const m = prevRemaining.current === null ? null : crossedMilestone(prevRemaining.current, r);
      if (m !== null) setAnnounce(milestoneText(m));
      prevRemaining.current = r;
      if (r <= 0 && !timeUpHandled.current) {
        timeUpHandled.current = true;
        void handleTimeUp();
      }
    }, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ---- re-sync on focus and periodically (also restores answers after a connection loss) ----
  useEffect(() => {
    if (phase !== "active") return;
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(() => void load(), 30_000);
    const onOnline = () => { void queue.current?.retryNow().then(() => load()); };
    window.addEventListener("online", onOnline);
    return () => { document.removeEventListener("visibilitychange", onVisible); clearInterval(poll); window.removeEventListener("online", onOnline); };
  }, [phase, load]);

  // The queue found out the attempt ended (server said ATTEMPT_EXPIRED) or that another device saved something newer.
  useEffect(() => {
    const t = setTimeout(() => {
      if (q?.status === "expired" && phase === "active") { timeUpHandled.current = true; void handleTimeUp(); }
      if (q?.needsResync) void load();
    }, 0);
    return () => clearTimeout(t);
  }, [q?.status, q?.needsResync, phase, handleTimeUp, load]);

  async function submit() {
    setSubmitError(null);
    setPhase("submitting");
    try {
      await submitAttempt(attemptId, queue.current?.pendingItems() ?? []);
      queue.current?.dispose();
      setPhase("done");
      router.push(`/attempts/${attemptId}/result`);
    } catch (err) {
      setPhase("active");
      const e = err instanceof ApiError ? describeExamError(err.code, err.message) : describeExamError("NETWORK", "Couldn't reach the server.");
      setSubmitError(`${e.title}. ${e.message} Your answers are still on screen — try again.`);
    }
  }

  const questions = attempt?.questions ?? [];
  const current = questions[index];
  const answers = q?.answers ?? new Map();

  const choose = useCallback((optionId: string | null) => {
    if (!current) return;
    queue.current?.change(current.id, { optionId });
  }, [current]);
  const toggleMark = useCallback(() => {
    if (!current) return;
    queue.current?.change(current.id, { marked: !(queue.current.answers.get(current.id)?.marked ?? false) });
  }, [current]);
  const go = useCallback((i: number) => setIndex(Math.min(Math.max(0, i), Math.max(0, questions.length - 1))), [questions.length]);

  // ---- keyboard: A–F / 1–6 choose, N / P next / previous, M mark ----
  useEffect(() => {
    if (phase !== "active" || confirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "radio" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      const opts = current?.options ?? [];
      const letterIdx = "abcdef".indexOf(k);
      const numIdx = "123456".indexOf(k);
      const pick = k.length === 1 ? (letterIdx >= 0 ? letterIdx : numIdx) : -1;
      if (pick >= 0 && pick < opts.length) { e.preventDefault(); choose(opts[pick]!.id); }
      else if (k === "n") { e.preventDefault(); go(index + 1); }
      else if (k === "p") { e.preventDefault(); go(index - 1); }
      else if (k === "m") { e.preventDefault(); toggleMark(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, confirmOpen, current, index, choose, go, toggleMark]);

  // ---- leaving the page with unconfirmed answers ----
  const pending = q?.pendingCount ?? 0;
  useEffect(() => {
    if (pending === 0 || phase === "done") return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, phase]);

  // ---- save status announcements (politely, on change only) ----
  const status = q?.status ?? "idle";
  const statusText = status === "offline" ? "Not saved — reconnecting" : status === "error" ? "Couldn't save" : status === "expired" ? "Attempt ended" : pending > 0 ? "Saving…" : "All changes saved";

  if (phase === "loading") return <LoadingState />;
  if (phase === "error" || !attempt || !current) {
    return (
      <Shell>
        <div className="mx-auto max-w-lg rounded-2xl border bg-card p-8 text-center shadow-card">
          <AlertTriangle className="mx-auto mb-3 size-8 text-warning" aria-hidden />
          <h1 className="text-xl font-semibold">{loadError?.code === "NOT_FOUND" ? "Attempt not found" : "Couldn't open this attempt"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{loadError?.message ?? "Please try again."}</p>
          <div className="mt-5 flex justify-center gap-2">
            {loadError?.code !== "NOT_FOUND" && <Button onClick={() => { setPhase("loading"); void load(); }}><RotateCcw aria-hidden /> Try again</Button>}
            <Button asChild variant="outline"><Link href="/exams">Back to exams</Link></Button>
          </div>
        </div>
      </Shell>
    );
  }
  if (phase === "timeup" || phase === "done") return <TimeUp attemptId={attemptId} finishing={phase === "timeup"} />;

  const answeredCount = countAnswered(questions, answers);
  const markedCount = countMarked(questions, answers);
  const unanswered = questions.length - answeredCount;
  const cur = answers.get(current.id);
  const saved = q?.isSaved(current.id) ?? true;

  return (
    <Shell>
      <div className="sr-only" aria-live="polite" role="status" data-testid="exam-announcer">{announce}</div>
      <div className="sr-only" aria-live="polite" role="status" data-testid="save-announcer">{statusText}</div>

      <header className="mb-4 rounded-2xl border bg-card p-4 shadow-card sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Multiple-choice exam · attempt {attempt.attemptNo}</p>
            <h1 className="truncate text-lg font-semibold sm:text-xl" title={attempt.examTitle}>{attempt.examTitle}</h1>
          </div>
          <ExamTimer remainingMs={remaining} totalMs={totalMs} />
          <div className="flex items-center gap-3">
            <SaveIndicator status={status} pending={pending} onRetry={() => void queue.current?.retryNow()} />
            <Button className="h-10 rounded-xl bg-success px-5 text-success-foreground hover:bg-success/90" onClick={() => { setSubmitError(null); setConfirmOpen(true); }} data-testid="submit-exam">
              <Send aria-hidden /> Submit answers
            </Button>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Progress value={(answeredCount / questions.length) * 100} aria-label={`${answeredCount} of ${questions.length} questions answered`} className="h-2.5 bg-muted" />
          <span className="shrink-0 text-sm text-muted-foreground" data-testid="progress-text">{answeredCount}/{questions.length} answered</span>
        </div>
      </header>

      {status === "offline" && (
        <Alert role="alert" className="mb-4 border-warning/50 bg-warning-soft" data-testid="offline-banner">
          <CloudOff className="text-amber-700" aria-hidden />
          <AlertTitle>Not saved — reconnecting</AlertTitle>
          <AlertDescription>
            <p>We can&apos;t reach the server, so {pending} {pending === 1 ? "answer isn't" : "answers aren't"} saved yet. Keep going — they&apos;re kept on this page and we&apos;ll retry automatically. The timer is still running on the server.</p>
            <Button size="sm" variant="outline" className="mt-2 rounded-lg" onClick={() => void queue.current?.retryNow()}>Retry now</Button>
          </AlertDescription>
        </Alert>
      )}
      {status === "error" && (
        <Alert variant="destructive" role="alert" className="mb-4">
          <AlertTitle>Couldn&apos;t save your last answer</AlertTitle>
          <AlertDescription>{q?.lastError} <Button size="sm" variant="outline" className="ml-2 rounded-lg" onClick={() => void queue.current?.retryNow()}>Try again</Button></AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <section aria-labelledby="question-heading" className="min-w-0 rounded-2xl border bg-card p-5 shadow-card sm:p-7" data-testid="question-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span id="question-pill" className="inline-flex items-center rounded-full bg-accent px-3.5 py-1 text-sm font-semibold text-accent-foreground">
              Question {index + 1} <span className="ml-1 font-normal text-muted-foreground">of {questions.length}</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{current.marks} {current.marks === 1 ? "mark" : "marks"}{attempt.negativeMarking ? " · negative marking" : ""}</span>
              <Button variant={cur?.marked ? "default" : "outline"} size="sm" className="h-9 rounded-xl" aria-pressed={cur?.marked ?? false} onClick={toggleMark} data-testid="mark-review">
                <Bookmark className={cn(cur?.marked && "fill-current")} aria-hidden /> {cur?.marked ? "Marked" : "Mark for review"}
              </Button>
            </div>
          </div>

          <h2 id="question-heading" className="mt-5 whitespace-pre-wrap text-xl font-semibold leading-snug sm:text-2xl" data-testid="question-stem">{current.stem}</h2>

          <fieldset className="mt-6" key={current.id}>
            <legend className="sr-only">Choose one answer for question {index + 1}</legend>
            <div role="radiogroup" aria-labelledby="question-heading" className="space-y-2.5">
              {current.options.map((o, i) => {
                const id = `opt-${current.id}-${o.id}`;
                const selected = cur?.optionId === o.id;
                return (
                  <div key={o.id}>
                    <input id={id} type="radio" name={`q-${current.id}`} value={o.id} checked={selected} onChange={() => choose(o.id)} className="peer sr-only" data-testid={`option-${optionLetter(i)}`} />
                    <label
                      htmlFor={id}
                      className={cn(
                        "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border bg-background px-3 py-2.5 text-base transition hover:border-primary/50 hover:bg-accent/40 motion-reduce:transition-none",
                        "peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/60",
                        selected && "border-primary bg-accent/50",
                      )}
                    >
                      <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border text-sm font-bold", selected ? "border-primary bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{optionLetter(i)}</span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words"><span className="sr-only">Option {optionLetter(i)}: </span>{o.text}</span>
                      {selected && <Check className="size-5 shrink-0 text-primary" aria-hidden />}
                    </label>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex min-h-6 items-center justify-between gap-3 text-xs text-muted-foreground">
              <button type="button" className="rounded-md underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:no-underline disabled:opacity-40" disabled={!cur?.optionId} onClick={() => choose(null)}>Clear answer</button>
              <span data-testid="question-save-state" aria-hidden>{!cur?.optionId && !cur?.marked ? "" : saved ? <span className="inline-flex items-center gap-1 text-success"><Check className="size-3.5" /> Saved</span> : status === "offline" ? "Not saved yet" : <span className="inline-flex items-center gap-1"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> Saving…</span>}</span>
            </div>
          </fieldset>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <div className="flex gap-1.5">
              <Button variant="outline" size="icon" className="size-10 rounded-xl" onClick={() => go(0)} disabled={index === 0} aria-label="First question"><ChevronsLeft aria-hidden /></Button>
              <Button variant="outline" className="h-10 rounded-xl" onClick={() => go(index - 1)} disabled={index === 0}><ChevronLeft aria-hidden /> Back</Button>
            </div>
            <span className="text-sm text-muted-foreground" aria-hidden>{index + 1} of {questions.length}</span>
            <div className="flex gap-1.5">
              <Button className="h-10 rounded-xl" onClick={() => go(index + 1)} disabled={index === questions.length - 1} data-testid="next-question">Next <ChevronRight aria-hidden /></Button>
              <Button variant="outline" size="icon" className="size-10 rounded-xl" onClick={() => go(questions.length - 1)} disabled={index === questions.length - 1} aria-label="Last question"><ChevronsRight aria-hidden /></Button>
            </div>
          </div>
        </section>

        <aside className="min-w-0 space-y-4">
          <div className="rounded-2xl border bg-card p-4 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Questions</h2>
              <Popover>
                <PopoverTrigger asChild><Button variant="ghost" size="sm" className="h-8 rounded-lg text-xs"><Keyboard aria-hidden /> Shortcuts</Button></PopoverTrigger>
                <PopoverContent align="end" className="w-64 text-sm">
                  <p className="mb-2 font-medium">Keyboard</p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    <dt><kbd className="rounded border bg-muted px-1.5 text-xs">A</kbd>–<kbd className="rounded border bg-muted px-1.5 text-xs">F</kbd> / <kbd className="rounded border bg-muted px-1.5 text-xs">1</kbd>–<kbd className="rounded border bg-muted px-1.5 text-xs">6</kbd></dt><dd>Choose that option</dd>
                    <dt><kbd className="rounded border bg-muted px-1.5 text-xs">N</kbd> / <kbd className="rounded border bg-muted px-1.5 text-xs">P</kbd></dt><dd>Next / previous question</dd>
                    <dt><kbd className="rounded border bg-muted px-1.5 text-xs">M</kbd></dt><dd>Mark for review</dd>
                    <dt>Arrow keys</dt><dd>Move between options</dd>
                  </dl>
                </PopoverContent>
              </Popover>
            </div>
            <QuestionNavigator questions={questions} answers={answers} index={index} onGo={go} />
          </div>
          <div className="rounded-2xl border bg-card p-4 text-sm shadow-card">
            <dl className="grid grid-cols-2 gap-y-1.5">
              <dt className="text-muted-foreground">Answered</dt><dd className="text-right font-medium">{answeredCount}</dd>
              <dt className="text-muted-foreground">Not answered</dt><dd className="text-right font-medium">{unanswered}</dd>
              <dt className="text-muted-foreground">Marked</dt><dd className="text-right font-medium">{markedCount}</dd>
              <dt className="text-muted-foreground">Total marks</dt><dd className="text-right font-medium">{attempt.totalMarks}</dd>
            </dl>
          </div>
        </aside>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(o) => { if (phase !== "submitting") setConfirmOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit your answers?</DialogTitle>
            <DialogDescription>You can&apos;t change your answers after submitting.</DialogDescription>
          </DialogHeader>
          <ul className="space-y-1.5 text-sm">
            <li><strong>{answeredCount}</strong> of {questions.length} answered</li>
            {unanswered > 0 && <li className="text-amber-700 dark:text-amber-300"><strong>{unanswered}</strong> {unanswered === 1 ? "question is" : "questions are"} unanswered — unanswered questions score 0.</li>}
            {markedCount > 0 && <li><strong>{markedCount}</strong> marked for review</li>}
            {pending > 0 && <li className="text-muted-foreground">{pending} recent {pending === 1 ? "change hasn't" : "changes haven't"} been confirmed yet; they&apos;ll be sent with your submission.</li>}
          </ul>
          {submitError && <p role="alert" className="text-sm font-medium text-destructive">{submitError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={phase === "submitting"}>Keep working</Button>
            <Button className="bg-success text-success-foreground hover:bg-success/90" onClick={() => void submit()} disabled={phase === "submitting"} data-testid="confirm-submit">
              {phase === "submitting" ? <><Loader2 className="animate-spin" aria-hidden /> Submitting…</> : "Submit now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl px-3 py-4 outline-none sm:px-6 sm:py-6">
      {children}
    </main>
  );
}

function LoadingState() {
  return (
    <Shell>
      <div role="status" aria-live="polite" className="space-y-4">
        <span className="sr-only">Loading your exam…</span>
        <Skeleton className="h-28 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    </Shell>
  );
}

function SaveIndicator({ status, pending, onRetry }: { status: string; pending: number; onRetry: () => void }) {
  if (status === "offline") return <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 rounded-full border border-warning/60 bg-warning-soft px-3 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" data-testid="save-indicator"><CloudOff className="size-3.5" aria-hidden /> Not saved — retry</button>;
  if (status === "error") return <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/50 px-3 py-1 text-xs font-medium text-destructive" data-testid="save-indicator">Couldn&apos;t save</span>;
  if (pending > 0) return <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground" data-testid="save-indicator"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> Saving…</span>;
  return <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success-soft px-3 py-1 text-xs font-medium text-success" data-testid="save-indicator"><Check className="size-3.5" aria-hidden /> All changes saved</span>;
}

function TimeUp({ attemptId, finishing }: { attemptId: string; finishing: boolean }) {
  return (
    <Shell>
      <div className="mx-auto mt-10 max-w-lg rounded-2xl border bg-card p-8 text-center shadow-card" data-testid="time-up">
        <span className="mx-auto mb-4 inline-flex size-14 items-center justify-center rounded-2xl bg-warning-soft"><TimerOff className="size-7 text-amber-700" aria-hidden /></span>
        <h1 className="text-2xl font-semibold">Time is up</h1>
        <p className="mt-2 text-sm text-muted-foreground">The exam deadline has passed. Answers the server saved before the deadline were kept and your attempt is being finalized. Anything that couldn&apos;t be saved in time is not counted.</p>
        <div className="mt-6" role="status" aria-live="polite">
          {finishing ? <p className="inline-flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> Finalizing your attempt…</p> : <Button asChild><Link href={`/attempts/${attemptId}/result`}>See what happens next</Link></Button>}
        </div>
      </div>
    </Shell>
  );
}

export type { SaveItem };
