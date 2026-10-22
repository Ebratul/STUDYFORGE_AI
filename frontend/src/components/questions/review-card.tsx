"use client";

import { memo } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { describeFieldPath, validateContent, type FieldErrors, type Limits, type QuestionContent } from "@/lib/questions";
import { cn } from "@/lib/utils";
import { AiBadge, EditedBadge, EvidenceList, NeedsReview, SupportBadge } from "./question-badges";
import { CqEditor, McqEditor } from "./question-editor";
import { MetaChips, QuestionBody } from "./question-view";

export type ReviewItem = {
  key: string;
  draftId: string;
  current: QuestionContent;
  base: string;
  selected: boolean;
  editing: boolean;
  regenerating: boolean;
  saved: { id: string; version: number; snapshot: string } | null;
  serverErrors: FieldErrors;
};

export type CardHandlers = {
  onSelect: (key: string, on: boolean) => void;
  onToggleEdit: (key: string) => void;
  onChange: (key: string, next: QuestionContent) => void;
  onMove: (key: string, delta: -1 | 1) => void;
  onRegenerate: (key: string) => void;
  onDelete: (key: string) => void;
};

const iconBtn = "min-h-11 min-w-11 sm:min-h-8 sm:min-w-8";

function ReviewCardImpl({
  item, index, total, edited, dirtySinceSave, limits, withAnswers, busy, handlers,
}: {
  item: ReviewItem; index: number; total: number; edited: boolean; dirtySinceSave: boolean; limits: Limits; withAnswers: boolean; busy: boolean; handlers: CardHandlers;
}) {
  const q = item.current;
  const n = index + 1;
  const idPrefix = `q-${item.key}`;
  const errors: FieldErrors = { ...validateContent(q, limits), ...item.serverErrors };
  const hasErrors = Object.keys(errors).length > 0;
  const extra = Object.entries(item.serverErrors);

  return (
    <li id={idPrefix} data-testid="review-card" data-question-number={n} aria-label={`Question ${n}`} className={cn("rounded-2xl border bg-card p-4 shadow-card", hasErrors && "border-destructive/50", !item.selected && "opacity-80")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Checkbox id={`${idPrefix}-select`} checked={item.selected} onCheckedChange={(v) => handlers.onSelect(item.key, v === true)} aria-label={`Select question ${n}`} className="size-5" />
        <span className="text-sm font-semibold" aria-hidden>Q{n}</span>
        <div className="order-last flex basis-full flex-wrap items-center gap-1.5">
          <AiBadge />
          <SupportBadge support={q.sourceSupport} />
          {edited && <EditedBadge />}
          {item.saved && !dirtySinceSave && <Badge variant="outline" className="h-6 gap-1 rounded-full border-success/30 bg-success-soft px-2 text-[11px] text-success"><CheckCircle2 aria-hidden /> Saved</Badge>}
          {item.saved && dirtySinceSave && <Badge variant="outline" className="h-6 rounded-full px-2 text-[11px]">Unsaved changes</Badge>}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <Button type="button" variant={item.editing ? "default" : "outline"} size="sm" className="min-h-11 rounded-full transition-none sm:min-h-8" aria-pressed={item.editing} onClick={() => handlers.onToggleEdit(item.key)}>
            <Pencil aria-hidden /> {item.editing ? "Done" : "Edit"}
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={index === 0} aria-label={`Move question ${n} up`} onClick={() => handlers.onMove(item.key, -1)}><ArrowUp aria-hidden /></Button>
          <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={index === total - 1} aria-label={`Move question ${n} down`} onClick={() => handlers.onMove(item.key, 1)}><ArrowDown aria-hidden /></Button>
          <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={item.regenerating || busy} aria-label={`Regenerate question ${n}`} onClick={() => handlers.onRegenerate(item.key)}>
            {item.regenerating ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" className={cn(iconBtn, "text-destructive hover:text-destructive")} aria-label={`Delete question ${n}`} onClick={() => handlers.onDelete(item.key)}><Trash2 aria-hidden /></Button>
        </div>
      </div>

      <div className="mt-3 space-y-3" aria-busy={item.regenerating || undefined}>
        {item.editing ? (
          q.kind === "MCQ" ? <McqEditor q={q} onChange={(next) => handlers.onChange(item.key, next)} errors={errors} limits={limits} idPrefix={idPrefix} />
            : <CqEditor q={q} onChange={(next) => handlers.onChange(item.key, next)} errors={errors} limits={limits} idPrefix={idPrefix} withAnswers={withAnswers} />
        ) : (
          <>
            <QuestionBody q={q} showAnswers />
            <MetaChips q={q} />
          </>
        )}
        {extra.length > 0 && (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="server-errors">
            <p className="font-medium">The server couldn&apos;t accept this question:</p>
            <ul className="mt-1 list-disc pl-5">{extra.map(([path, msg]) => <li key={path}>{describeFieldPath(path)}: {msg}</li>)}</ul>
          </div>
        )}
        <NeedsReview reasons={q.reviewReasons} />
        <EvidenceList sources={q.sources} />
      </div>
    </li>
  );
}

export const ReviewCard = memo(ReviewCardImpl);
