"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { parseError } from "@/lib/api";
import { readSse } from "@/lib/sse";
import type { ChatMessage, StreamError } from "./types";

export type Draft = {
  userText: string | null; // null when regenerating (no new user bubble)
  assistantText: string;
  stage: string | null;
  warnings: string[];
};

type StartData = { userMessage: ChatMessage | null; assistantMessage: ChatMessage; warnings: string[]; title: string | null };

/** Streams one assistant turn over SSE. All errors are surfaced as a typed `error`; the draft is cleared after history refetches. */
export function useChatStream(conversationId: string) {
  const qc = useQueryClient();
  const abort = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<StreamError | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (body: { content: string } | { regenerate: true }) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      const ac = new AbortController();
      abort.current = ac;
      setDraft({ userText: "content" in body ? body.content : null, assistantText: "", stage: null, warnings: [] });
      const refresh = async () => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["chat", "messages", conversationId] }),
          qc.invalidateQueries({ queryKey: ["chat", "conversations"] }),
          qc.invalidateQueries({ queryKey: ["chat", "conversation", conversationId] }),
          qc.invalidateQueries({ queryKey: ["dashboard"] }),
        ]);
      };
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
          credentials: "same-origin",
        });
        if (!res.ok || !res.body) {
          const err = await parseError(res);
          setError({ code: err.code, message: err.message, retryable: err.code !== "NOT_CONFIGURED" && err.code !== "VALIDATION", retryAfter: null });
          setDraft(null);
          return;
        }
        let gotTerminal = false;
        for await (const ev of readSse(res.body)) {
          if (ev.event === "message_start") {
            const d = ev.data as StartData;
            setDraft((cur) => (cur ? { ...cur, warnings: d.warnings } : cur));
          } else if (ev.event === "status") {
            setDraft((cur) => (cur ? { ...cur, stage: (ev.data as { stage: string }).stage } : cur));
          } else if (ev.event === "delta") {
            const text = (ev.data as { text: string }).text;
            setDraft((cur) => (cur ? { ...cur, assistantText: cur.assistantText + text, stage: "generating" } : cur));
          } else if (ev.event === "final" || ev.event === "interrupted") {
            gotTerminal = true;
          } else if (ev.event === "error") {
            gotTerminal = true;
            const d = ev.data as StreamError;
            setError({ code: d.code, message: d.message, retryable: Boolean(d.retryable), retryAfter: d.retryAfter ?? null });
          }
        }
        if (!gotTerminal && !ac.signal.aborted) setError({ code: "UPSTREAM_UNAVAILABLE", message: "The connection was interrupted before the answer finished.", retryable: true, retryAfter: null });
        await refresh();
        setDraft(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // The server persists the partial text as INTERRUPTED a moment after it notices the disconnect:
          // refresh until no message is still marked STREAMING (bounded).
          for (let i = 0; i < 12; i++) {
            await refresh();
            const pages = qc.getQueryData<{ pages: { items: ChatMessage[] }[] }>(["chat", "messages", conversationId])?.pages ?? [];
            if (!pages.some((p) => p.items.some((m) => m.status === "STREAMING"))) break;
            await new Promise((r) => setTimeout(r, 400));
          }
          setDraft(null);
        } else {
          setError({ code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again.", retryable: true, retryAfter: null });
          await refresh();
          setDraft(null);
        }
      } finally {
        setBusy(false);
        abort.current = null;
      }
    },
    [busy, conversationId, qc],
  );

  const stop = useCallback(() => abort.current?.abort(), []);
  return { draft, error, busy, send: (content: string) => run({ content }), regenerate: () => run({ regenerate: true }), stop, clearError: () => setError(null) };
}
