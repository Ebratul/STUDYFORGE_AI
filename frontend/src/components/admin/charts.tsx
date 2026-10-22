"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export type BarSeries = { key: string; label: string; color: string };

/**
 * Bar chart whose SVG is a visual duplicate (aria-hidden). The same numbers are always available as a real table inside the
 * figure, so nothing depends on vision or colour. `stacked` stacks the series; otherwise bars are grouped.
 */
export function BarsWithTable({ data, xKey, xLabel, series, caption, summary, stacked = false, formatX, testId }: {
  data: Record<string, string | number>[]; xKey: string; xLabel: string; series: BarSeries[]; caption: string; summary: string; stacked?: boolean; formatX?: (v: string) => string; testId?: string;
}) {
  const fx = (v: string | number) => (formatX ? formatX(String(v)) : String(v));
  return (
    <figure aria-label={caption} data-testid={testId} className="px-5 py-4">
      <figcaption className="sr-only">{summary}</figcaption>
      <div aria-hidden="true" className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey={xKey} tickFormatter={fx} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} minTickGap={16} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} width={44} />
            <Tooltip cursor={{ fill: "var(--accent)", opacity: 0.5 }} labelFormatter={(l) => fx(l as string)} contentStyle={{ background: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} stackId={stacked ? "a" : undefined} radius={stacked ? 0 : [6, 6, 0, 0]} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer rounded-md py-1 font-medium text-primary focus-visible:outline-2 focus-visible:outline-offset-2">Show the data as a table</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-xl border">
          <table className="w-full text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className="bg-muted/50 text-left"><tr><th scope="col" className="px-3 py-2 font-medium">{xLabel}</th>{series.map((s) => <th scope="col" key={s.key} className="px-3 py-2 text-right font-medium">{s.label}</th>)}</tr></thead>
            <tbody>
              {data.map((row) => (
                <tr key={String(row[xKey])} className="border-t">
                  <th scope="row" className="whitespace-nowrap px-3 py-1.5 text-left font-normal">{fx(row[xKey]!)}</th>
                  {series.map((s) => <td key={s.key} className="px-3 py-1.5 text-right tabular-nums">{Number(row[s.key] ?? 0).toLocaleString("en-US")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
