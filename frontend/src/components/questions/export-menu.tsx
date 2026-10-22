"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ApiError } from "@/lib/api";
import { downloadExport } from "@/lib/questions-api";
import { DEFAULT_INCLUDE, FORMAT_LABEL, type ExportFormat, type ExportInclude, type ExportSource } from "@/lib/questions-export";
import { SwitchRow } from "./fields";

/** Download as PDF / text / JSON. The server validates and renders the file; unsaved drafts are sent as drafts and never persisted. */
export function ExportMenu({ getSource, count, defaultTitle, disabled, label = "Export" }: { getSource: () => ExportSource; count: number; defaultTitle: string; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [include, setInclude] = useState<ExportInclude>(DEFAULT_INCLUDE);
  const [title, setTitle] = useState(defaultTitle);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const name = await downloadExport({ source: getSource(), format, include, title: title.trim() || undefined });
      toast.success(`Downloaded ${name}`);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't export the questions.");
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof ExportInclude) => (v: boolean) => setInclude((i) => ({ ...i, [k]: v }));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-8" disabled={disabled || count === 0}><Download aria-hidden /> {label}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] space-y-3">
        <p className="text-sm font-medium">Export {count} {count === 1 ? "question" : "questions"}</p>
        <div className="space-y-1.5">
          <Label htmlFor="export-title">Title</Label>
          <Input id="export-title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 rounded-xl" maxLength={140} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="export-format">Format</Label>
          <select id="export-format" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} className="h-10 w-full rounded-xl border bg-background px-3 text-sm">
            {(Object.keys(FORMAT_LABEL) as ExportFormat[]).map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <SwitchRow label="Answers" checked={include.answers} onChange={set("answers")} />
          <SwitchRow label="Explanations" checked={include.explanations} onChange={set("explanations")} />
          <SwitchRow label="Short notes" checked={include.notes} onChange={set("notes")} />
          <SwitchRow label="Source quotes" checked={include.sources} onChange={set("sources")} />
        </div>
        <p className="text-xs text-muted-foreground">Exports never include internal IDs, model details or your documents&apos; identifiers.</p>
        <Button type="button" className="w-full rounded-xl" onClick={go} disabled={busy}>{busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />} Download</Button>
      </PopoverContent>
    </Popover>
  );
}
