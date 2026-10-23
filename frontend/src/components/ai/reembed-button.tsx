"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError, apiSend } from "@/lib/api";
import { useT } from "@/lib/i18n/client";

/** Queues re-embedding of the documents whose embedding identity differs from the current configuration (`POST /api/documents/reembed`). */
export function ReembedButton({ count, onQueued, variant = "default", size = "sm" }: { count: number; onQueued?: (r: { queued: number; skipped: number }) => void; variant?: "default" | "outline"; size?: "sm" | "default" }) {
  const t = useT();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => apiSend<{ queued?: number; skipped?: number }>("POST", "/api/documents/reembed", {}),
    onSuccess: (r) => {
      const result = { queued: r.queued ?? 0, skipped: r.skipped ?? 0 };
      toast.success(t("{queued, plural, one {# document queued for re-embedding.} other {# documents queued for re-embedding.}}", { queued: result.queued }) + (result.skipped ? ` ${t("{skipped, plural, one {# was skipped.} other {# were skipped.}}", { skipped: result.skipped })}` : ""));
      void qc.invalidateQueries({ queryKey: ["ai", "connection"] });
      void qc.invalidateQueries({ queryKey: ["documents"] });
      onQueued?.(result);
    },
    onError: (err) => toast.error(err instanceof ApiError && err.code === "RATE_LIMITED" ? t("Too many requests. Please wait a moment and try again.") : err instanceof ApiError ? err.message : t("Something went wrong. Please try again.")),
  });
  return (
    <Button type="button" size={size} variant={variant} className="rounded-xl" disabled={run.isPending || count <= 0} onClick={() => run.mutate()}>
      {run.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
      {t("{count, plural, one {Re-embed # document} other {Re-embed # documents}}", { count })}
    </Button>
  );
}
