"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, GraduationCap, Plus, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { ApiError, apiGet } from "@/lib/api";
import { canPublishGroupExam, describeGroupError, examLink, leaderboardLink, newGroupExamLink, readExamRow, readList, type GroupDetail } from "@/lib/groups";
import { formatPercent } from "@/lib/leaderboard";
import { StatusChip } from "./badges";

const PAGE_SIZE = 10;
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null);

export function ExamsTab({ group }: { group: GroupDetail }) {
  const [page, setPage] = useState(1);
  const exams = useQuery({
    queryKey: ["group", group.id, "exams", page],
    queryFn: async () => readList(await apiGet(`/api/groups/${group.id}/exams?page=${page}&pageSize=${PAGE_SIZE}`), readExamRow),
    placeholderData: (prev) => prev,
  });
  const data = exams.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const may = canPublishGroupExam(group.role);

  return (
    <section className="mt-4 rounded-2xl border bg-card shadow-card" aria-labelledby="gex-h">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <h2 id="gex-h" className="text-base font-semibold">Group exams</h2>
        {may && <Button asChild className="rounded-xl"><Link href={newGroupExamLink(group.id)}><Plus aria-hidden /> Create group exam</Link></Button>}
      </div>
      {exams.isLoading && <div className="space-y-2 p-5"><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></div>}
      {exams.isError && <p role="alert" className="p-5 text-sm text-destructive">{describeGroupError(exams.error instanceof ApiError ? exams.error : { code: "ERROR", message: "Couldn't load the exams." })}</p>}
      {data && data.items.length === 0 && (
        <div className="p-5"><EmptyState icon={GraduationCap} title="No group exams yet" description={may ? "Publish an exam from your question bank and everyone in the group takes the same questions." : "When an owner or admin publishes an exam, it will show up here."} /></div>
      )}
      {data && data.items.length > 0 && (
        <ul className="divide-y" data-testid="group-exam-list">
          {data.items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4" data-testid="group-exam-row">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2"><Link href={examLink(e.id)} className="break-words font-medium hover:underline focus-visible:rounded focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">{e.title}</Link>{e.status === "CANCELLED" && <span className="rounded-full border px-2 py-0.5 text-xs">Cancelled</span>}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {[e.questionCount !== null ? `${e.questionCount} questions` : null, e.totalMarks !== null ? `${e.totalMarks} marks` : null, e.durationMinutes !== null ? `${e.durationMinutes} min` : null, e.closesAt ? `closes ${dt(e.closesAt)}` : e.opensAt ? `opens ${dt(e.opensAt)}` : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              {e.participation && <StatusChip status={e.participation} />}
              {e.result?.released === true && e.result.percentBp !== null && <span className="text-sm font-semibold tabular-nums" data-testid="exam-result">{formatPercent(e.result.percentBp)}</span>}
              {e.result?.released === false && <span className="text-xs text-muted-foreground" data-testid="exam-result">Result not released yet</span>}
              {e.status !== "DRAFT" && (may || e.leaderboardVisible) && <Button asChild variant="outline" size="sm" className="rounded-xl"><Link href={leaderboardLink(e.id)}><Trophy aria-hidden /> Leaderboard</Link></Button>}
            </li>
          ))}
        </ul>
      )}
      {data && pages > 1 && (
        <nav aria-label="Exam pages" className="flex items-center justify-between border-t px-5 py-3">
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft aria-hidden /> Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page} of {pages}</span>
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight aria-hidden /></Button>
        </nav>
      )}
    </section>
  );
}
