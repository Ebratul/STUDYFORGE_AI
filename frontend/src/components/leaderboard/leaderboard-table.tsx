"use client";

import { Medal } from "lucide-react";
import { StatusChip } from "@/components/groups/badges";
import { formatPercent, formatScore, isMedalRank, isZeroScore, rankAriaLabel, rankText, type LeaderboardEntry } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const MEDAL_NAME = ["", msg("1st place"), msg("2nd place"), msg("3rd place")];

/** Rank is exactly what the server sent (ties share a number; the next skips). Medals add a shape + text, never only colour. */
export function RankCell({ rank }: { rank: number | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold tabular-nums" data-testid="rank">
      {isMedalRank(rank) ? <Medal className="size-4" aria-hidden /> : <span className="size-4" aria-hidden />}
      <span aria-hidden="true">{rankText(rank, i18n)}</span>
      <span className="sr-only">{rankAriaLabel(rank, t)}{isMedalRank(rank) ? `, ${t(MEDAL_NAME[rank as number]!)}` : ""}</span>
    </span>
  );
}

export function LeaderboardTable({ items }: { items: LeaderboardEntry[] }) {
  const i18n = useI18n();
  const { t, format } = i18n;
  return (
    <div className="overflow-x-auto" role="region" aria-label={t("Leaderboard table")} tabIndex={0}>
      <table className="w-full min-w-[34rem] text-sm" data-testid="leaderboard-table">
        <caption className="sr-only">{t("Ranked participants with score, percentage, status and submission time")}</caption>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-4 py-2.5 font-medium">{t("Rank")}</th>
            <th scope="col" className="px-4 py-2.5 font-medium">{t("Participant")}</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">{t("Score")}</th>
            <th scope="col" className="px-4 py-2.5 text-right font-medium">{t("Percentage")}</th>
            <th scope="col" className="px-4 py-2.5 font-medium">{t("Status")}</th>
            <th scope="col" className="px-4 py-2.5 font-medium">{t("Submitted")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.entryId} className={cn("border-b last:border-0", e.isSelf && "bg-accent/50")} data-testid="leaderboard-row" data-self={e.isSelf || undefined} data-rank={e.rank ?? ""}>
              <td className="px-4 py-3"><RankCell rank={e.rank} /></td>
              <td className="max-w-[14rem] px-4 py-3">
                <span className="block truncate font-medium">{t(e.displayName)}</span>
                {e.isSelf && <span className="mt-0.5 inline-block rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">{t("You")}</span>}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{formatScore(e, i18n)}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums">
                {formatPercent(e.percentBp, i18n)}
                {isZeroScore(e) && <span className="ml-2 rounded-full border px-1.5 py-0.5 text-xs font-normal" title={t("Finalized with no marks: different from not started or in progress")}>{t("Zero score")}</span>}
              </td>
              <td className="px-4 py-3"><StatusChip status={e.status} /></td>
              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground"><time dateTime={e.submittedAt ?? undefined} suppressHydrationWarning>{e.submittedAt ? format.dateTime(e.submittedAt) : "—"}</time></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
