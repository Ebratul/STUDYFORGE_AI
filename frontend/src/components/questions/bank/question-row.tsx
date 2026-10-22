"use client";

import { memo } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DIFFICULTY_LABEL, type QuestionView } from "@/lib/questions";
import { EditedBadge, ReviewedBadge, SupportBadge } from "../question-badges";

function RowImpl({ q, selected, onSelect, onOpen, move }: { q: QuestionView; selected: boolean; onSelect: (id: string, on: boolean) => void; onOpen: (id: string) => void; move?: { index: number; total: number; onMove: (id: string, delta: -1 | 1) => void } }) {
  return (
    <li data-testid="bank-row" className="flex flex-col gap-2 rounded-2xl border bg-card p-3 shadow-card sm:flex-row sm:items-start">
      <div className="flex items-start gap-3 sm:contents">
        <Checkbox checked={selected} onCheckedChange={(v) => onSelect(q.id, v === true)} aria-label={`Select: ${q.stem.slice(0, 60)}`} className="mt-1 size-5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="line-clamp-2 text-sm font-medium" lang={q.language}>{q.stem}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="secondary" className="rounded-full">{q.kind}</Badge>
            <Badge variant="outline" className="rounded-full">{DIFFICULTY_LABEL[q.difficulty]}</Badge>
            {q.topic && <Badge variant="outline" className="rounded-full">{q.topic}</Badge>}
            {q.tags.slice(0, 3).map((t) => <Badge key={t} variant="outline" className="rounded-full font-normal text-muted-foreground">#{t}</Badge>)}
            <span className="text-muted-foreground">{q.marks} {q.marks === 1 ? "mark" : "marks"}</span>
            <SupportBadge support={q.sourceSupport} />
            {q.modifiedByUser && <EditedBadge />}
            {q.needsReview && <Badge variant="outline" className="h-6 rounded-full border-warning/40 bg-warning-soft px-2 text-[11px] text-foreground">Needs review</Badge>}
            {q.reviewedAt && !q.needsReview && <ReviewedBadge />}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
        {move && (
          <>
            <Button type="button" variant="ghost" size="icon-sm" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" disabled={move.index === 0} aria-label="Move up in collection" onClick={() => move.onMove(q.id, -1)}><ArrowUp aria-hidden /></Button>
            <Button type="button" variant="ghost" size="icon-sm" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" disabled={move.index === move.total - 1} aria-label="Move down in collection" onClick={() => move.onMove(q.id, 1)}><ArrowDown aria-hidden /></Button>
          </>
        )}
        <Button type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-8" onClick={() => onOpen(q.id)}>Open</Button>
      </div>
    </li>
  );
}
export const QuestionRow = memo(RowImpl);
