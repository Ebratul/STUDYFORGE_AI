"use client";

import { useQuery } from "@tanstack/react-query";
import { StatusChip } from "@/components/groups/badges";
import { apiGet } from "@/lib/api";
import { formatPercent, readParticipants } from "@/lib/leaderboard";

/** Participation list for exam staff. Anyone else gets a 404 from the API and simply sees nothing here. */
export function ParticipantsView({ examId }: { examId: string }) {
  const q = useQuery({ queryKey: ["exam-participants", examId], queryFn: async () => readParticipants(await apiGet(`/api/exams/${examId}/participants`)), retry: false });
  if (!q.data || q.data.items.length === 0) return null;
  return (
    <section className="rounded-2xl border bg-card shadow-card" aria-labelledby="part-h" data-testid="participants">
      <div className="border-b px-5 py-3"><h2 id="part-h" className="text-base font-semibold">Participation (staff view)</h2><p className="text-xs text-muted-foreground">Only who has started or finished. In-progress answers are never shown.</p></div>
      <ul className="divide-y">
        {q.data.items.map((p, i) => (
          <li key={`${p.displayName}-${i}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
            <span className="min-w-0 truncate font-medium">{p.displayName}{p.isSelf && " (you)"}</span>
            <span className="flex items-center gap-3">{p.percentBp !== null && <span className="tabular-nums text-muted-foreground">{formatPercent(p.percentBp)}</span>}<StatusChip status={p.status} /></span>
          </li>
        ))}
      </ul>
    </section>
  );
}
