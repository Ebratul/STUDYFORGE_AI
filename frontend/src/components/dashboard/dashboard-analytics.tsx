"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Bell, Bot, GraduationCap, LineChart as LineIcon, ListChecks, MessagesSquare, NotebookPen, PieChart, Sparkles, Target, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BAND_INFO, BAND_ORDER } from "@/lib/bands";
import { apiGet } from "@/lib/api";
import { answeredTotal, breakdown, DATA_LEVEL_TEXT, hasResults, readAnalytics, type AnalyticsMe } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { TrendChart } from "./charts";
import { FeedbackCards } from "./feedback-cards";
import { RecentResults } from "./results-list";
import { GroupsCard, SavedContentCard } from "./saved-groups";
import { StatTiles } from "./stat-tiles";
import { Suggestions } from "./suggestions-card";
import { TopicBars } from "./topic-bars";
import { useFormat, useI18n, useRich, useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

function Block({ title, description, icon: Icon, children, testId, className }: { title: string; description?: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>; children: React.ReactNode; testId?: string; className?: string }) {
  return (
    <Card className={cn("min-w-0 rounded-2xl shadow-card", className)} data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Icon className="size-4 text-primary" aria-hidden /> {title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const Empty = ({ children, testId }: { children: React.ReactNode; testId?: string }) => <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid={testId}>{children}</p>;

export function DashboardSkeleton() {
  const t = useT();
  return (
    <div className="space-y-4" role="status" aria-label={t("Loading your dashboard")} data-testid="dashboard-skeleton">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-72 rounded-2xl lg:col-span-2" /><Skeleton className="h-72 rounded-2xl" /></div>
    </div>
  );
}

export function BreakdownBar({ a }: { a: AnalyticsMe }) {
  const { t, format } = useI18n();
  const parts = breakdown(a.totals);
  const total = answeredTotal(a.totals);
  const colour = { correct: "bg-success", incorrect: "bg-destructive/70", unanswered: "bg-muted-foreground/40" } as const;
  return (
    <div data-testid="breakdown">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={t("Of {total} questions: {parts}.", { total, parts: parts.map((p) => `${format.number(p.count)} ${t(p.label)}`).join(", ") })}>
        {parts.map((p) => p.pct > 0 && <div key={p.key} className={colour[p.key]} style={{ width: `${p.pct}%` }} />)}
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center justify-between gap-3 rounded-xl border bg-background px-3 py-2">
            <dt className="flex items-center gap-2 text-muted-foreground"><span className={cn("size-2.5 shrink-0 rounded-full", colour[p.key])} aria-hidden /> {t(p.label)}</dt>
            <dd className="font-semibold tabular-nums">{format.number(p.count)}<span className="ml-1.5 text-xs font-normal text-muted-foreground">{format.number(p.pct)}%</span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function BandCounts({ a }: { a: AnalyticsMe }) {
  const t = useT();
  const { format } = useI18n();
  const total = BAND_ORDER.reduce((n, b) => n + (a.bandCounts[b] ?? 0), 0);
  if (total === 0) return null;
  return (
    <ul className="mt-4 space-y-1.5 text-sm" aria-label={t("Results by band")}>
      {BAND_ORDER.map((b) => (
        <li key={b} className="grid grid-cols-[minmax(0,1fr)_3.5rem_1.5rem] items-center gap-2">
          <span>{t(BAND_INFO[b].label)}</span>
          <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden><span className="block h-full rounded-full bg-primary" style={{ width: `${((a.bandCounts[b] ?? 0) / total) * 100}%` }} /></span>
          <span className="text-right tabular-nums text-muted-foreground">{format.number(a.bandCounts[b] ?? 0)}</span>
        </li>
      ))}
    </ul>
  );
}

export function AnalyticsBody({ a }: { a: AnalyticsMe }) {
  const t = useT();
  const rich = useRich();
  const format = useFormat();
  const has = hasResults(a);
  const actions = [
    { href: "/exams", label: msg("Take an exam"), icon: GraduationCap },
    { href: "/mcq", label: msg("Generate MCQs"), icon: ListChecks },
    { href: "/chat", label: msg("Ask a question"), icon: MessagesSquare },
    { href: "/study-plan", label: msg("Study plan"), icon: NotebookPen },
    { href: "/groups", label: msg("Groups"), icon: Users },
  ];
  return (
    <div className="space-y-4">
      <StatTiles a={a} />
      {has && <p className="text-xs text-muted-foreground" data-testid="data-level"><span className="font-medium text-foreground">{t(DATA_LEVEL_TEXT[a.dataLevel].label)}.</span> {t(DATA_LEVEL_TEXT[a.dataLevel].hint)}</p>}
      {!has && (
        <Card className="rounded-2xl border-dashed shadow-none" data-testid="no-exam-results">
          <CardContent className="flex flex-wrap items-center gap-4 py-6">
            <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><GraduationCap className="size-5" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold">{t("No exam results yet")}</h2>
              <p className="text-sm text-muted-foreground">{t("Scores, trends and topic accuracy are calculated from your real attempts once you've taken an exam and its results are released. Until then, these numbers show “No data yet” — which is different from a score of zero.")}</p>
            </div>
            <Button asChild variant="outline" className="rounded-xl"><Link href="/exams">{t("Go to exams")}</Link></Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Block title={t("Score trend")} description={t("Each point is a released result, oldest to newest.")} icon={LineIcon} testId="trend-card">
            {a.trend.length > 0 ? <TrendChart trend={a.trend} /> : <Empty testId="trend-empty">{t("Your score trend appears after your first released result.")}</Empty>}
          </Block>
          <Block title={t("Topic accuracy")} description={t("Weakest first. Topics with only a few answers are marked, not judged.")} icon={Target} testId="topics-card">
            {a.topics.length > 0 ? <TopicBars topics={a.topics} /> : <Empty testId="topics-empty">{t("Topic accuracy appears once an exam with tagged questions has been released to you.")}</Empty>}
          </Block>
          <Block title={t("Recent results")} icon={GraduationCap} testId="results-card">{has ? <RecentResults /> : <Empty>{t("No released results yet.")}</Empty>}</Block>
          <Block title={t("Recent AI feedback")} description={t("Written from your verified results. It never changes a score.")} icon={Bot} testId="feedback-card">
            {a.recentFeedback.length > 0 ? <FeedbackCards items={a.recentFeedback} /> : <Empty testId="feedback-empty">{rich("AI feedback appears here after a released result. You can turn automatic feedback on or off in {link}.", { link: <Link href="/settings/profile" className="font-medium text-primary underline">{t("your preferences")}</Link> })}</Empty>}
          </Block>
        </div>
        <div className="min-w-0 space-y-4">
          <Block title={t("Right and wrong")} description={t("Across all released results.")} icon={PieChart} testId="breakdown-card">
            {has ? <><BreakdownBar a={a} /><BandCounts a={a} /></> : <Empty>{t("No answers to count yet.")}</Empty>}
          </Block>
          <Block title={t("What to practise")} icon={Sparkles} testId="suggestions-card">{has ? <Suggestions a={a} /> : <Empty>{t("Suggestions are built from your results, so there is nothing to suggest yet.")}</Empty>}</Block>
          <Block title={t("Saved for study")} description={t("Your MCQ collections, CQ sets and notes.")} icon={ListChecks}><SavedContentCard saved={a.saved} /></Block>
          <Block title={t("Groups")} icon={Users}><GroupsCard groups={a.groups} /></Block>
        </div>
      </div>

      <section aria-labelledby="continue-h" className="rounded-2xl border bg-card p-5 shadow-card" data-testid="continue-learning">
        <h2 id="continue-h" className="mb-3 text-sm font-semibold">{t("Continue learning")}</h2>
        <div className="flex flex-wrap gap-2">
          {actions.map(({ href, label, icon: Icon }) => <Button key={href} asChild variant="outline" className="rounded-xl"><Link href={href}><Icon aria-hidden /> {t(label)}</Link></Button>)}
          <Button asChild variant="outline" className="rounded-xl"><Link href="/notifications"><Bell aria-hidden /> {t("Notifications")}{a.unreadNotifications > 0 && <span className="ml-1 rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums" aria-label={t("{count} unread", { count: a.unreadNotifications })}>{format.number(a.unreadNotifications)}</span>}</Link></Button>
        </div>
      </section>
    </div>
  );
}

/** Loads `GET /api/analytics/me` and renders every dashboard block with loading, error and empty states. */
export function DashboardAnalytics() {
  const t = useT();
  const q = useQuery({ queryKey: ["dashboard", "analytics"], queryFn: async () => readAnalytics(await apiGet("/api/analytics/me")), retry: 1, refetchInterval: (query) => (query.state.data?.recentFeedback.some((f) => f.status === "PENDING") ? 6000 : false) });
  if (q.isLoading) return <DashboardSkeleton />;
  if (q.isError || !q.data) {
    return (
      <Card className="rounded-2xl border-destructive/30" role="alert" data-testid="dashboard-error">
        <CardContent className="flex flex-wrap items-center gap-3 py-6">
          <p className="min-w-0 flex-1 text-sm"><span className="font-semibold">{t("Couldn't load your results and analytics.")}</span> {t("The rest of this page is unaffected.")}</p>
          <Button variant="outline" className="rounded-xl" onClick={() => void q.refetch()}>{t("Try again")}</Button>
        </CardContent>
      </Card>
    );
  }
  return <AnalyticsBody a={q.data} />;
}
