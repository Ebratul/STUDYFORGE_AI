"use client";

import { useQuery } from "@tanstack/react-query";
import { Cpu, FileText, HardDrive, Timer } from "lucide-react";
import { StatCard } from "@/components/common/stat-card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { formatAge, formatCount, readUsage, sumTasks, type TaskUsage } from "@/lib/admin";
import { describeAdminError } from "@/lib/admin-api";
import { BarsWithTable } from "./charts";
import { ErrorLine, LoadingRows, Panel } from "./common";

const label = (k: string) => k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, " ");

/** Joins the 7- and 30-day per-task figures into one row per task. */
export function mergeTasks(d7: TaskUsage[], d30: TaskUsage[]): { task: string; tokens7: number; tokens30: number; requests7: number; requests30: number }[] {
  const tasks = [...new Set([...d7, ...d30].map((t) => t.task))].sort();
  return tasks.map((task) => {
    const a = d7.find((t) => t.task === task);
    const b = d30.find((t) => t.task === task);
    return { task, tokens7: a?.tokens ?? 0, tokens30: b?.tokens ?? 0, requests7: a?.requests ?? 0, requests30: b?.requests ?? 0 };
  });
}

export function UsageView() {
  const q = useQuery({ queryKey: ["admin", "usage"], queryFn: async () => readUsage(await apiGet("/api/admin/usage")) });
  if (q.isLoading) return <Panel id="usage-h" title="Usage"><LoadingRows rows={5} /></Panel>;
  if (q.isError) return <Panel id="usage-h" title="Usage"><ErrorLine message={describeAdminError(q.error)} /></Panel>;
  const u = q.data!;
  const rows = mergeTasks(u.ai.d7, u.ai.d30);
  const t7 = sumTasks(u.ai.d7);
  const t30 = sumTasks(u.ai.d30);
  const maxBytes = Math.max(1, ...u.topUsers.map((x) => x.bytes));
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Documents" value={formatCount(u.documents.total)} icon={FileText} tone="violet" />
        <StatCard label="Storage used" value={formatBytes(u.documents.bytes)} icon={HardDrive} tone="blue" />
        <StatCard label="Avg. processing time" value={u.ingestion.avgSeconds === null ? "—" : formatAge(u.ingestion.avgSeconds)} icon={Timer} tone="amber" hint={u.ingestion.avgSeconds === null ? "No processed documents yet" : undefined} />
        <StatCard label="AI tokens (30 days)" value={formatCount(t30.tokens)} icon={Cpu} tone="green" hint={`${formatCount(t7.tokens)} in the last 7 days`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel id="us-docs" title="Documents by status" description="Counts only: names and contents are not available here.">
          {u.documents.byStatus.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No documents have been uploaded.</p> : (
            <Table scrollLabel="Documents by processing status">
              <TableCaption className="sr-only">Documents by processing status</TableCaption>
              <TableHeader><TableRow><TableHead scope="col">Status</TableHead><TableHead scope="col" className="text-right">Documents</TableHead></TableRow></TableHeader>
              <TableBody>{u.documents.byStatus.map((s) => <TableRow key={s.key}><TableCell>{label(s.key)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(s.count)}</TableCell></TableRow>)}</TableBody>
            </Table>
          )}
        </Panel>
        <Panel id="us-ingest" title="Processing jobs" description="Document ingestion jobs by status.">
          {u.ingestion.byStatus.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No processing jobs have run yet.</p> : (
            <Table scrollLabel="Ingestion jobs by status">
              <TableCaption className="sr-only">Ingestion jobs by status</TableCaption>
              <TableHeader><TableRow><TableHead scope="col">Status</TableHead><TableHead scope="col" className="text-right">Jobs</TableHead></TableRow></TableHeader>
              <TableBody>{u.ingestion.byStatus.map((s) => <TableRow key={s.key}><TableCell>{label(s.key)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(s.count)}</TableCell></TableRow>)}</TableBody>
            </Table>
          )}
        </Panel>
      </div>

      <Panel id="us-top" title="Top storage users" description="The ten accounts using the most storage (names and sizes only).">
        {u.topUsers.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No stored files yet.</p> : (
          <Table data-testid="top-users" scrollLabel="Accounts by storage used">
            <TableCaption className="sr-only">Accounts by storage used</TableCaption>
            <TableHeader><TableRow><TableHead scope="col">Account</TableHead><TableHead scope="col" className="w-1/2">Share of the largest</TableHead><TableHead scope="col" className="text-right">Storage</TableHead></TableRow></TableHeader>
            <TableBody>
              {u.topUsers.map((x) => (
                <TableRow key={x.id || x.name}>
                  <TableCell className="font-medium">{x.name}</TableCell>
                  <TableCell><div className="h-2 rounded-full bg-muted" aria-hidden><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(2, Math.round((x.bytes / maxBytes) * 100))}%` }} /></div></TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(x.bytes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel id="us-ai" title="AI usage by task" description="Tokens and requests as reported by providers, summed over all users. No cost is estimated.">
        {rows.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No AI requests have been recorded yet.</p> : (
          <>
            <BarsWithTable
              testId="ai-usage-chart"
              data={rows.map((r) => ({ task: label(r.task), tokens7: r.tokens7, tokens30: r.tokens30 }))}
              xKey="task" xLabel="Task"
              series={[{ key: "tokens7", label: "Tokens, last 7 days", color: "var(--chart-1)" }, { key: "tokens30", label: "Tokens, last 30 days", color: "var(--chart-2)" }]}
              caption="AI tokens by task" summary={`AI tokens by task. Last 30 days: ${rows.map((r) => `${label(r.task)} ${formatCount(r.tokens30)}`).join(", ")}.`}
            />
            <Table scrollLabel="AI requests and tokens by task">
              <TableCaption className="sr-only">AI requests and tokens by task</TableCaption>
              <TableHeader><TableRow><TableHead scope="col">Task</TableHead><TableHead scope="col" className="text-right">Requests (7 d)</TableHead><TableHead scope="col" className="text-right">Tokens (7 d)</TableHead><TableHead scope="col" className="text-right">Requests (30 d)</TableHead><TableHead scope="col" className="text-right">Tokens (30 d)</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => <TableRow key={r.task}><TableCell className="font-medium">{label(r.task)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(r.requests7)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(r.tokens7)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(r.requests30)}</TableCell><TableCell className="text-right tabular-nums">{formatCount(r.tokens30)}</TableCell></TableRow>)}
              </TableBody>
            </Table>
          </>
        )}
      </Panel>
    </div>
  );
}
