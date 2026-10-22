import type { Metadata } from "next";
import Link from "next/link";
import { Bell, CalendarClock, FileText, MessagesSquare, MonitorSmartphone, Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { DashboardAnalytics } from "@/components/dashboard/dashboard-analytics";
import { PageHeader } from "@/components/common/page-header";
import { StatCard } from "@/components/common/stat-card";
import { backendJson, requireMe } from "@/lib/server/backend";
import { formatBytes } from "@/lib/format";
import { usageBar } from "@/lib/usage";
import { getI18n, getRich } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Dashboard" };

type Summary = {
  unread: number;
  sessions: number;
  providersConnected: number;
  documents: { total: number; ready: number; failed: number; processing: number; bytes: number };
  conversations: number;
  questionsAsked: number;
  usage: { tokens: number; requests: number; tokenLimit: number; requestLimit: number; resetsAt: string };
  exams?: { upcoming: { examId: string; title: string; opensAt?: string | null; closesAt?: string | null }[] };
};

export default async function DashboardPage() {
  const i18n = await getI18n();
  const { t } = i18n;
  const rich = await getRich();
  await requireMe("/dashboard");
  const s = await backendJson<Summary>("/api/dashboard/summary");

  return (
    <>
      <PageHeader title={t("Dashboard")} description={t("Everything here is calculated from your real data — exam figures use only results that have been released to you.")} />

      <div className="mb-6"><DashboardAnalytics /></div>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{t("Your workspace")}</h2>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("Documents ready")} value={s.documents.ready} icon={FileText} tone="violet" hint={t("{total} uploaded · {size}", { total: s.documents.total, size: formatBytes(s.documents.bytes) })} />
        <StatCard label={t("Conversations")} value={s.conversations} icon={MessagesSquare} tone="green" hint={t("{count, plural, one {# question asked} other {# questions asked}}", { count: s.questionsAsked })} />
        <StatCard label={t("Unread notifications")} value={s.unread} icon={Bell} tone="amber" hint={s.unread ? t("Open the notification centre") : t("You're all caught up")} />
        <StatCard label={t("Signed-in devices")} value={s.sessions} icon={MonitorSmartphone} tone="blue" hint={t("Manage in Privacy & account")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="rounded-2xl shadow-card lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4 text-primary" aria-hidden /> {t("AI usage today")}</CardTitle>
            <CardDescription>{rich("Limits protect your provider budget. They reset at {time} (UTC midnight). {link}", { time: i18n.format.time(s.usage.resetsAt), link: <Link href="/settings/providers" className="text-primary underline">{t("See full usage")}</Link> })}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            {[
              { label: t("Requests"), used: s.usage.requests, limit: s.usage.requestLimit },
              { label: t("Tokens"), used: s.usage.tokens, limit: s.usage.tokenLimit },
            ].map((m) => {
              const bar = usageBar(m.used, m.limit, i18n);
              return (
                <div key={m.label}>
                  <div className="mb-1.5 flex justify-between text-sm"><span className="font-medium">{m.label}</span><span className="text-muted-foreground">{bar.label}</span></div>
                  <Progress value={bar.pct} aria-label={t("{label} used today", { label: m.label })} />
                </div>
              );
            })}
            {s.providersConnected === 0 && (
              <p className="text-sm text-muted-foreground sm:col-span-2">{rich("No provider connected yet. {link} to start.", { link: <Link href="/settings/api-keys" className="text-primary underline">{t("Add an API key")}</Link> })}</p>
            )}
          </CardContent>
        </Card>
        <Card className="rounded-2xl shadow-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="size-4 text-primary" aria-hidden /> {t("Coming up")}</CardTitle>
            <CardDescription>{t("Exams you can take soon.")}</CardDescription>
          </CardHeader>
          <CardContent>
            {(s.exams?.upcoming ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{t("Nothing scheduled.")} <Link href="/exams" className="text-primary underline">{t("Browse exams")}</Link></p> : (
              <ul className="space-y-2.5 text-sm">
                {s.exams!.upcoming.map((u) => (
                  <li key={u.examId}>
                    <Link href={`/exams/${u.examId}`} className="font-medium hover:underline">{u.title}</Link>
                    <p className="text-xs text-muted-foreground">{u.opensAt ? t("Opens {when}", { when: i18n.format.dateTime(u.opensAt) }) : u.closesAt ? t("Closes {when}", { when: i18n.format.dateTime(u.closesAt) }) : t("Open now")}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
