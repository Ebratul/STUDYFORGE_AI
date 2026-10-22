"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MessageCircleQuestion, NotebookPen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError, apiSend } from "@/lib/api";
import { readSession, stashPrompt, type AssistantKind } from "@/lib/assistant";
import { msg } from "@/lib/i18n/translate";
import { useT } from "@/lib/i18n/client";

type Body = { kind: AssistantKind; attemptId?: string; questionId?: string; topic?: string };

const DENIED: Record<string, string> = {
  NOT_ELIGIBLE: msg("The study assistant can't use this question: the exam's review settings don't show its answer."),
  CONFLICT: msg("These results haven't been released yet."),
  NOT_CONFIGURED: msg("Choose a model in Settings → AI providers to use the study assistant."),
  QUOTA_EXCEEDED: msg("You've reached your AI usage limit for now."),
  RATE_LIMITED: msg("You've started a lot of assistant sessions. Please wait a little and try again."),
};

/** Starts an assistant session and hands the first prompt to the chat screen, which sends it exactly once (docs/PART5_SPEC.md §5). */
export function useAssistantSession() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  async function start(body: Body, label: string) {
    setBusy(label);
    try {
      const s = readSession(await apiSend("POST", "/api/assistant/sessions", body));
      if (s.conversationId && s.prompt) {
        stashPrompt(s.conversationId, s.prompt);
        router.push(`/chat/${s.conversationId}`);
        return;
      }
      if (s.href) {
        router.push(s.href);
        return;
      }
      toast.error(t("The study assistant didn't return anything to open."));
    } catch (err) {
      toast.error(err instanceof ApiError ? (DENIED[err.code] ? t(DENIED[err.code]!) : t(err.message)) : t("Couldn't reach the server. Check your connection and try again."));
    } finally {
      setBusy(null);
    }
  }
  return { busy, start };
}

/** Explain one missed question. Shown only where the review includes the correct answer; the server still decides. */
export function ExplainButton({ attemptId, questionId }: { attemptId: string; questionId: string }) {
  const t = useT();
  const { busy, start } = useAssistantSession();
  const label = `explain-${questionId}`;
  return (
    <Button size="sm" variant="outline" className="mt-3 rounded-lg" disabled={busy !== null} onClick={() => void start({ kind: "EXPLAIN_INCORRECT", attemptId, questionId }, label)} data-testid="explain-question">
      {busy === label ? <Loader2 className="animate-spin" aria-hidden /> : <MessageCircleQuestion aria-hidden />} {t("Explain this with the study assistant")}
    </Button>
  );
}

export function RevisionPlanButton({ attemptId }: { attemptId?: string }) {
  const t = useT();
  const { busy, start } = useAssistantSession();
  return (
    <Button variant="outline" className="h-auto min-h-9 max-w-full shrink whitespace-normal py-2 text-left" disabled={busy !== null} onClick={() => void start({ kind: "REVISION_PLAN", ...(attemptId ? { attemptId } : {}) }, "plan")} data-testid="assistant-plan">
      {busy === "plan" ? <Loader2 className="animate-spin" aria-hidden /> : <NotebookPen aria-hidden />} {t("Ask the study assistant for a revision plan")}
    </Button>
  );
}
