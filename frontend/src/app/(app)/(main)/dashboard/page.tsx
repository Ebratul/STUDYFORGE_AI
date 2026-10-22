import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, Bell, FileText, GraduationCap, MessagesSquare, MonitorSmartphone, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { backendJson, requireMe } from "@/lib/server/backend";
import { formatBytes } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

type Summary = {
  unread: number;
  sessions: number;
  providersConnected: number;
  documents: { total: number; ready: number; failed: number; processing: number; bytes: number };
  conversations: number;
  questionsAsked: number;
  usage: { tokens: number; requests: number; tokenLimit: number; requestLimit: number; resetsAt: string };
};

const PLANNED = [
  { label: "Exam scores and trends", part: 4 },
  { label: "Topic-wise performance", part: 4 },
  { label: "Correct vs incorrect answers", part: 4 },
  { label: "Saved collections and CQ sets", part: 3 },
  { label: "Group results and rankings", part: 5 },
];

export default async function DashboardPage() {
  await requireMe("/dashboard");
  const s = await backendJson<Summary>("/api/dashboard/summary");
  const pct = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);

  return (
    <>
      <PageHeader title="Dashboard" description="Everything here is calculated from your real data. Exam analytics appear once exams exist." />
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
          <EmptyState
            icon={GraduationCap}
            title="No exam activity yet"
            description="Scores, trends and topic performance will be calculated from your real attempts when exams are added."
            action={<Button asChild variant="outline" className="rounded-xl"><Link href="/exams">See exam plan</Link></Button>}
          />
        </div>
        <Card className="rounded-2xl shadow-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><BarChart3 className="size-4 text-primary" aria-hidden /> Planned analytics</CardTitle>
            <CardDescription>Not available yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5 text-sm">
              {PLANNED.map((p) => (
                <li key={p.label} className="flex items-center justify-between gap-2">
                  <span>{p.label}</span>
                  <Badge variant="outline" className="rounded-full text-[10px]">Part {p.part}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
