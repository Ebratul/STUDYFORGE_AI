"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Gauge, ServerCrash } from "lucide-react";
import { StatCard } from "@/components/common/stat-card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { formatCount, hourLabel, HOUR_OPTIONS, providerErrorRates, readMetrics, type BlockRow } from "@/lib/admin";
import { describeAdminError, metricsPath } from "@/lib/admin-api";
import { BarsWithTable } from "./charts";
import { Chip, ErrorLine, LoadingRows, Panel } from "./common";

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

function BlocksTable({ rows, caption, empty }: { rows: BlockRow[]; caption: string; empty: string }) {
  if (rows.length === 0) return <p className="p-5 text-sm text-muted-foreground">{empty}</p>;
  return (
    <Table scrollLabel={caption}>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader><TableRow><TableHead scope="col">Limiter</TableHead><TableHead scope="col" className="text-right">Blocked requests</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((r) => <TableRow key={r.label}><TableCell className="font-mono text-xs">{r.label}</TableCell><TableCell className="text-right tabular-nums">{formatCount(r.count)}</TableCell></TableRow>)}</TableBody>
    </Table>
  );
}

export function MetricsView() {
  const [hours, setHours] = useState<number>(24);
  const q = useQuery({ queryKey: ["admin", "metrics", hours], queryFn: async () => readMetrics(await apiGet(metricsPath(hours))), placeholderData: (p) => p });
  const m = q.data;
  const rates = m ? providerErrorRates(m.providers) : [];
  const blocked = m ? m.blocks.rateLimit.reduce((n, r) => n + r.count, 0) + m.blocks.quota.reduce((n, r) => n + r.count, 0) : 0;
  const hasApi = m ? m.api.some((p) => p.total > 0) : false;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">These are request <strong className="text-foreground">counts</strong> collected in hourly buckets. Latency is not measured, and nothing here identifies a user.</p>
        <fieldset className="flex shrink-0 items-center gap-1" aria-label="Time window">
          <legend className="sr-only">Time window</legend>
          {HOUR_OPTIONS.map((h) => (
            <label key={h} className="cursor-pointer">
              <input type="radio" name="hours" value={h} checked={hours === h} onChange={() => setHours(h)} className="peer sr-only" />
              <span className="inline-flex min-h-10 items-center whitespace-nowrap rounded-xl border px-3 text-sm font-medium peer-checked:border-primary peer-checked:bg-accent peer-checked:text-accent-foreground peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50">{h < 48 ? `${h} h` : `${h / 24} d`}</span>
            </label>
          ))}
        </fieldset>
      </div>

      {q.isLoading && <Panel id="m-load" title="Metrics"><LoadingRows rows={5} /></Panel>}
      {q.isError && <Panel id="m-err" title="Metrics"><ErrorLine message={describeAdminError(q.error)} /></Panel>}
      {m && (
        <div aria-busy={q.isFetching} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="API requests" value={formatCount(m.totals.requests)} icon={Activity} tone="violet" hint={`last ${m.hours} hours`} />
            <StatCard label="Client errors (4xx)" value={formatCount(m.totals.errors4xx)} icon={AlertTriangle} tone="amber" hint={pct(m.totals.errors4xx, m.totals.requests)} />
            <StatCard label="Server errors (5xx)" value={formatCount(m.totals.errors5xx)} icon={ServerCrash} tone={m.totals.errors5xx > 0 ? "amber" : "green"} hint={pct(m.totals.errors5xx, m.totals.requests)} />
            <StatCard label="Blocked by limits" value={formatCount(blocked)} icon={Gauge} tone="blue" hint="rate limits + quotas" />
          </div>

          <Panel id="m-api" title="API requests by status class" description="Requests per hour. 2xx succeeded, 3xx redirects, 4xx rejected because of the request, 5xx failed on the server.">
            {!hasApi ? <p className="p-5 text-sm text-muted-foreground" data-testid="metrics-empty">No API requests were recorded in this window yet.</p> : (
              <BarsWithTable
                testId="api-chart" stacked data={m.api.map((p) => ({ ...p }))} xKey="hour" xLabel="Hour" formatX={hourLabel}
                series={[{ key: "2xx", label: "2xx", color: "var(--chart-2)" }, { key: "3xx", label: "3xx", color: "var(--chart-1)" }, { key: "4xx", label: "4xx", color: "var(--chart-3)" }, { key: "5xx", label: "5xx", color: "var(--destructive)" }]}
                caption="API requests per hour by status class"
                summary={`${formatCount(m.totals.requests)} API requests in the last ${m.hours} hours: ${formatCount(m.totals.errors4xx)} client errors and ${formatCount(m.totals.errors5xx)} server errors.`}
              />
            )}
          </Panel>

          <Panel id="m-groups" title="Requests by area" description="Coarse route groups (no ids or paths with user data).">
            {m.apiByGroup.length === 0 ? <p className="p-5 text-sm text-muted-foreground">Nothing recorded in this window.</p> : (
              <Table data-testid="group-table" scrollLabel="API requests by route group and status class">
                <TableCaption className="sr-only">API requests by route group and status class</TableCaption>
                <TableHeader><TableRow><TableHead scope="col">Area</TableHead><TableHead scope="col" className="text-right">Total</TableHead><TableHead scope="col" className="text-right">2xx</TableHead><TableHead scope="col" className="text-right">3xx</TableHead><TableHead scope="col" className="text-right">4xx</TableHead><TableHead scope="col" className="text-right">5xx</TableHead></TableRow></TableHeader>
                <TableBody>{m.apiByGroup.map((g) => <TableRow key={g.group}><TableCell className="font-mono text-xs">{g.group}</TableCell><TableCell className="text-right tabular-nums">{formatCount(g.total)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(g["2xx"])}</TableCell><TableCell className="text-right tabular-nums">{formatCount(g["3xx"])}</TableCell><TableCell className="text-right tabular-nums">{formatCount(g["4xx"])}</TableCell><TableCell className="text-right tabular-nums">{formatCount(g["5xx"])}</TableCell></TableRow>)}</TableBody>
              </Table>
            )}
          </Panel>

          <Panel id="m-prov" title="AI provider calls" description="Outcomes of calls made on behalf of users, by provider and task. Error codes are normalised categories, never provider text.">
            {m.providers.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No provider calls were recorded in this window.</p> : (
              <>
                <ul className="flex flex-wrap gap-2 border-b px-5 py-3" aria-label="Error rate per provider">
                  {rates.map((r) => (
                    <li key={r.provider}><Chip tone={r.rate !== null && r.rate > 0.1 ? "warning" : "muted"}>{r.provider}: {r.errors} of {r.calls} failed ({r.rate === null ? "—" : `${(r.rate * 100).toFixed(1)}%`})</Chip></li>
                  ))}
                </ul>
                <Table data-testid="provider-table" scrollLabel="Provider call outcomes">
                  <TableCaption className="sr-only">Provider call outcomes</TableCaption>
                  <TableHeader><TableRow><TableHead scope="col">Provider</TableHead><TableHead scope="col">Task</TableHead><TableHead scope="col" className="text-right">Succeeded</TableHead><TableHead scope="col" className="text-right">Failed</TableHead><TableHead scope="col" className="text-right">Error rate</TableHead><TableHead scope="col">Error codes</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {m.providers.map((r) => (
                      <TableRow key={`${r.provider}|${r.task}`}>
                        <TableCell className="font-medium">{r.provider}</TableCell><TableCell>{r.task}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCount(r.ok)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCount(r.error)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.errorRate === null ? "—" : `${(r.errorRate * 100).toFixed(1)}%`}</TableCell>
                        <TableCell className="text-xs">{r.byCode.length === 0 ? "—" : r.byCode.map((c) => <span key={c.code} className="mr-2 inline-block whitespace-nowrap font-mono">{c.code} ×{c.count}</span>)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            )}
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel id="m-rl" title="Rate-limit blocks" description="Requests rejected by a rate limiter, per limiter."><BlocksTable rows={m.blocks.rateLimit} caption="Rate-limit blocks per limiter" empty="Nothing was rate limited in this window." /></Panel>
            <Panel id="m-quota" title="Quota blocks" description="Requests rejected because a daily or monthly AI quota was used up."><BlocksTable rows={m.blocks.quota} caption="Quota blocks" empty="No quota blocks in this window." /></Panel>
          </div>
        </div>
      )}
    </div>
  );
}
