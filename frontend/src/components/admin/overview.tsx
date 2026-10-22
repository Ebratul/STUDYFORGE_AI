import { Activity, Ban, FileText, HardDrive, ListChecks, ShieldCheck, UserCheck, Users } from "lucide-react";
import { StatCard } from "@/components/common/stat-card";
import { formatBytes } from "@/lib/format";
import { formatCount, type CountItem, type Overview } from "@/lib/admin";
import { AuditTable } from "./audit-table";
import { Panel } from "./common";

const labelOf = (k: string) => k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, " ");

function Breakdown({ items, empty }: { items: CountItem[]; empty: string }) {
  const nonZero = items.filter((i) => i.count > 0);
  if (nonZero.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
      {nonZero.map((i) => (<div key={i.key} className="flex items-center justify-between gap-2"><dt className="text-muted-foreground">{labelOf(i.key)}</dt><dd className="font-semibold tabular-nums">{formatCount(i.count)}</dd></div>))}
    </dl>
  );
}

export function OverviewView({ o }: { o: Overview }) {
  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Total users" value={formatCount(o.users)} icon={Users} tone="violet" />
        <StatCard label="Verified emails" value={formatCount(o.verified)} icon={UserCheck} tone="green" hint={o.users ? `${Math.round((o.verified / o.users) * 100)}% of users` : undefined} />
        <StatCard label="New (7 days)" value={formatCount(o.newUsers)} icon={ShieldCheck} tone="amber" />
        <StatCard label="Active sessions" value={formatCount(o.sessions)} icon={Activity} tone="blue" />
        <StatCard label="Suspended accounts" value={formatCount(o.suspended)} icon={Ban} tone="amber" hint={o.suspended === 0 ? "None right now" : undefined} />
      </div>
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Panel id="ov-docs" title="Documents" description="Counts and storage only. Names and contents are not available here.">
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-3"><span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground"><FileText className="size-5" aria-hidden /></span>
              <p><span className="text-2xl font-semibold tabular-nums">{formatCount(o.documents.total)}</span> <span className="text-sm text-muted-foreground">documents</span></p>
              <span className="ml-auto flex items-center gap-1.5 text-sm text-muted-foreground"><HardDrive className="size-4" aria-hidden /> {formatBytes(o.documents.bytes)}</span></div>
            <Breakdown items={o.documents.byStatus} empty="No documents have been uploaded." />
          </div>
        </Panel>
        <Panel id="ov-jobs" title="Background jobs" description="Current queue by status. Details are on the Jobs tab.">
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-3"><span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground"><ListChecks className="size-5" aria-hidden /></span>
              <p><span className="text-2xl font-semibold tabular-nums">{formatCount(o.jobs.byStatus.reduce((n, j) => n + j.count, 0))}</span> <span className="text-sm text-muted-foreground">jobs pending, running or failed</span></p></div>
            <Breakdown items={o.jobs.byStatus} empty="No jobs have run yet." />
          </div>
        </Panel>
      </div>
      <Panel id="ov-audit" title="Recent audit events" description="Latest 10 events. Metadata and secrets are never shown here.">
        <AuditTable rows={o.events} caption="Latest audit events" />
      </Panel>
    </>
  );
}
