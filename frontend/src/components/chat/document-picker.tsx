"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { FileText, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiGet } from "@/lib/api";
import type { DocumentView } from "@/components/documents/document-library";

export function DocumentPicker({ selected, onChange, disabled }: { selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const docs = useQuery({ queryKey: ["chat", "documents"], queryFn: async () => (await apiGet<{ items: DocumentView[] }>("/api/documents")).items, staleTime: 15_000 });
  const items = docs.data ?? [];
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-full" disabled={disabled} aria-label={`Attach documents (${selected.length} selected)`}>
          <Paperclip aria-hidden /> Documents {selected.length > 0 && <Badge className="ml-1 h-5 rounded-full px-1.5">{selected.length}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b p-3 text-sm font-medium">Search these documents</div>
        <div className="max-h-64 overflow-y-auto p-1">
          {docs.isLoading && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
          {!docs.isLoading && items.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">No documents yet. <Link href="/documents" className="text-primary underline">Upload some</Link>.</p>
          )}
          {items.map((d) => (
            <label key={d.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg p-2 text-sm hover:bg-accent/60">
              <Checkbox checked={selected.includes(d.id)} onCheckedChange={(v) => toggle(d.id, v === true)} aria-label={`Use ${d.name}`} />
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={d.name}>{d.name}</span>
              {d.status !== "READY" && <Badge variant="outline" className="rounded-full text-[10px]">{d.status === "FAILED" || d.status === "NEEDS_OCR" ? "unusable" : "processing"}</Badge>}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
