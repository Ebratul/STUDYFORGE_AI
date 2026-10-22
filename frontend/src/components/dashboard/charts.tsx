"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BAND_INFO } from "@/lib/bands";
import { formatAccuracy, trendChartData, type TrendPoint } from "@/lib/analytics";
import { useI18n, useT } from "@/lib/i18n/client";

/** Score trend over time. The SVG is decorative; the same numbers are available as a visible, keyboard-reachable table. */
export function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const t = useT();
  const { format } = useI18n();
  const data = trendChartData(trend, format);
  if (data.length === 0) return null;
  const first = data[0]!;
  const last = data[data.length - 1]!;
  const summary = data.length === 1
    ? t("One result: {percent} in {exam}.", { percent: format.percentBp(Math.round(first.pct * 100)), exam: first.examTitle })
    : t("{count} results from {from} to {to}. First {first}, latest {latest}.", { count: data.length, from: first.label, to: last.label, first: format.percentBp(Math.round(first.pct * 100)), latest: format.percentBp(Math.round(last.pct * 100)) });
  return (
    <div data-testid="trend-chart">
      <div role="img" aria-label={t("Score trend. {summary}", { summary })} className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart accessibilityLayer={false} data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" fontSize={12} tickMargin={6} />
            <YAxis domain={[0, 100]} tickFormatter={(v) => `${format.number(v)}%`} fontSize={12} width={44} />
            <Tooltip content={<TrendTip />} />
            <Line type="monotone" dataKey="pct" stroke="var(--chart-1)" strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-2 text-sm">
        <summary className="inline-flex min-h-8 cursor-pointer items-center rounded-md px-1 text-xs font-medium text-primary focus-visible:outline-2 focus-visible:outline-ring">{t("Show the data as a table")}</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-xl border">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("Score trend, oldest first")}</caption>
            <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="px-3 py-2 font-medium">{t("Date")}</th><th scope="col" className="px-3 py-2 font-medium">{t("Exam")}</th><th scope="col" className="px-3 py-2 text-right font-medium">{t("Score")}</th></tr></thead>
            <tbody>
              {trend.map((p, i) => (
                <tr key={p.attemptId || i} className="border-t">
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{data[i]!.fullDate || "—"}</td>
                  <td className="px-3 py-1.5">{p.examTitle}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatAccuracy(p.percentBp, undefined, { t, format })}{p.band && <span className="ml-1.5 text-xs text-muted-foreground">({t(BAND_INFO[p.band].label)})</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function TrendTip({ active, payload }: { active?: boolean; payload?: { payload: ReturnType<typeof trendChartData>[number] }[] }) {
  const { t, format } = useI18n();
  const d = active ? payload?.[0]?.payload : null;
  if (!d) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-semibold">{d.examTitle}</p>
      <p className="text-muted-foreground">{d.fullDate}</p>
      <p className="mt-0.5 tabular-nums">{format.percentBp(Math.round(d.pct * 100))}{d.band ? ` · ${t(BAND_INFO[d.band].label)}` : ""}</p>
    </div>
  );
}
