"use client";

import { FolderOpen, Library, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CollectionView } from "@/lib/questions";
import { cn } from "@/lib/utils";

/** Collections: a list on wide screens, a select on phones. `null` selection means "all questions". */
export function CollectionSidebar({ collections, selectedId, total, loading, onSelect, onNew }: {
  collections: CollectionView[]; selectedId: string | null; total: number | null; loading: boolean; onSelect: (id: string | null) => void; onNew: () => void;
}) {
  return (
    <nav aria-label="Collections" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Collections</h2>
        <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" onClick={onNew}><Plus aria-hidden /> New</Button>
      </div>

      <div className="md:hidden">
        <label htmlFor="collection-select" className="sr-only">Show collection</label>
        <select id="collection-select" value={selectedId ?? ""} onChange={(e) => onSelect(e.target.value || null)} className="h-11 w-full rounded-xl border bg-background px-3 text-sm">
          <option value="">All questions{total !== null ? ` (${total})` : ""}</option>
          {collections.map((c) => <option key={c.id} value={c.id}>{c.title} ({c.questionCount})</option>)}
        </select>
      </div>

      <ul className="hidden space-y-1 md:block" aria-label="Collection list">
        <li>
          <button type="button" onClick={() => onSelect(null)} aria-current={selectedId === null ? "true" : undefined} className={cn("flex min-h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm transition hover:bg-accent/60", selectedId === null && "bg-accent font-medium text-accent-foreground")}>
            <Library className="size-4 shrink-0" aria-hidden /> <span className="min-w-0 flex-1 truncate">All questions</span>{total !== null && <span className="text-xs text-muted-foreground">{total}</span>}
          </button>
        </li>
        {collections.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onSelect(c.id)} aria-current={selectedId === c.id ? "true" : undefined} title={c.description ?? c.title} className={cn("flex min-h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm transition hover:bg-accent/60", selectedId === c.id && "bg-accent font-medium text-accent-foreground")}>
              <FolderOpen className="size-4 shrink-0" aria-hidden /> <span className="min-w-0 flex-1 truncate">{c.title}</span><span className="text-xs text-muted-foreground">{c.questionCount}</span>
            </button>
          </li>
        ))}
        {!loading && collections.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No collections yet. Save generated questions to a new collection, or create an empty one.</li>}
      </ul>
    </nav>
  );
}
