"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, GraduationCap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BandChip } from "@/components/common/band-chip";
import { apiGet } from "@/lib/api";
import { readResultsPage, type ResultRow } from "@/lib/analytics";
import { useFormat, useT } from "@/lib/i18n/client";

const PAGE_SIZE = 5;

export function ResultRows({ items }: { items: ResultRow[] }) {
  const t = useT();
  const format = useFormat();
  return (
    <ul className="divide-y text-sm" aria-label={t("Recent exam results")} data-testid="recent-results">
      {items.map((r) => (
        <li key={r.attemptId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5">
          <div className="min-w-0">
            <Link href={`/attempts/${r.attemptId}/result`} className="block truncate font-medium hover:underline">{r.examTitle}</Link>
            <p className="text-xs text-muted-foreground">{t("{when} · {correct} correct · {incorrect} incorrect · {unanswered} unanswered", { when: format.dateTime(r.finalizedAt), correct: r.correct, incorrect: r.incorrect, unanswered: r.unanswered })}</p>
          </div>
          <div className="flex items-center gap-2">
            <BandChip band={r.band} className="text-[11px]" />
            <span className="text-right tabular-nums"><span className="font-semibold">{format.percentBp(r.percentBp)}</span><span className="ml-1 text-xs text-muted-foreground">{format.centi(r.scoreCenti)}/{format.centi(r.maxCenti)}</span></span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Released results, newest first, paged by the server. */
export function RecentResults() {
  const t = useT();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["dashboard", "results", page], queryFn: async () => readResultsPage(await apiGet(`/api/analytics/me/results?page=${page}&pageSize=${PAGE_SIZE}`)), placeholderData: (prev) => prev, retry: 1 });
  if (q.isLoading) return <div className="space-y-2" role="status" aria-label={t("Loading results")}><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>;
  if (q.isError) return <p role="alert" className="text-sm text-destructive">{t("Couldn't load your results.")} <button className="font-medium underline" onClick={() => void q.refetch()}>{t("Try again")}</button></p>;
  const d = q.data!;
  if (d.items.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground"><GraduationCap className="size-5 shrink-0" aria-hidden /> {t("No released results yet.")}</div>
    );
  }
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  return (
    <div>
      <ResultRows items={d.items} />
      {pages > 1 && (
        <nav className="mt-3 flex items-center justify-between text-xs text-muted-foreground" aria-label={t("Results pages")}>
          <Button variant="outline" size="sm" className="rounded-lg" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft aria-hidden /> {t("Newer")}</Button>
          <span aria-live="polite">{t("Page {page} of {pages}", { page, pages })}</span>
          <Button variant="outline" size="sm" className="rounded-lg" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{t("Older")} <ChevronRight aria-hidden /></Button>
        </nav>
      )}
    </div>
  );
}
