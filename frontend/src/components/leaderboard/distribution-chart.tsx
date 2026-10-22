"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { distributionSummary, distributionTotal, SHORT_BAND, type DistributionBand } from "@/lib/leaderboard";
import { useI18n } from "@/lib/i18n/client";

const COLORS = ["var(--destructive)", "var(--chart-4)", "var(--chart-3)", "var(--chart-2)", "var(--chart-1)"];

/**
 * Score distribution over the five percentage bands, straight from the server's counts.
 * The SVG is a visual duplicate (aria-hidden); the list underneath carries the same numbers as text, so nothing depends on colour or vision.
 */
export function DistributionChart({ distribution }: { distribution: DistributionBand[] }) {
  const i18n = useI18n();
  const { t, format } = i18n;
  const total = distributionTotal(distribution);
  const data = distribution.map((d) => ({ ...d, label: t(d.label), short: format.locale === "en" ? SHORT_BAND[d.band] : SHORT_BAND[d.band].replace(/\d+/g, (n) => format.number(Number(n))) }));
  const max = Math.max(1, ...distribution.map((d) => d.count));
  return (
    <figure aria-label={t("Score distribution")} data-testid="distribution">
      <figcaption className="sr-only">{distributionSummary(distribution, i18n)}</figcaption>
      <div aria-hidden="true" className="h-60 w-full" data-testid="distribution-chart">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={data} margin={{ top: 20, right: 8, left: -12, bottom: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="short" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} interval={0} label={{ value: t("Percentage band (%)"), position: "insideBottom", offset: -2, fill: "var(--muted-foreground)", fontSize: 11 }} height={44} />
            <YAxis allowDecimals={false} domain={[0, Math.max(max, 3)]} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} width={36} />
            <Tooltip cursor={{ fill: "var(--accent)", opacity: 0.5 }} contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 12 }} formatter={(v) => [format.number(Number(v)), t("Participants")]} labelFormatter={(_l, p) => p?.[0]?.payload?.label ?? ""} />
            <Bar dataKey="count" radius={[8, 8, 0, 0]} isAnimationActive={false}>
              {data.map((d, i) => <Cell key={d.band} fill={COLORS[i]} />)}
              <LabelList dataKey="count" position="top" fill="var(--foreground)" fontSize={12} fontWeight={600} formatter={(v: unknown) => format.number(Number(v))} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2 2xl:grid-cols-5" data-testid="distribution-list">
        {distribution.map((d, i) => (
          <li key={d.band} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1">
            <span className="flex items-center gap-2"><span className="size-2.5 shrink-0 rounded-sm" style={{ background: COLORS[i] }} aria-hidden /> {t(d.label)}</span>
            <span className="font-semibold tabular-nums">{format.number(d.count)}{total > 0 && <span className="ml-1 text-xs font-normal text-muted-foreground">({format.number(Math.round((d.count / total) * 100))}%)</span>}</span>
          </li>
        ))}
      </ul>
      {total === 0 && <p className="mt-2 text-sm text-muted-foreground">{t("No finalized scores yet, so there's nothing to chart.")}</p>}
    </figure>
  );
}
