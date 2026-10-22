"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiGet, apiSend } from "@/lib/api";
import { canManageJobs, formatAge, formatCount, JOB_STATUSES, readJobs, type AdminRole, type JobFailure } from "@/lib/admin";
import { describeAdminError } from "@/lib/admin-api";
import { Chip, ErrorLine, LoadingRows, Panel } from "./common";

const label = (k: string) => k.charAt(0) + k.slice(1).toLowerCase();

export function JobsView({ role }: { role: AdminRole }) {
  const qc = useQueryClient();
  const mayRetry = canManageJobs(role);
  const [retrying, setRetrying] = useState<JobFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin", "jobs"], queryFn: async () => readJobs(await apiGet("/api/admin/jobs")), refetchInterval: 15_000 });
  const retry = useMutation({
    mutationFn: (j: JobFailure) => apiSend("POST", `/api/admin/jobs/${encodeURIComponent(j.id)}/retry`, {}),
    onSuccess: () => { setRetrying(null); setError(null); void qc.invalidateQueries({ queryKey: ["admin"] }); toast.success("Job queued for another attempt"); },
    onError: (e) => setError(describeAdminError(e)),
  });

  if (q.isLoading) return <Panel id="jobs-h" title="Background jobs"><LoadingRows rows={5} /></Panel>;
  if (q.isError) return <Panel id="jobs-h" title="Background jobs"><ErrorLine message={describeAdminError(q.error)} /></Panel>;
  const j = q.data!;
  const statuses = [...JOB_STATUSES, ...Object.keys(j.totals).filter((s) => !(JOB_STATUSES as readonly string[]).includes(s))];
  return (
    <div className="space-y-6">
      <Panel id="jobs-h" title="Background jobs" description="Document processing, AI feedback, exam expiry and reminders. Refreshes every 15 seconds.">
        <div className="flex flex-wrap gap-2 border-b px-5 py-3" data-testid="job-totals">
          {statuses.map((s) => <Chip key={s} tone={s === "FAILED" && (j.totals[s] ?? 0) > 0 ? "danger" : "muted"}>{label(s)}: <strong className="tabular-nums">{formatCount(j.totals[s] ?? 0)}</strong></Chip>)}
          <Chip tone={j.oldestPendingSeconds !== null && j.oldestPendingSeconds > 300 ? "warning" : "muted"}>Oldest pending: <strong>{j.oldestPendingSeconds === null ? "none waiting" : formatAge(j.oldestPendingSeconds)}</strong></Chip>
        </div>
        {j.matrix.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No jobs have been recorded yet.</p> : (
          <Table data-testid="jobs-matrix" scrollLabel="Jobs by type and status">
            <TableCaption className="sr-only">Jobs by type and status</TableCaption>
            <TableHeader><TableRow><TableHead scope="col">Type</TableHead>{statuses.map((s) => <TableHead scope="col" key={s} className="text-right">{label(s)}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {j.matrix.map((r) => <TableRow key={r.type}><TableCell className="font-mono text-xs">{r.type}</TableCell>{statuses.map((s) => <TableCell key={s} className="text-right tabular-nums">{formatCount(r.counts[s] ?? 0)}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        )}
      </Panel>

      <Panel id="jobs-fail" title="Recent failures" description="Error text is redacted and truncated by the server. Results of exams and other user data are never changed by a failed job.">
        {j.failures.length === 0 ? <p className="p-5 text-sm text-muted-foreground" data-testid="no-failures">No failed jobs. Nothing needs attention.</p> : (
          <Table data-testid="failures-table" scrollLabel="Recently failed jobs">
            <TableCaption className="sr-only">Recently failed jobs</TableCaption>
            <TableHeader><TableRow><TableHead scope="col">Type</TableHead><TableHead scope="col" className="text-right">Attempts</TableHead><TableHead scope="col">Last error</TableHead><TableHead scope="col">When</TableHead>{mayRetry && <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>}</TableRow></TableHeader>
            <TableBody>
              {j.failures.map((f) => (
                <TableRow key={f.id} data-testid="failure-row">
                  <TableCell className="font-mono text-xs">{f.type}</TableCell>
                  <TableCell className="text-right tabular-nums">{f.attempts}{f.maxAttempts > 0 ? ` / ${f.maxAttempts}` : ""}</TableCell>
                  <TableCell className="max-w-96 break-words text-xs text-muted-foreground">{f.lastError || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{f.updatedAt ? new Date(f.updatedAt).toLocaleString() : "—"}</TableCell>
                  {mayRetry && <TableCell><Button size="sm" variant="outline" className="rounded-xl" onClick={() => { setError(null); setRetrying(f); }}><RotateCcw aria-hidden /> Retry<span className="sr-only"> {f.type} job</span></Button></TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      {retrying && (
        <Dialog open onOpenChange={(o) => { if (!o && !retry.isPending) setRetrying(null); }}>
          <DialogContent>
            <DialogHeader><DialogTitle>Retry this job?</DialogTitle><DialogDescription>The <span className="font-mono">{retrying.type}</span> job will be queued for a fresh attempt. Jobs are idempotent, so this cannot create duplicate results. The action is recorded in the audit log.</DialogDescription></DialogHeader>
            {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{error}</p>}
            <DialogFooter>
              <Button variant="outline" className="rounded-xl" onClick={() => setRetrying(null)} disabled={retry.isPending}>Cancel</Button>
              <Button className="rounded-xl" onClick={() => retry.mutate(retrying)} disabled={retry.isPending}>{retry.isPending && <Loader2 className="animate-spin" aria-hidden />} Retry job</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
