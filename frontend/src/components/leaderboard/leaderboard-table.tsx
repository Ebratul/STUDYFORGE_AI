import { Medal } from "lucide-react";
import { StatusChip } from "@/components/groups/badges";
import { formatPercent, formatScore, isMedalRank, isZeroScore, rankAriaLabel, rankText, type LeaderboardEntry } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";

const MEDAL_NAME = ["", "1st place", "2nd place", "3rd place"];

/** Rank is exactly what the server sent (ties share a number; the next skips). Medals add a shape + text, never only colour. */
export function RankCell({ rank }: { rank: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums" data-testid="rank">
      {isMedalRank(rank) ? <Medal className="size-4" aria-hidden /> : <span className="size-4" aria-hidden />}
      <span aria-hidden="true">{rankText(rank)}</span>
      <span className="sr-only">{rankAriaLabel(rank)}{isMedalRank(rank) ? `, ${MEDAL_NAME[rank as number]}` : ""}</span>
    </span>
  );
}

export function LeaderboardTable({ items }: { items: LeaderboardEntry[] }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label="Leaderboard table" tabIndex={0}>
      <table className="w-full min-w-[34rem] text-sm" data-testid="leaderboard-table">
        <caption className="sr-only">Ranked participants with score, percentage, status and submission time</caption>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">Rank</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Participant</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Score</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Percentage</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
            <th scope="col" className="px-4 py-2.5 font-medium">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.entryId} className={cn("border-b last:border-0", e.isSelf && "bg-accent/50")} data-testid="leaderboard-row" data-self={e.isSelf || undefined} data-rank={e.rank ?? ""}>
              <td className="px-4 py-3"><RankCell rank={e.rank} /></td>
              <td className="max-w-[14rem] px-4 py-3">
                <span className="block truncate font-medium">{e.displayName}</span>
                {e.isSelf && <span className="mt-0.5 inline-block rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">You</span>}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatScore(e)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">
                {formatPercent(e.percentBp)}
                {isZeroScore(e) && <span className="ml-2 rounded-full border px-1.5 py-0.5 text-xs font-normal" title="Finalized with no marks: different from not started or in progress">Zero score</span>}
              </td>
              <td className="px-4 py-3"><StatusChip status={e.status} /></td>
              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground"><time dateTime={e.submittedAt ?? undefined} suppressHydrationWarning>{e.submittedAt ? new Date(e.submittedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}</time></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
