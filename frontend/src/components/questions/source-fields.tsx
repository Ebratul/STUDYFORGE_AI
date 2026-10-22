"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { DocumentView } from "@/components/documents/document-library";
import { apiGet } from "@/lib/api";
import { GROUNDING_LABEL, type FieldErrors, type Grounding, type Limits } from "@/lib/questions";
import { cn } from "@/lib/utils";
import { Field, FieldError } from "./fields";

export type SourceValue = { topic: string; pastedText: string; documentIds: string[]; subject: string };

const UNUSABLE: Record<string, string> = { QUEUED: "processing", PROCESSING: "processing", FAILED: "failed", NEEDS_OCR: "needs OCR" };

/** Topic, pasted text and uploaded documents. They can be combined; documents must be the user's own READY files (the server re-checks). */
export function SourceFields({ value, onChange, errors, limits, idPrefix }: { value: SourceValue; onChange: (v: SourceValue) => void; errors: FieldErrors; limits: Limits; idPrefix: string }) {
  const docs = useQuery({ queryKey: ["questions", "documents"], queryFn: async () => (await apiGet<{ items: DocumentView[] }>("/api/documents")).items, staleTime: 15_000 });
  const items = docs.data ?? [];
  const toggle = (id: string, on: boolean) => onChange({ ...value, documentIds: on ? [...value.documentIds, id] : value.documentIds.filter((x) => x !== id) });
  const tid = `${idPrefix}-topic`, pid = `${idPrefix}-text`;

  return (
    <div className="space-y-4">
      <Field label="Topic" htmlFor={tid} error={errors.topic} hint="What the questions are about. Optional when you provide text or documents; with documents it focuses the questions on that part of them.">
        <Input id={tid} value={value.topic} maxLength={limits.topicMaxChars + 50} onChange={(e) => onChange({ ...value, topic: e.target.value })} placeholder="e.g. Photosynthesis" className="h-10 rounded-xl" aria-invalid={errors.topic ? true : undefined} aria-describedby={`${tid}-${errors.topic ? "err" : "hint"}`} autoComplete="off" />
      </Field>
      <Field label="Subject (optional)" htmlFor={`${idPrefix}-subject`} hint="Saved with each question so you can filter your bank later.">
        <Input id={`${idPrefix}-subject`} value={value.subject} maxLength={limits.topic} onChange={(e) => onChange({ ...value, subject: e.target.value })} placeholder="e.g. Biology" className="h-10 rounded-xl" autoComplete="off" />
      </Field>
      <Field label="Pasted text (optional)" htmlFor={pid} error={errors.pastedText}>
        <Textarea id={pid} value={value.pastedText} onChange={(e) => onChange({ ...value, pastedText: e.target.value })} rows={5} placeholder="Paste notes or a passage to write questions from." className="min-h-28 rounded-xl" aria-invalid={errors.pastedText ? true : undefined} aria-describedby={`${pid}-count`} />
        <p id={`${pid}-count`} className={cn("text-right text-xs", value.pastedText.length > limits.textMaxChars ? "font-medium text-destructive" : "text-muted-foreground")}>{value.pastedText.length.toLocaleString()} / {limits.textMaxChars.toLocaleString()}</p>
      </Field>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Your documents (optional)</legend>
        <div className="rounded-xl border">
          <ul className="max-h-56 divide-y overflow-y-auto" aria-label="Your documents">
            {docs.isLoading && <li className="p-3 text-sm text-muted-foreground">Loading…</li>}
            {docs.isError && <li role="alert" className="p-3 text-sm text-destructive">Couldn&apos;t load your documents.</li>}
            {!docs.isLoading && !docs.isError && items.length === 0 && (
              <li className="p-3 text-sm text-muted-foreground">No documents yet. <Link href="/documents" className="text-primary underline">Upload some</Link> to write questions from them.</li>
            )}
            {items.map((d) => {
              const ready = d.status === "READY";
              const id = `${idPrefix}-doc-${d.id}`;
              return (
                <li key={d.id} className={cn("flex min-h-11 items-center gap-2.5 px-3 py-2 text-sm", !ready && "opacity-60")}>
                  <Checkbox id={id} checked={value.documentIds.includes(d.id)} disabled={!ready} onCheckedChange={(v) => toggle(d.id, v === true)} />
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate" title={d.name}>{d.name}</label>
                  {!ready && <Badge variant="outline" className="rounded-full text-[10px]" title="Only fully processed documents can be used">{UNUSABLE[d.status] ?? d.status.toLowerCase()} · unavailable</Badge>}
                </li>
              );
            })}
          </ul>
        </div>
        <FieldError>{errors.documentIds}</FieldError>
        {value.documentIds.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{value.documentIds.length} selected (up to {limits.maxDocuments}).</p>}
      </fieldset>
    </div>
  );
}

/** The grounding policy as plain-language radio cards. Policies that don't fit the chosen sources are disabled with the reason. */
export function GroundingField({ value, onChange, hasSources, error, idPrefix }: { value: Grounding; onChange: (g: Grounding) => void; hasSources: boolean; error?: string; idPrefix: string }) {
  const options = (["SOURCE_ONLY", "SOURCE_PREFERRED", "GENERAL"] as Grounding[]).map((g) => ({
    g,
    disabled: g === "GENERAL" ? hasSources : !hasSources,
    reason: g === "GENERAL" ? "Not available while pasted text or documents are attached." : "Add pasted text or a document to use a source-based policy.",
  }));
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">How closely must questions follow your sources?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map(({ g, disabled, reason }) => {
          const id = `${idPrefix}-grounding-${g}`;
          return (
            <div key={g}>
              <input id={id} type="radio" name={`${idPrefix}-grounding`} value={g} checked={value === g} disabled={disabled} onChange={() => onChange(g)} className="peer sr-only" aria-describedby={`${id}-d`} />
              <label htmlFor={id} className="flex h-full min-h-11 cursor-pointer flex-col gap-1 rounded-xl border bg-background p-3 text-sm transition peer-checked:border-primary peer-checked:bg-accent peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-55">
                <span className="font-medium">{GROUNDING_LABEL[g].label}</span>
                <span id={`${id}-d`} className="text-xs text-muted-foreground">{disabled ? reason : GROUNDING_LABEL[g].text}</span>
              </label>
            </div>
          );
        })}
      </div>
      <FieldError>{error}</FieldError>
    </fieldset>
  );
}
