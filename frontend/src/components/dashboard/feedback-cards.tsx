"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiSend } from "@/lib/api";
import { describeAnalysisRequestError } from "@/lib/analysis";
import { FEEDBACK_STATUS_LABEL, type RecentFeedback } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

const TONE: Record<string, string> = {
  READY: "border-success/40 bg-success-soft text-success",
  PENDING: "border-primary/30 bg-info-soft text-primary",
  FAILED: "border-destructive/40 bg-destructive/10 text-destructive",
  NOT_CONFIGURED: "border-warning/50 bg-warning-soft text-amber-800 dark:text-amber-200",
  NONE: "text-muted-foreground",
};

/** Latest AI feedback per result. The summary is plain text (escaped); the score never depends on it. */
export function FeedbackCards({ items }: { items: RecentFeedback[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  async function retry(attemptId: string) {
    setBusy(attemptId);
    try {
      await apiSend("POST", `/api/analysis/attempts/${attemptId}`, {});
      await qc.invalidateQueries({ queryKey: ["dashboard", "analytics"] });
    } catch (err) {
      toast.error(describeAnalysisRequestError(err, t));
    } finally {
      setBusy(null);
    }
  }
  return (
    <ul className="space-y-3" aria-label={t("Recent AI feedback")} data-testid="ai-feedback-cards">
      {items.map((f) => (
        <li key={f.attemptId} className="rounded-xl border bg-background p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={`/attempts/${f.attemptId}/result`} className="min-w-0 truncate text-sm font-semibold hover:underline">{f.examTitle}</Link>
            <Badge variant="outline" className={cn("gap-1 rounded-full text-[11px]", TONE[f.status])} data-status={f.status}>
              {f.status === "PENDING" && <Loader2 className="size-3 animate-spin" aria-hidden />}
              {t(FEEDBACK_STATUS_LABEL[f.status])}
            </Badge>
          </div>
          {f.status === "READY" && f.summary && <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">{f.summary}</p>}
          {f.status === "PENDING" && <p className="mt-1.5 text-sm text-muted-foreground" role="status">{t("Your feedback is being written. Your score is already final.")}</p>}
          {f.status === "FAILED" && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{t("AI feedback couldn't be generated. Your score is unaffected.")}</span>
              <Button size="sm" variant="outline" className="rounded-lg" disabled={busy === f.attemptId} onClick={() => void retry(f.attemptId)}>{busy === f.attemptId ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("Retry")}</Button>
            </div>
          )}
          {f.status === "NOT_CONFIGURED" && <p className="mt-1.5 text-sm text-muted-foreground">{t("Choose a model to get feedback:")} <Link href="/settings/providers" className="font-medium text-primary underline">{t("AI connection")}</Link>.</p>}
          {f.status === "NONE" && (
            <Button size="sm" variant="outline" className="mt-1.5 rounded-lg" disabled={busy === f.attemptId} onClick={() => void retry(f.attemptId)}><Bot aria-hidden /> {t("Get AI feedback")}</Button>
          )}
        </li>
      ))}
    </ul>
  );
}
