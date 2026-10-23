"use client";

import { useEffect } from "react";
import { AlertTriangle, DatabaseZap, Loader2, RotateCcw, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { apiGet, apiSend, ApiError } from "@/lib/api";
import { useI18n } from "@/lib/i18n/client";
import { startPolling } from "@/lib/poll";
import { describeProviderCode } from "@/lib/ai";
import { RECONNECT_POLL_MS, readConnection, type Connection } from "./connection-helpers";

export const CONNECTION_KEY = ["ai", "connection"] as const;

export type ReindexAction = "cancel" | "retry";
/** `POST /api/ai/embedding-reindex/{cancel|retry}` → `{ connection }`. */
export const postReindexAction = (kind: ReindexAction) => apiSend<unknown>("POST", `/api/ai/embedding-reindex/${kind}`);
/** Keep polling while the build runs (and after a failed poll, where the state is unknown); stop on any other state. */
export const keepPollingReindex = (c: Connection | null) => c === null || c.reindex?.status === "BUILDING";

/** Whole-number percentage of documents with a verified new index; 0 when there is nothing to build yet. */
export const reindexPercent = (done: number, total: number) => (total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : 0);

/**
 * The staged embedding index (docs/EMBEDDING_SETTINGS_SPEC.md §5). While it is BUILDING the previous index keeps serving chat and search;
 * the switch happens on the server only after every document has a complete, verified new index. Polls `GET /api/ai/connection` every
 * few seconds while (and only while) a build is running.
 */
export function EmbeddingReindexPanel({ reindex }: { reindex: NonNullable<Connection["reindex"]> }) {
  const { t, format } = useI18n();
  const qc = useQueryClient();
  const building = reindex.status === "BUILDING";

  useEffect(() => {
    if (!building) return;
    return startPolling<Connection | null>({
      load: async () => readConnection(await apiGet<unknown>("/api/ai/connection")),
      onData: (c) => { if (c) qc.setQueryData(CONNECTION_KEY, c); },
      keepGoing: keepPollingReindex,
      intervalMs: RECONNECT_POLL_MS,
    });
  }, [building, qc]);

  const action = useMutation({
    mutationFn: (kind: ReindexAction) => postReindexAction(kind),
    onSuccess: (res, kind) => {
      const next = readConnection(res);
      if (next) qc.setQueryData(CONNECTION_KEY, next);
      void qc.invalidateQueries({ queryKey: CONNECTION_KEY });
      void qc.invalidateQueries({ queryKey: ["documents"] });
      toast.success(kind === "retry" ? t("Building the new index again.") : t("Stopped. Your current index is unchanged."));
    },
    onError: (err) => toast.error(err instanceof ApiError && err.code === "RATE_LIMITED" ? t("Too many requests. Please wait a moment and try again.") : err instanceof ApiError ? err.message : t("Something went wrong. Please try again.")),
  });

  const pct = reindexPercent(reindex.progress.done, reindex.progress.total);
  const progressText = t("{done} of {total} documents", { done: format.number(reindex.progress.done), total: format.number(reindex.progress.total) });
  const target = t("{model} · {n} dimensions", { model: reindex.modelId, n: format.number(reindex.dimension) });

  if (!building) {
    return (
      <Alert variant="destructive" data-testid="reindex-panel" data-state="failed" role="alert">
        <AlertTriangle aria-hidden />
        <AlertTitle>{t("The new search index could not be built")}</AlertTitle>
        <AlertDescription>
          <p className="font-mono text-xs" data-testid="reindex-target">{target}</p>
          <p className="mt-1" data-testid="reindex-error">{reindex.errorMessage || describeProviderCode(reindex.errorCode, t)}</p>
          <p className="mt-1">{t("Nothing changed: your current index is still active and your documents are still searchable.")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" className="rounded-xl" disabled={action.isPending} onClick={() => action.mutate("retry")} data-testid="reindex-retry">
              {action.isPending && action.variables === "retry" ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />} {t("Try again")}
            </Button>
            <Button type="button" size="sm" variant="outline" className="rounded-xl" disabled={action.isPending} onClick={() => action.mutate("cancel")} data-testid="reindex-cancel">
              <X aria-hidden /> {t("Dismiss")}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="border-primary/30 bg-primary/5" data-testid="reindex-panel" data-state="building">
      <DatabaseZap aria-hidden />
      <AlertTitle>{t("Building your new search index")}</AlertTitle>
      <AlertDescription>
        <p className="font-mono text-xs" data-testid="reindex-target">{target}</p>
        <p className="mt-1">{t("Your current index stays active and searchable until the new one is complete and verified. Then it switches over automatically.")}</p>
        <div className="mt-3 space-y-1.5">
          <Progress value={pct} max={100} aria-label={t("Building the new search index")} aria-valuetext={progressText} data-testid="reindex-progress" />
          <p className="text-xs text-muted-foreground" data-testid="reindex-progress-text">{progressText}</p>
        </div>
        <p role="status" aria-live="polite" className="sr-only">{progressText}</p>
        <div className="mt-3">
          <Button type="button" size="sm" variant="outline" className="rounded-xl" disabled={action.isPending} onClick={() => action.mutate("cancel")} data-testid="reindex-cancel">
            {action.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />} {t("Cancel")}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
