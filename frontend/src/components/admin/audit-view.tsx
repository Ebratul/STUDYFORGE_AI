"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet } from "@/lib/api";
import { clampPage, formatCount, readAuditRow, readPaged } from "@/lib/admin";
import { AUDIT_PAGE_SIZE, auditPath, describeAdminError, type AuditFilters } from "@/lib/admin-api";
import { AuditTable } from "./audit-table";
import { ErrorLine, LoadingRows, Pager, Panel } from "./common";

const EMPTY: AuditFilters = { action: "", actor: "", from: "", to: "" };

export function AuditView() {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY);
  const [filters, setFilters] = useState<AuditFilters>(EMPTY);
  const [page, setPage] = useState(1);
  const invalidRange = draft.from !== "" && draft.to !== "" && draft.from > draft.to;
  const q = useQuery({ queryKey: ["admin", "audit", filters, page], queryFn: async () => readPaged(await apiGet(auditPath(filters, page)), readAuditRow, AUDIT_PAGE_SIZE), placeholderData: (p) => p });
  const data = q.data;
  const set = (k: keyof AuditFilters) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <Panel id="audit-h" title="Security audit events" description="Sign-ins, account and role changes, exports, deletions and other sensitive actions. Metadata shows only the fields the server allows; secrets and content are never included.">
      <form className="grid gap-3 border-b p-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_10rem_10rem_auto]" aria-label="Filter audit events" onSubmit={(e) => { e.preventDefault(); if (invalidRange) return; setFilters(draft); setPage(1); }}>
        <div className="space-y-1.5"><Label htmlFor="au-action">Action</Label><Input id="au-action" value={draft.action} onChange={set("action")} placeholder="e.g. auth.sign_in" className="h-10 rounded-xl" maxLength={64} /></div>
        <div className="space-y-1.5"><Label htmlFor="au-actor">Actor</Label><Input id="au-actor" value={draft.actor} onChange={set("actor")} placeholder="User id" className="h-10 rounded-xl font-mono" maxLength={64} /></div>
        <div className="space-y-1.5"><Label htmlFor="au-from">From</Label><Input id="au-from" type="date" value={draft.from} onChange={set("from")} className="h-10 rounded-xl" /></div>
        <div className="space-y-1.5"><Label htmlFor="au-to">To</Label><Input id="au-to" type="date" value={draft.to} onChange={set("to")} className="h-10 rounded-xl" aria-invalid={invalidRange ? true : undefined} aria-describedby={invalidRange ? "au-range-err" : undefined} /></div>
        <div className="flex items-end gap-2"><Button type="submit" className="rounded-xl" disabled={invalidRange}>Apply</Button><Button type="button" variant="ghost" className="rounded-xl" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); setPage(1); }}>Clear</Button></div>
        {invalidRange && <p id="au-range-err" role="alert" className="text-sm text-destructive sm:col-span-full">&ldquo;From&rdquo; must be on or before &ldquo;To&rdquo;.</p>}
      </form>
      {q.isLoading && <LoadingRows rows={6} />}
      {q.isError && <ErrorLine message={describeAdminError(q.error)} />}
      {data && (
        <>
          <p className="px-5 pt-3 text-sm text-muted-foreground" aria-live="polite" data-testid="audit-total">{formatCount(data.total)} {data.total === 1 ? "event" : "events"}</p>
          <AuditTable rows={data.items} caption="Security audit events" showMeta empty="No events match these filters." />
          <Pager page={clampPage(page, data.total, AUDIT_PAGE_SIZE)} total={data.total} pageSize={AUDIT_PAGE_SIZE} onPage={setPage} label="Audit events" />
        </>
      )}
    </Panel>
  );
}
