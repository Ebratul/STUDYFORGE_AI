import { TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AuditRow } from "@/lib/admin";

const when = (iso: string) => (iso ? new Date(iso).toLocaleString() : "—");
const shortId = (id: string | null) => (id ? (id.length > 14 ? `${id.slice(0, 12)}…` : id) : "—");

/** Audit events. Only what the API returns is shown: its metadata is already allow-listed and never contains secrets. */
export function AuditTable({ rows, caption, showMeta = false, empty = "No events yet." }: { rows: AuditRow[]; caption: string; showMeta?: boolean; empty?: string }) {
  return (
    <div role="region" aria-label={caption} tabIndex={0} className="relative w-full overflow-x-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
    <table className="w-full caption-bottom text-sm">
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">When</TableHead><TableHead scope="col">Action</TableHead><TableHead scope="col">Target</TableHead><TableHead scope="col">Actor</TableHead>
          {showMeta && <TableHead scope="col">Details</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && <TableRow><TableCell colSpan={showMeta ? 5 : 4} className="text-center text-muted-foreground">{empty}</TableCell></TableRow>}
        {rows.map((e) => (
          <TableRow key={e.id} data-testid="audit-row">
            <TableCell className="whitespace-nowrap text-muted-foreground">{when(e.createdAt)}</TableCell>
            <TableCell className="font-medium">{e.action}</TableCell>
            <TableCell>{e.targetType ?? "—"}{e.targetId && <span className="ml-1 font-mono text-xs text-muted-foreground">{shortId(e.targetId)}</span>}</TableCell>
            <TableCell className="font-mono text-xs">{e.actor ? shortId(e.actor) : "system"}{e.ipHash && <span className="ml-1 text-muted-foreground" title="Hashed address (prefix)">ip:{e.ipHash.slice(0, 8)}</span>}</TableCell>
            {showMeta && (
              <TableCell className="text-xs text-muted-foreground">
                {Object.keys(e.metadata).length === 0 ? "—" : Object.entries(e.metadata).map(([k, v]) => <span key={k} className="mr-2 whitespace-nowrap"><span className="font-medium text-foreground">{k}</span>: {v.slice(0, 80)}</span>)}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </table>
    </div>
  );
}
