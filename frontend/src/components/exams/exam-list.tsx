"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Clock, GraduationCap, ListChecks, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/common/empty-state";
import { ServiceError } from "@/components/common/service-error";
import { apiGet } from "@/lib/api";
import { formatDuration, formatMarks, formatPercentBp, type ExamSummary, type Paged } from "@/lib/exams";
import { ModeBadge, StatusBadge } from "./exam-badges";
import { useI18n, useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

type Scope = "mine" | "available" | "history";
const PAGE_SIZE = 10;
/** Inactive tabs need more contrast than the default muted text on the muted track. */
const TRIGGER = "data-[state=inactive]:text-foreground/80";
const COPY: Record<Scope, { title: string; description: string }> = {
  mine: { title: msg("You haven't created an exam yet"), description: msg("Pick questions from your question bank, set the rules, preview and publish.") },
  available: { title: msg("Nothing to take right now"), description: msg("Exams you can take — your own individual exams and exams published to your groups — appear here.") },
  history: { title: msg("No attempts yet"), description: msg("Exams you have taken will be listed here with your best result.") },
};

export function ExamList({ initialScope = "mine" }: { initialScope?: Scope }) {
  const t = useT();
  const [scope, setScope] = useState<Scope>(initialScope);
  return (
    <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
      <TabsList aria-label={t("Exam lists")}>
        <TabsTrigger value="mine" className={TRIGGER}>{t("My exams")}</TabsTrigger>
        <TabsTrigger value="available" className={TRIGGER}>{t("Available")}</TabsTrigger>
        <TabsTrigger value="history" className={TRIGGER}>{t("History")}</TabsTrigger>
      </TabsList>
      {(["mine", "available", "history"] as const).map((s) => (
        <TabsContent key={s} value={s} className="mt-3"><Panel scope={s} active={scope === s} /></TabsContent>
      ))}
    </Tabs>
  );
}

function Panel({ scope, active }: { scope: Scope; active: boolean }) {
  const t = useT();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ["exams", scope, page],
    queryFn: () => apiGet<Paged<ExamSummary>>(`/api/exams?scope=${scope}&page=${page}&pageSize=${PAGE_SIZE}`),
    enabled: active,
    staleTime: 10_000,
  });
  if (q.isLoading) return <div className="space-y-3" role="status"><span className="sr-only">{t("Loading exams…")}</span>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>;
  if (q.isError) return <ServiceError title={t("Couldn't load your exams")} message={t("Please try again in a moment.")} />;
  const data = q.data!;
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={scope === "history" ? Clock : GraduationCap}
        title={t(COPY[scope].title)}
        description={t(COPY[scope].description)}
        action={scope === "mine" ? <Button asChild className="rounded-xl"><Link href="/exams/new"><Plus aria-hidden /> {t("Create an exam")}</Link></Button> : undefined}
      />
    );
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <div>
      <ul className="space-y-3" data-testid={`exam-list-${scope}`}>
        {data.items.map((e) => <li key={e.id}><ExamCard exam={e} scope={scope} /></li>)}
      </ul>
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <Button variant="outline" size="sm" className="rounded-lg" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft aria-hidden /> {t("Previous")}</Button>
          <span className="text-muted-foreground">{t("Page {page} of {pages}", { page, pages })}</span>
          <Button variant="outline" size="sm" className="rounded-lg" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t("Next")} <ChevronRight aria-hidden /></Button>
        </div>
      )}
    </div>
  );
}

function ExamCard({ exam: e, scope }: { exam: ExamSummary; scope: Scope }) {
  const t = useT();
  const i18n = useI18n();
  const mine = e.myAttempts;
  const href = scope === "mine" && e.status === "DRAFT" ? `/exams/${e.id}/edit` : `/exams/${e.id}`;
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card p-4 shadow-card sm:p-5" aria-label={e.title}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold"><Link href={href} className="hover:underline focus-visible:underline">{e.title}</Link></h3>
          <StatusBadge status={e.status} />
          <ModeBadge mode={e.mode} group={e.group} />
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><ListChecks className="size-3.5" aria-hidden /> {t("{count, plural, one {# question} other {# questions}}", { count: e.questionCount })}{e.totalMarks !== null ? ` · ${t("{marks} marks", { marks: formatMarks(e.totalMarks, i18n) })}` : ""}</span>
          {e.durationMinutes !== null && <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden /> {formatDuration(e.durationMinutes, i18n)}</span>}
          {e.opensAt && <span>{t("Opens {when}", { when: i18n.format.dateTime(e.opensAt) })}</span>}
          {e.closesAt && <span>{t("Closes {when}", { when: i18n.format.dateTime(e.closesAt) })}</span>}
          {e.status === "DRAFT" && <span>{t("Edited {when}", { when: i18n.format.dateTime(e.updatedAt) })}</span>}
        </p>
        {mine && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Attempts {used} of {limit}", { used: mine.used, limit: mine.limit })}{mine.bestPercentBp !== null && <> {t("· best")} <span className="font-medium text-foreground">{formatPercentBp(mine.bestPercentBp, i18n)}</span></>}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {mine?.inProgressAttemptId ? (
          <Button asChild className="rounded-xl"><Link href={`/attempts/${mine.inProgressAttemptId}`}><Play aria-hidden /> {t("Resume")}</Link></Button>
        ) : (
          <Button asChild variant={scope === "available" ? "default" : "outline"} className="rounded-xl">
            <Link href={href}>{scope === "mine" && e.status === "DRAFT" ? t("Continue editing") : scope === "available" ? t("Open") : t("View")}</Link>
          </Button>
        )}
      </div>
    </article>
  );
}
