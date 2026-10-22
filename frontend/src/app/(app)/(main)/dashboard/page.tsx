import type { Metadata } from "next";
import Link from "next/link";
import { Award, Bell, CalendarClock, FileText, GraduationCap, MessagesSquare, MonitorSmartphone, Sparkles, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { backendJson, requireMe } from "@/lib/server/backend";
import { formatBytes } from "@/lib/format";
import { BAND_INFO, BAND_ORDER, formatDateTime, formatPercentBp, type FeedbackBand } from "@/lib/exams";

export const metadata: Metadata = { title: "Dashboard" };

type Summary = {
  unread: number;
  sessions: number;
  providersConnected: number;
  documents: { total: number; ready: number; failed: number; processing: number; bytes: number };
  conversations: number;
  questionsAsked: number;
  usage: { tokens: number; requests: number; tokenLimit: number; requestLimit: number; resetsAt: string };
  /** Real exam figures (released results only). Absent when the server predates exams. */
  exams?: {
    attempts: number;
    finalized: number;
    averagePercentBp: number | null;
    best: number | null;
    byBand: Partial<Record<FeedbackBand, number>>;
    recent: { attemptId: string; examId: string; title: string; percentBp: number; band: FeedbackBand; finalizedAt: string }[];
    upcoming: { examId: string; title: string; opensAt?: string | null; closesAt?: string | null }[];
    groups?: number;
  };
};

export default async function DashboardPage() {
  await requireMe("/dashboard");
  const s = await backendJson<Summary>("/api/dashboard/summary");
  const pct = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);

  return (
    <>
      <PageHeader title="Dashboard" description="Everything here is calculated from your real data — exam figures use only results that have been released to you." />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Documents ready" value={s.documents.ready} icon={FileText} tone="violet" hint={`${s.documents.total} uploaded · ${formatBytes(s.documents.bytes)}`} />
        <StatCard label="Conversations" value={s.conversations} icon={MessagesSquare} tone="green" hint={`${s.questionsAsked} questions asked`} />
        <StatCard label="Unread notifications" value={s.unread} icon={Bell} tone="amber" hint={s.unread ? "Open the notification centre" : "You're all caught up"} />
        <StatCard label="Signed-in devices" value={s.sessions} icon={MonitorSmartphone} tone="blue" hint="Manage in Privacy & account" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="rounded-2xl shadow-card">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" aria-hidden /> AI usage today</CardTitle>
              <CardDescription>Limits protect your provider budget. They reset at {new Date(s.usage.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (UTC midnight).</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              {[
                { label: "Requests", used: s.usage.requests, limit: s.usage.requestLimit },
                { label: "Tokens", used: s.usage.tokens, limit: s.usage.tokenLimit },
              ].map((m) => (
                <div key={m.label}>
                  <div className="mb-1.5 flex justify-between text-sm"><span className="font-medium">{m.label}</span><span className="text-muted-foreground">{m.used.toLocaleString()} / {m.limit ? m.limit.toLocaleString() : "∞"}</span></div>
                  <Progress value={pct(m.used, m.limit)} aria-label={`${m.label} used today`} />
                </div>
              ))}
              {s.providersConnected === 0 && (
                <p className="text-sm text-muted-foreground sm:col-span-2">No provider connected yet. <Link href="/settings/api-keys" className="text-primary underline">Add an API key</Link> to start.</p>
              )}
            </CardContent>
          </Card>
          <ExamPerformance exams={s.exams} />
        </div>
        <UpcomingCard exams={s.exams} />
      </div>
    </>
  );
}

function ExamPerformance({ exams }: { exams: Summary["exams"] }) {
  if (!exams || exams.finalized === 0) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="No exam results yet"
        description="Scores, trends and band counts are calculated from your real attempts once you've taken an exam and its results are released."
        action={<Button asChild variant="outline" className="rounded-xl"><Link href="/exams">Go to exams</Link></Button>}
      />
    );
  }
  const total = BAND_ORDER.reduce((n, b) => n + (exams.byBand[b] ?? 0), 0) || 1;
  return (
    <Card className="rounded-2xl shadow-card" data-testid="exam-performance">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Target className="size-4 text-primary" aria-hidden /> Exam performance</CardTitle>
        <CardDescription>{exams.finalized} finished {exams.finalized === 1 ? "attempt" : "attempts"} · average {exams.averagePercentBp !== null ? formatPercentBp(exams.averagePercentBp) : "—"} · best {exams.best !== null ? formatPercentBp(exams.best) : "—"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="space-y-2" aria-label="Results by band">
          {BAND_ORDER.map((b) => {
            const n = exams.byBand[b] ?? 0;
            return (
              <li key={b} className="grid grid-cols-[9rem_1fr_2rem] items-center gap-3 text-sm">
                <span className="truncate">{BAND_INFO[b].label}</span>
                <Progress value={(n / total) * 100} aria-label={`${BAND_INFO[b].label}: ${n}`} className="h-2" />
                <span className="text-right tabular-nums text-muted-foreground">{n}</span>
              </li>
            );
          })}
        </ul>
        {exams.recent.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">Recent results</h3>
            <ul className="divide-y text-sm">
              {exams.recent.map((r) => (
                <li key={r.attemptId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/attempts/${r.attemptId}/result`} className="min-w-0 truncate font-medium hover:underline">{r.title}</Link>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground"><Badge variant="outline" className="rounded-full">{BAND_INFO[r.band].label}</Badge><span className="tabular-nums text-foreground">{formatPercentBp(r.percentBp)}</span> · {formatDateTime(r.finalizedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UpcomingCard({ exams }: { exams: Summary["exams"] }) {
  const up = exams?.upcoming ?? [];
  return (
    <Card className="rounded-2xl shadow-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="size-4 text-primary" aria-hidden /> Coming up</CardTitle>
        <CardDescription>Exams you can take soon.</CardDescription>
      </CardHeader>
      <CardContent>
        {up.length === 0 ? <p className="text-sm text-muted-foreground">Nothing scheduled. <Link href="/exams" className="text-primary underline">Browse exams</Link></p> : (
          <ul className="space-y-2.5 text-sm">
            {up.map((u) => (
              <li key={u.examId}>
                <Link href={`/exams/${u.examId}`} className="font-medium hover:underline">{u.title}</Link>
                <p className="text-xs text-muted-foreground">{u.opensAt ? `Opens ${formatDateTime(u.opensAt)}` : u.closesAt ? `Closes ${formatDateTime(u.closesAt)}` : "Open now"}</p>
              </li>
            ))}
          </ul>
        )}
        {exams?.groups !== undefined && <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground"><Award className="size-3.5" aria-hidden /> In {exams.groups} {exams.groups === 1 ? "group" : "groups"}</p>}
      </CardContent>
    </Card>
  );
}
