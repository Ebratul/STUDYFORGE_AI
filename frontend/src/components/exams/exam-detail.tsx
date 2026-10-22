"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, Copy, Loader2, Pencil, Play, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import {
  BAND_INFO, describeExamError, factsFromDraft, factsFromTakeView, formatDateTime, formatPercentBp, normalizeDraft, rulesInWords,
  type AttemptSummary, type ExamManageView, type ExamTakeView,
} from "@/lib/exams";
import { ModeBadge, StatusBadge } from "./exam-badges";

type Props = { exam: ExamManageView | ExamTakeView; justPublished: boolean };
const isManage = (e: ExamManageView | ExamTakeView): e is ExamManageView => "draft" in e && Boolean((e as ExamManageView).draft);

export function ExamDetail({ exam, justPublished }: Props) {
  const router = useRouter();
  const manage = isManage(exam);
  const [busy, setBusy] = useState<null | "start" | "cancel" | "duplicate" | "delete">(null);
  const [confirm, setConfirm] = useState<null | "cancel" | "delete">(null);
  const [error, setError] = useState<string | null>(null);

  const attempts = useQuery({
    queryKey: ["exam-attempts", exam.id],
    enabled: exam.status !== "DRAFT",
    queryFn: async () => (await apiGet<{ items: AttemptSummary[] }>(`/api/exams/${exam.id}/attempts`)).items,
    staleTime: 5_000,
  });

  const canStart = exam.canStart ?? (manage && exam.mode === "INDIVIDUAL" && exam.status === "PUBLISHED" ? { allowed: true } : { allowed: false });
  const inProgress = exam.canStart?.resumeAttemptId ?? exam.myAttempts?.inProgressAttemptId ?? attempts.data?.find((a) => a.status === "IN_PROGRESS")?.id ?? null;

  async function run<T>(kind: NonNullable<typeof busy>, fn: () => Promise<T>) {
    setBusy(kind);
    setError(null);
    try { return await fn(); } catch (err) {
      const e = err instanceof ApiError ? describeExamError(err.code, err.message) : describeExamError("NETWORK", "Couldn't reach the server.");
      setError(`${e.title}. ${e.message}`);
      return undefined;
    } finally { setBusy(null); }
  }
  const start = () => run("start", async () => {
    const res = await apiSend<{ attempt: { id: string } }>("POST", `/api/exams/${exam.id}/attempts`, {});
    router.push(`/attempts/${res.attempt.id}`);
  });
  const cancel = () => run("cancel", async () => { await apiSend("POST", `/api/exams/${exam.id}/cancel`, {}); setConfirm(null); toast.success("Exam cancelled"); router.refresh(); });
  const duplicate = () => run("duplicate", async () => { const r = await apiSend<{ exam: { id: string } }>("POST", `/api/exams/${exam.id}/duplicate`, {}); toast.success("Copied into a new draft"); router.push(`/exams/${r.exam.id}/edit`); });
  const del = () => run("delete", async () => { await apiSend("DELETE", `/api/exams/${exam.id}`); toast.success("Exam deleted"); router.push("/exams"); });

  const facts = manage ? { ...factsFromDraft(normalizeDraft(exam.draft, { title: exam.title }), { questionCount: exam.questionCount, ...(exam.totalMarks !== null ? { totalMarks: exam.totalMarks } : {}) }) } : factsFromTakeView(exam);
  const integrity = manage ? exam.snapshotIntegrity : undefined;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="exam-title">{exam.title}</h1>
          <StatusBadge status={exam.status} /><ModeBadge mode={exam.mode} group={exam.group} />
        </div>
        {exam.description && <p className="mt-1.5 max-w-2xl whitespace-pre-wrap text-sm text-muted-foreground">{exam.description}</p>}
      </header>

      {justPublished && <Alert className="border-success/40 bg-success-soft" role="status" data-testid="published-banner"><ShieldCheck className="text-success" aria-hidden /><AlertTitle>Published</AlertTitle><AlertDescription>The exam is frozen and ready. {exam.mode === "GROUP" ? "Group members have been notified." : "You can start it below."}</AlertDescription></Alert>}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      {exam.status === "CANCELLED" && <Alert className="border-destructive/30 bg-destructive/5"><XCircle className="text-destructive" aria-hidden /><AlertTitle>This exam was cancelled</AlertTitle><AlertDescription>No new attempts can be started. Attempts already in progress finish normally.</AlertDescription></Alert>}

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="space-y-5">
          {exam.status !== "DRAFT" && (
            <div className="rounded-2xl border bg-card p-5 shadow-card" aria-labelledby="rules-h">
              <h2 id="rules-h" className="text-base font-semibold">Rules</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground" data-testid="rules-list">{rulesInWords(facts).map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          )}

          {exam.status === "DRAFT" && manage && (
            <div className="rounded-2xl border bg-card p-5 shadow-card">
              <p className="text-sm text-muted-foreground">This exam is still a draft ({exam.questionCount} {exam.questionCount === 1 ? "question" : "questions"}). Nobody can take it until you publish it.</p>
              <Button asChild className="mt-3 rounded-xl"><Link href={`/exams/${exam.id}/edit`}><Pencil aria-hidden /> Continue editing</Link></Button>
            </div>
          )}

          {exam.status !== "DRAFT" && (
            <div className="rounded-2xl border bg-card p-5 shadow-card" aria-labelledby="att-h">
              <h2 id="att-h" className="text-base font-semibold">Your attempts</h2>
              {attempts.isLoading ? <p className="mt-2 text-sm text-muted-foreground" role="status">Loading…</p> : (attempts.data ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">You haven&apos;t taken this exam yet.</p>
              ) : (
                <ul className="mt-3 divide-y" data-testid="attempt-list">
                  {attempts.data!.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                      <div>
                        <p className="font-medium">Attempt {a.attemptNo} <span className="font-normal text-muted-foreground">· {a.status === "IN_PROGRESS" ? "in progress" : a.status === "TIMED_OUT" ? "timed out" : "submitted"} · {formatDateTime(a.finalizedAt ?? a.startedAt)}</span></p>
                        {a.status !== "IN_PROGRESS" && (
                          <p className="text-xs text-muted-foreground">
                            {a.result.released && a.result.percentBp !== undefined ? <>Result <span className="font-medium text-foreground">{formatPercentBp(a.result.percentBp)}</span>{a.result.band && <> · {BAND_INFO[a.result.band].label}</>}</> : "Result not released yet"}
                          </p>
                        )}
                      </div>
                      <Button asChild size="sm" variant="outline" className="rounded-lg"><Link href={a.status === "IN_PROGRESS" ? `/attempts/${a.id}` : `/attempts/${a.id}/result`}>{a.status === "IN_PROGRESS" ? "Resume" : "View result"}</Link></Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <aside className="space-y-4">
          {exam.status === "PUBLISHED" && (
            <div className="rounded-2xl border bg-card p-5 shadow-card">
              {inProgress ? (
                <Button asChild className="h-11 w-full rounded-xl"><Link href={`/attempts/${inProgress}`}><Play aria-hidden /> Resume your attempt</Link></Button>
              ) : (
                <Button className="h-11 w-full rounded-xl" disabled={!canStart.allowed || busy === "start"} onClick={() => void start()} data-testid="start-exam">
                  {busy === "start" ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />} {(exam.myAttempts?.used ?? 0) > 0 ? "Start another attempt" : "Start exam"}
                </Button>
              )}
              {!canStart.allowed && !inProgress && <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="cannot-start"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {canStart.reason ?? "You can't start this exam right now."}</p>}
              {exam.myAttempts && <p className="mt-2 text-xs text-muted-foreground">Attempts used: {exam.myAttempts.used} of {exam.myAttempts.limit}</p>}
              <p className="mt-2 text-xs text-muted-foreground">Starting begins the timer. It runs on the server, so closing the page doesn&apos;t pause it.</p>
            </div>
          )}

          {exam.mode === "GROUP" && exam.status !== "DRAFT" && (
            <Button asChild variant="outline" className="w-full rounded-xl"><Link href={`/exams/${exam.id}/leaderboard`}><BarChart3 aria-hidden /> Leaderboard</Link></Button>
          )}

          {manage && (
            <div className="space-y-2 rounded-2xl border bg-card p-5 shadow-card">
              <h2 className="text-sm font-semibold">Manage</h2>
              {integrity && (
                <p className="flex items-center gap-1.5 text-xs" data-testid="integrity">
                  <ShieldCheck className={integrity === "OK" ? "size-4 text-success" : "size-4 text-destructive"} aria-hidden />
                  {integrity === "OK" ? "Published snapshot verified — unchanged since publication." : "Snapshot check failed. Contact support."}
                </p>
              )}
              {exam.versions && exam.versions.length > 0 && <p className="text-xs text-muted-foreground">Version {exam.currentVersion ?? exam.versions[0]!.version} · published {formatDateTime(exam.publishedAt)}</p>}
              <div className="flex flex-col gap-2 pt-1">
                <Button variant="outline" className="justify-start rounded-xl" onClick={() => void duplicate()} disabled={busy !== null}><Copy aria-hidden /> Duplicate into a new draft</Button>
                {exam.status === "PUBLISHED" && <Button variant="outline" className="justify-start rounded-xl" onClick={() => setConfirm("cancel")} disabled={busy !== null}><XCircle aria-hidden /> Cancel exam</Button>}
                {exam.status === "DRAFT" && <Button variant="outline" className="justify-start rounded-xl text-destructive" onClick={() => setConfirm("delete")} disabled={busy !== null}><Trash2 aria-hidden /> Delete draft</Button>}
              </div>
              {exam.status === "PUBLISHED" && <Badge variant="outline" className="rounded-full text-[10px] font-normal">Published exams can&apos;t be edited</Badge>}
            </div>
          )}
        </aside>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => { if (!o && busy === null) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "delete" ? "Delete this draft?" : "Cancel this exam?"}</DialogTitle>
            <DialogDescription>{confirm === "delete" ? "The draft will be removed. Your questions stay in the question bank." : "No new attempts can be started after cancelling. Attempts already in progress finish normally and existing results are kept."}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy !== null}>Keep it</Button>
            <Button variant="destructive" onClick={() => void (confirm === "delete" ? del() : cancel())} disabled={busy !== null} data-testid="confirm-destructive">{confirm === "delete" ? "Delete draft" : "Cancel exam"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
