"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, EyeOff, ChevronRight, Lock, Target, TrendingDown, TrendingUp, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/common/stat-card";
import { ApiError, apiGet } from "@/lib/api";
import { describeGroupError, examLink } from "@/lib/groups";
import { formatPercent, readLeaderboard, type LeaderboardResponse } from "@/lib/leaderboard";
import { DistributionChart } from "./distribution-chart";
import { LeaderboardTable } from "./leaderboard-table";
import { ParticipantsView } from "./participants-view";

const PAGE_SIZE = 25;

export function LeaderboardView({ examId, title, group, initial }: { examId: string; title: string; group: { id: string; title: string } | null; initial: unknown }) {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["leaderboard", examId, page],
    queryFn: async (): Promise<LeaderboardResponse> => readLeaderboard(await apiGet(`/api/exams/${examId}/leaderboard?page=${page}&pageSize=${PAGE_SIZE}`)),
    ...(page === 1 ? { initialData: readLeaderboard(initial) } : {}),
    placeholderData: (prev) => prev,
    staleTime: 15_000,
  });
  const data = q.data;

  return (
    <>
      <Link href={group ? `/groups/${group.id}?tab=exams` : examLink(examId)} className="mb-3 inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"><ArrowLeft className="size-4" aria-hidden /> {group ? group.title : "Back to the exam"}</Link>
      <header className="mb-5"><p className="text-sm text-muted-foreground">Leaderboard</p><h1 className="break-words text-2xl font-semibold tracking-tight" data-testid="leaderboard-title">{title}</h1></header>

      {q.isLoading && <div className="space-y-3" aria-busy="true"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>}
      {q.isError && <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm">{describeGroupError(q.error instanceof ApiError ? q.error : { code: "ERROR", message: "Couldn't load the leaderboard." })}</p>}

      {data && data.hidden && (
        <section className="rounded-2xl border bg-card p-6 shadow-card" aria-labelledby="lb-hidden" data-testid="leaderboard-hidden">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><EyeOff className="size-5" aria-hidden /></span>
            <div><h2 id="lb-hidden" className="text-lg font-semibold">The leaderboard isn&apos;t shown for this exam</h2><p className="mt-1 text-sm text-muted-foreground">The exam&apos;s author chose to keep rankings private. You can still see your own result in the exam.</p></div>
          </div>
        </section>
      )}

      {data && !data.hidden && !data.released && (
        <section className="rounded-2xl border bg-card p-6 shadow-card" aria-labelledby="lb-locked" data-testid="leaderboard-locked">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Lock className="size-5" aria-hidden /></span>
            <div>
              <h2 id="lb-locked" className="text-lg font-semibold">Results aren&apos;t released yet</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {data.releasesAt ? <>Scores and the leaderboard appear on <time dateTime={data.releasesAt} suppressHydrationWarning className="font-medium text-foreground">{new Date(data.releasesAt).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}</time>.</> : "Scores and the leaderboard appear once the exam's results are released."}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="participation-counts">
            {([["Participants", data.participants.total], ["Submitted", data.participants.submitted], ["Timed out", data.participants.timedOut], ["In progress", data.participants.inProgress], ["Not started", data.participants.notStarted], ["Missed", data.participants.missed]] as const).map(([label, n]) => (
              <div key={label} className="rounded-xl border bg-background p-3"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 text-2xl font-semibold tabular-nums">{n}</dd></div>
            ))}
          </dl>
        </section>
      )}

      {data && !data.hidden && data.released && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="leaderboard-stats">
            <StatCard label="Participants" value={data.stats.participants} hint={`${data.stats.ranked} ranked`} icon={Users} />
            <StatCard label="Group average" value={formatPercent(data.stats.average)} icon={Target} tone="green" />
            <StatCard label="Highest" value={formatPercent(data.stats.highest)} icon={TrendingUp} tone="amber" />
            <StatCard label="Lowest" value={formatPercent(data.stats.lowest)} icon={TrendingDown} tone="blue" />
          </div>
          <section className="rounded-2xl border bg-card p-5 shadow-card" aria-labelledby="dist-h">
            <h2 id="dist-h" className="text-base font-semibold">Score distribution</h2>
            <p className="mb-3 text-xs text-muted-foreground">How many ranked participants fall in each percentage band (best attempt).</p>
            <DistributionChart distribution={data.distribution} />
          </section>
          <section className="rounded-2xl border bg-card shadow-card" aria-labelledby="lb-h" aria-busy={q.isFetching}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
              <h2 id="lb-h" className="text-base font-semibold">Ranking</h2>
              <p className="text-xs text-muted-foreground">Equal scores share a rank and the next rank is skipped (1, 2, 2, 4). Ranks use each person&apos;s best finalized attempt.</p>
            </div>
            {data.myEntry && !data.items.some((i) => i.isSelf) && (
              <div className="border-b bg-accent/30 px-5 py-3 text-sm" data-testid="my-entry"><span className="font-medium">Your position: </span>{data.myEntry.rank !== null ? `rank ${data.myEntry.rank}` : "not ranked"} · {formatPercent(data.myEntry.percentBp)}</div>
            )}
            {data.items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Nobody has finished this exam yet.</p> : <LeaderboardTable items={data.items} />}
            {data.total > PAGE_SIZE && (
              <nav aria-label="Leaderboard pages" className="flex items-center justify-between border-t px-5 py-3">
                <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft aria-hidden /> Previous</Button>
                <span className="text-sm text-muted-foreground" aria-live="polite">Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}</span>
                <Button variant="outline" size="sm" className="rounded-xl" disabled={page * PAGE_SIZE >= data.total} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight aria-hidden /></Button>
              </nav>
            )}
          </section>
        </div>
      )}
      <div className="mt-5"><ParticipantsView examId={examId} /></div>
    </>
  );
}
