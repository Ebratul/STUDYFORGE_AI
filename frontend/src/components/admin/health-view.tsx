"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAge, HEALTH_LABEL, type HealthView as Health } from "@/lib/admin";
import { HealthChip, Panel } from "./common";

function Row({ name, state, detail, testId }: { name: string; state: Health["overall"]; detail: React.ReactNode; testId: string }) {
  return (
    <li className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-center sm:justify-between" data-testid={testId}>
      <div className="min-w-0"><p className="font-medium">{name}</p><p className="text-sm text-muted-foreground">{detail}</p></div>
      <HealthChip state={state} />
    </li>
  );
}

/** Operational state of the platform's critical dependencies. Never shows URLs, credentials or configuration values. */
export function HealthView({ h }: { h: Health }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const q = h.queue;
  return (
    <div className="space-y-6">
      <div role="status" className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-card sm:flex-row sm:items-center sm:justify-between" data-testid="overall-health" data-state={h.overall}>
        <div className="flex items-center gap-3"><HealthChip state={h.overall} className="px-3 py-1 text-sm" /><p className="text-sm text-muted-foreground">
          {h.overall === "ok" ? "All checked services are responding." : h.overall === "unknown" || h.overall === "idle" ? "Some checks have no data yet." : `At least one service is ${HEALTH_LABEL[h.overall].toLowerCase()}. See the rows below.`}</p></div>
        <Button variant="outline" className="rounded-xl" onClick={() => start(() => router.refresh())} disabled={pending}><RefreshCw className={pending ? "animate-spin" : ""} aria-hidden /> Refresh</Button>
      </div>
      <Panel id="health-h" title="Services" description="Checked live when this page loads.">
        <ul className="divide-y">
          <Row testId="h-db" name="Database" state={h.database.state} detail={`PostgreSQL (accounts, exams, queue, vectors)${h.database.latencyMs !== null ? ` · responded in ${h.database.latencyMs} ms` : ""}`} />
          <Row testId="h-rag" name="AI service" state={h.ragAgent} detail="Provider calls, document processing and retrieval" />
          <Row testId="h-worker" name="Background worker" state={h.worker.state} detail={h.worker.lastBeatAt ? <>Last heartbeat {formatAge(h.worker.ageSeconds)} ago (<time dateTime={h.worker.lastBeatAt}>{new Date(h.worker.lastBeatAt).toLocaleString()}</time>){h.worker.enabledHere === false ? " · the worker is disabled on this server" : ""}</> : h.worker.enabledHere === false ? "The worker is disabled on this server and no heartbeat has been recorded" : "No heartbeat recorded yet"} />
          <Row testId="h-queue" name="Job queue" state={q.state} detail={`${q.pending} pending · ${q.running} running · ${q.failed} failed · oldest waiting ${q.oldestPendingSeconds === null ? "—" : formatAge(q.oldestPendingSeconds)}`} />
          <Row testId="h-storage" name="File storage" state={h.storage.state} detail={`${h.storage.driver ?? "unknown"} driver · ${h.storage.writable === null ? "write check unavailable" : h.storage.writable ? "writable" : "not writable"}`} />
        </ul>
      </Panel>
      {h.runtime.length > 0 && (
        <Panel id="health-v" title="Runtime" description="Build and process information.">
          <dl className="grid gap-x-6 gap-y-2 p-5 text-sm sm:grid-cols-2" data-testid="runtime">{h.runtime.map((v) => <div key={v.key} className="flex justify-between gap-3"><dt className="text-muted-foreground">{v.key}</dt><dd className="font-mono text-xs">{v.value}</dd></div>)}</dl>
        </Panel>
      )}
    </div>
  );
}
