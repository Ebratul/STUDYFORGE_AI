"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, History, Loader2, Square } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { apiGet } from "@/lib/api";
import { describeGenerationError, type GenerationErrorInfo } from "@/lib/questions-api";
import type { RunKind, RunSummary } from "@/lib/questions";
import type { GenStatus } from "./use-generation";

const STAGE: Record<string, string> = {
  preparing: "Preparing your sources",
  retrieving: "Finding the relevant passages",
  generating: "Writing questions",
  validating: "Checking the questions",
  repairing: "Fixing questions that failed checks",
  checking: "Double-checking answer keys",
};

export function GenerationProgress({ status, onStop }: { status: GenStatus; onStop: () => void }) {
  const label = STAGE[status.stage] ?? "Working";
  const batch = status.batch && status.batches ? ` (part ${status.batch} of ${status.batches})` : "";
  const pct = status.batch && status.batches ? Math.max(8, Math.round(((status.batch - 1) / status.batches) * 100)) : undefined;
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-card" data-testid="generation-progress">
      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm font-medium">
          <Loader2 className="size-4 animate-spin text-primary" aria-hidden /> {label}{batch}…
        </p>
        <Button type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-8" onClick={onStop}>
          <Square aria-hidden /> Stop
        </Button>
      </div>
      <Progress value={pct ?? 0} className={pct === undefined ? "mt-3 h-1.5 animate-pulse" : "mt-3 h-1.5"} aria-label="Generation progress" />
      <p className="mt-2 text-xs text-muted-foreground">Large sets can take a minute or two. Nothing is saved until you choose to save it.</p>
    </div>
  );
}

export function GenerationError({ error, grounding, onDismiss, onRetry }: { error: GenerationErrorInfo; grounding?: string; onDismiss: () => void; onRetry?: () => void }) {
  const d = describeGenerationError(error, { grounding });
  return (
    <Alert variant="destructive" role="alert" data-testid="generation-error">
      <AlertCircle aria-hidden />
      <AlertTitle>{d.title}</AlertTitle>
      <AlertDescription>
        <p>{d.message}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {d.settingsCta && <Button asChild size="sm" variant="outline" className="rounded-full"><Link href="/settings/providers">Open AI settings</Link></Button>}
          {onRetry && error.retryable && <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={onRetry}>Try again</Button>}
          <Button type="button" size="sm" variant="ghost" className="rounded-full" onClick={onDismiss}>Dismiss</Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Recent successful runs; reopening one restores the model's original output (not your unsaved edits). */
export function RecentRuns({ kind, currentId, onOpen }: { kind: RunKind; currentId?: string; onOpen: (id: string) => void }) {
  const runs = useQuery({ queryKey: ["generation", "runs", kind], queryFn: async () => (await apiGet<{ items: RunSummary[] }>(`/api/generation/runs?kind=${kind}&limit=10`)).items, staleTime: 10_000 });
  const items = runs.data ?? [];
  if (runs.isLoading || runs.isError || items.length === 0) return null;
  return (
    <details className="rounded-2xl border bg-card p-4 shadow-card">
      <summary className="flex min-h-8 cursor-pointer items-center gap-2 text-sm font-medium"><History className="size-4 text-muted-foreground" aria-hidden /> Recent generations ({items.length})</summary>
      <ul className="mt-3 divide-y" aria-label="Recent generations">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0 text-sm">
              <span className="font-medium">{r.topic || "Untitled"}</span>
              <span className="text-muted-foreground"> · {r.questionCount} {r.questionCount === 1 ? "question" : "questions"} · {new Date(r.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
            </span>
            <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full sm:min-h-8" disabled={r.id === currentId} onClick={() => onOpen(r.id)}>{r.id === currentId ? "Showing" : "Reopen"}</Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
