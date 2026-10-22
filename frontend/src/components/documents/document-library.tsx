"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Download, FileText, FileUp, Loader2, RefreshCw, RotateCw, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/common/empty-state";
import { ApiError, api, apiGet, apiSend } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export type DocumentView = {
  id: string; name: string; extension: string; sizeBytes: number;
  status: "QUEUED" | "PROCESSING" | "READY" | "FAILED" | "NEEDS_OCR";
  statusCode: string | null; statusDetail: string | null; progress: number;
  pageCount: number | null; chunkCount: number | null; embeddingModel: string | null; createdAt: string; processedAt: string | null;
};
export type Limits = {
  maxFileBytes: number; maxFilesPerUpload: number; storageQuotaBytes: number; maxDocuments: number;
  usedBytes: number; documentCount: number; allowedExtensions: string[]; formats: { extension: string; label: string }[];
  video: { supported: boolean; reason: string };
};
type UploadResult = { filename: string; ok: boolean; duplicate?: boolean; document?: DocumentView; error?: { code: string; message: string } };

const ACTIVE = new Set(["QUEUED", "PROCESSING"]);

const STATUS: Record<DocumentView["status"], { label: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  QUEUED: { label: "Queued", icon: Clock, cls: "bg-muted text-muted-foreground" },
  PROCESSING: { label: "Processing", icon: Loader2, cls: "bg-info-soft text-primary" },
  READY: { label: "Ready", icon: CheckCircle2, cls: "bg-success-soft text-success" },
  FAILED: { label: "Failed", icon: XCircle, cls: "bg-destructive/10 text-destructive" },
  NEEDS_OCR: { label: "Needs OCR", icon: AlertTriangle, cls: "bg-warning-soft text-warning" },
};

export function DocumentLibrary({ initialDocs, initialLimits, hasEmbedding }: { initialDocs: DocumentView[]; initialLimits: Limits; hasEmbedding: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<DocumentView | null>(null);
  const [report, setReport] = useState<UploadResult[] | null>(null);

  const docs = useQuery({
    queryKey: ["documents"],
    queryFn: async () => (await apiGet<{ items: DocumentView[] }>("/api/documents")).items,
    initialData: initialDocs,
    // Poll only while something is being processed.
    refetchInterval: (q) => ((q.state.data ?? []).some((d) => ACTIVE.has(d.status)) ? 2000 : false),
  });
  const limits = useQuery({ queryKey: ["documents", "limits"], queryFn: () => apiGet<Limits>("/api/documents/limits"), initialData: initialLimits });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["documents"] });
    void qc.invalidateQueries({ queryKey: ["chat", "documents"] });
  };

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      return (await api<{ results: UploadResult[] }>("/api/documents", { method: "POST", body: form })).results;
    },
    onSuccess: (results) => {
      setReport(results);
      const ok = results.filter((r) => r.ok && !r.duplicate).length;
      const dup = results.filter((r) => r.duplicate).length;
      if (ok) toast.success(`${ok} file${ok > 1 ? "s" : ""} uploaded — processing started`);
      if (dup) toast.info(`${dup} file${dup > 1 ? "s were" : " was"} already in your library`);
      if (results.some((r) => !r.ok)) toast.error("Some files could not be uploaded");
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Upload failed."),
  });

  const retry = useMutation({
    mutationFn: (d: DocumentView) => apiSend("POST", `/api/documents/${d.id}/retry`),
    onSuccess: () => { toast.success("Processing restarted"); refresh(); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't restart processing."),
  });
  const remove = useMutation({
    mutationFn: (d: DocumentView) => apiSend("DELETE", `/api/documents/${d.id}`),
    onSuccess: () => { toast.success("Document deleted"); setDeleting(null); refresh(); },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't delete the document."),
  });

  async function download(d: DocumentView) {
    try {
      const { url } = await apiSend<{ url: string }>("POST", `/api/documents/${d.id}/download-link`);
      window.location.assign(url); // short-lived signed link; served as an attachment
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't create a download link.");
    }
  }

  function pick(files: FileList | File[] | null) {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    if (list.length > limits.data.maxFilesPerUpload) {
      toast.error(`Choose at most ${limits.data.maxFilesPerUpload} files at a time.`);
      return;
    }
    const big = list.find((f) => f.size > limits.data.maxFileBytes);
    if (big) {
      toast.error(`${big.name} is larger than ${formatBytes(limits.data.maxFileBytes)}.`);
      return;
    }
    upload.mutate(list);
  }

  const used = limits.data.usedBytes;
  const quotaPct = Math.min(100, Math.round((used / limits.data.storageQuotaBytes) * 100));
  const list = docs.data ?? [];

  return (
    <div className="space-y-6">
      {!hasEmbedding && (
        <Alert className="border-warning/40 bg-warning-soft">
          <AlertTriangle aria-hidden />
          <AlertTitle>Choose an embedding model first</AlertTitle>
          <AlertDescription>
            Documents are searched with embeddings, which use your own provider key. <Link href="/settings/providers" className="font-medium underline">Choose an embedding model</Link>; until then uploaded files fail with a clear message and can be retried.
          </AlertDescription>
        </Alert>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files); }}
        className={cn("rounded-2xl border-2 border-dashed bg-card p-6 text-center transition-colors", dragging ? "border-primary bg-accent/50" : "border-border")}
      >
        <FileUp className="mx-auto size-8 text-primary" aria-hidden />
        <p className="mt-2 text-sm font-medium">Drag files here, or</p>
        <input ref={input} id="file-input" type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown" className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} aria-label="Choose files to upload" />
        <Button type="button" className="mt-3 rounded-xl" onClick={() => input.current?.click()} disabled={upload.isPending}>
          {upload.isPending && <Loader2 className="animate-spin" aria-hidden />} {upload.isPending ? "Uploading…" : "Choose files"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          {limits.data.formats.map((f) => f.label).join(", ")} · up to {formatBytes(limits.data.maxFileBytes)} each · {limits.data.maxFilesPerUpload} files per upload
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Video isn&apos;t supported: {limits.data.video.reason}</p>
      </div>

      {report && report.some((r) => !r.ok) && (
        <Alert variant="destructive" role="alert">
          <XCircle aria-hidden />
          <AlertTitle>Some files were not uploaded</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">{report.filter((r) => !r.ok).map((r, i) => <li key={i}><strong>{r.filename}</strong>: {r.error?.message}</li>)}</ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-2xl border bg-card p-4 shadow-card">
        <div className="mb-1.5 flex justify-between text-sm"><span className="font-medium">Storage</span><span className="text-muted-foreground">{formatBytes(used)} of {formatBytes(limits.data.storageQuotaBytes)} · {limits.data.documentCount} / {limits.data.maxDocuments} documents</span></div>
        <Progress value={quotaPct} aria-label="Storage used" />
      </div>

      {list.length === 0 ? (
        <EmptyState icon={FileText} title="No documents yet" description="Upload notes, chapters or PDFs. They're private to you and used only for your own questions." />
      ) : (
        <ul className="divide-y rounded-2xl border bg-card shadow-card" aria-label="Your documents">
          {list.map((d) => {
            const s = STATUS[d.status];
            const Icon = s.icon;
            return (
              <li key={d.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center" data-testid={`doc-${d.name}`}>
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground uppercase"><FileText className="size-5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium" title={d.name}>{d.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(d.sizeBytes)} · {d.extension.toUpperCase()}
                    {d.pageCount ? ` · ${d.pageCount} page${d.pageCount > 1 ? "s" : ""}` : ""}
                    {d.chunkCount ? ` · ${d.chunkCount} passages` : ""} · {new Date(d.createdAt).toLocaleDateString()}
                  </p>
                  {ACTIVE.has(d.status) && <Progress value={d.progress} className="mt-2 h-1.5" aria-label={`${d.name} processing progress`} />}
                  {(d.status === "FAILED" || d.status === "NEEDS_OCR") && d.statusDetail && <p className="mt-1 text-xs text-destructive" role="status">{d.statusDetail}</p>}
                </div>
                <Badge variant="secondary" className={cn("w-fit gap-1 rounded-full", s.cls)} data-status={d.status}>
                  <Icon className={cn("size-3.5", d.status === "PROCESSING" && "animate-spin")} aria-hidden /> {s.label}
                </Badge>
                <div className="flex items-center gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={`Download ${d.name}`} onClick={() => void download(d)}><Download aria-hidden /></Button>
                  {(d.status === "FAILED" || d.status === "NEEDS_OCR" || d.status === "READY") && (
                    <Button size="icon-sm" variant="ghost" aria-label={d.status === "READY" ? `Reprocess ${d.name}` : `Retry ${d.name}`} title={d.status === "READY" ? "Reprocess (e.g. after changing the embedding model)" : "Retry"} onClick={() => retry.mutate(d)} disabled={retry.isPending}>
                      {d.status === "READY" ? <RefreshCw aria-hidden /> : <RotateCw aria-hidden />}
                    </Button>
                  )}
                  <Button size="icon-sm" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`Delete ${d.name}`} onClick={() => setDeleting(d)}><Trash2 aria-hidden /></Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this document?</DialogTitle>
            <DialogDescription>
              <strong>{deleting?.name}</strong> and everything derived from it (its indexed passages and embeddings) will be permanently removed. Past answers keep their citation text.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" className="rounded-xl" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>{remove.isPending && <Loader2 className="animate-spin" aria-hidden />} Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
