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
import { useI18n } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const PAGE_SIZE = 25;

export function LeaderboardView({ examId, title, group, initial }: { examId: string; title: string; group: { id: string; title: string } | null; initial: unknown }) {
  const i18n = useI18n();
  const { t, format } = i18n;
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
      <Link href={group ? `/groups/${group.id}?tab=exams` : examLink(examId)} className="mb-3 inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"><ArrowLeft className="size-4" aria-hidden /> {group ? group.title : t("Back to the exam")}</Link>
      <header className="mb-5"><p className="text-sm text-muted-foreground">{t("Leaderboard")}</p><h1 className="break-words text-2xl font-semibold tracking-tight" data-testid="leaderboard-title">{title === "Group exam" ? t(title) : title}</h1></header>

      {q.isLoading && <div className="space-y-3" aria-busy="true"><Skeleton className="h-28 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>}
      {q.isError && <p role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm">{describeGroupError(q.error instanceof ApiError ? q.error : { code: "ERROR", message: "Couldn't load the leaderboard." }, "generic", t)}</p>}

      {data && data.hidden && (
        <section className="rounded-2xl border bg-card p-6 shadow-card" aria-labelledby="lb-hidden" data-testid="leaderboard-hidden">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><EyeOff className="size-5" aria-hidden /></span>
            <div><h2 id="lb-hidden" className="text-lg font-semibold">{t("The leaderboard isn't shown for this exam")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("The exam's author chose to keep rankings private. You can still see your own result in the exam.")}</p></div>
          </div>
        </section>
      )}

      {data && !data.hidden && !data.released && (
        <section className="rounded-2xl border bg-card p-6 shadow-card" aria-labelledby="lb-locked" data-testid="leaderboard-locked">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Lock className="size-5" aria-hidden /></span>
            <div>
              <h2 id="lb-locked" className="text-lg font-semibold">{t("Results aren't released yet")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {data.releasesAt ? <>{t("Scores and the leaderboard appear on")} <time dateTime={data.releasesAt} suppressHydrationWarning className="font-medium text-foreground">{format.dateTimeLong(data.releasesAt)}</time>.</> : t("Scores and the leaderboard appear once the exam's results are released.")}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="participation-counts">
            {([[msg("Participants"), data.participants.total], [msg("Submitted"), data.participants.submitted], [msg("Timed out"), data.participants.timedOut], [msg("In progress"), data.participants.inProgress], [msg("Not started"), data.participants.notStarted], [msg("Missed"), data.participants.missed]] as const).map(([label, n]) => (
              <div key={label} className="rounded-xl border bg-background p-3"><dt className="text-xs text-muted-foreground">{t(label)}</dt><dd className="mt-0.5 text-2xl font-semibold tabular-nums">{format.number(n)}</dd></div>
            ))}
          </dl>
        </section>
      )}

      {data && !data.hidden && data.released && (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="leaderboard-stats">
            <StatCard label={t("Participants")} value={format.number(data.stats.participants)} hint={t("{count} ranked", { count: data.stats.ranked })} icon={Users} />
            <StatCard label={t("Group average")} value={formatPercent(data.stats.average, i18n)} icon={Target} tone="green" />
            <StatCard label={t("Highest")} value={formatPercent(data.stats.highest, i18n)} icon={TrendingUp} tone="amber" />
            <StatCard label={t("Lowest")} value={formatPercent(data.stats.lowest, i18n)} icon={TrendingDown} tone="blue" />
          </div>
          <section className="rounded-2xl border bg-card p-5 shadow-card" aria-labelledby="dist-h">
            <h2 id="dist-h" className="text-base font-semibold">{t("Score distribution")}</h2>
            <p className="mb-3 text-xs text-muted-foreground">{t("How many ranked participants fall in each percentage band (best attempt).")}</p>
            <DistributionChart distribution={data.distribution} />
          </section>
          <section className="rounded-2xl border bg-card shadow-card" aria-labelledby="lb-h" aria-busy={q.isFetching}>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
              <h2 id="lb-h" className="text-base font-semibold">{t("Ranking")}</h2>
              <p className="text-xs text-muted-foreground">{t("Equal scores share a rank and the next rank is skipped (1, 2, 2, 4). Ranks use each person's best finalized attempt.")}</p>
            </div>
            {data.myEntry && !data.items.some((i) => i.isSelf) && (
              <div className="border-b bg-accent/30 px-5 py-3 text-sm" data-testid="my-entry"><span className="font-medium">{t("Your position:")} </span>{data.myEntry.rank !== null ? t("rank {n}", { n: data.myEntry.rank }) : t("not ranked")} · {formatPercent(data.myEntry.percentBp, i18n)}</div>
            )}
            {data.items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{t("Nobody has finished this exam yet.")}</p> : <LeaderboardTable items={data.items} />}
            {data.total > PAGE_SIZE && (
              <nav aria-label={t("Leaderboard pages")} className="flex items-center justify-between border-t px-5 py-3">
                <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft aria-hidden /> {t("Previous")}</Button>
                <span className="text-sm text-muted-foreground" aria-live="polite">{t("Showing {from}–{to} of {total}", { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, data.total), total: data.total })}</span>
                <Button variant="outline" size="sm" className="rounded-xl" disabled={page * PAGE_SIZE >= data.total} onClick={() => setPage((p) => p + 1)}>{t("Next")} <ChevronRight aria-hidden /></Button>
              </nav>
            )}
          </section>
        </div>
      )}
      <div className="mt-5"><ParticipantsView examId={examId} /></div>
    </>
  );
}
