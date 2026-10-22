"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, parseError } from "@/lib/api";
import { readSse } from "@/lib/sse";
import { toGenerationError, type GenerationErrorInfo } from "@/lib/questions-api";
import type { RunKind, RunView } from "@/lib/questions";

export type GenStatus = { stage: string; batch: number | null; batches: number | null };

/** Runs one generation over SSE (`POST /api/generation/{mcq|cq}`). Validation/quota/config errors arrive as normal JSON errors before streaming starts. */
export function useGeneration(kind: RunKind) {
  const qc = useQueryClient();
  const abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<GenStatus | null>(null);
  const [error, setError] = useState<GenerationErrorInfo | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [stopped, setStopped] = useState(false);

  const start = useCallback(
    async (settings: unknown) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setStopped(false);
      setStatus({ stage: "preparing", batch: null, batches: null });
      const ac = new AbortController();
      abort.current = ac;
      let terminal = false;
      try {
        const res = await fetch(`/api/generation/${kind.toLowerCase()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
          signal: ac.signal,
          credentials: "same-origin",
        });
        if (!res.ok || !res.body) {
          setError(toGenerationError(await parseError(res)));
          return;
        }
        for await (const ev of readSse(res.body)) {
          if (ev.event === "status") {
            const d = ev.data as { stage: string; batch?: number; batches?: number };
            setStatus({ stage: d.stage, batch: d.batch ?? null, batches: d.batches ?? null });
          } else if (ev.event === "result") {
            terminal = true;
            setRun((ev.data as { run: RunView }).run);
          } else if (ev.event === "error") {
            terminal = true;
            const d = ev.data as { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> };
            setError({ code: d.code, message: d.message, retryable: Boolean(d.retryable), retryAfter: null, details: d.details ?? {}, fields: {} });
          }
        }
        if (!terminal && !ac.signal.aborted) setError({ code: "UPSTREAM_UNAVAILABLE", message: "The connection ended before generation finished.", retryable: true, retryAfter: null, details: {}, fields: {} });
      } catch (err) {
        if ((err as Error).name === "AbortError") setStopped(true);
        else if (err instanceof ApiError) setError(toGenerationError(err));
        else setError({ code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again.", retryable: true, retryAfter: null, details: {}, fields: {} });
      } finally {
        setBusy(false);
        setStatus(null);
        abort.current = null;
        void qc.invalidateQueries({ queryKey: ["generation", "runs", kind] });
        void qc.invalidateQueries({ queryKey: ["dashboard"] });
      }
    },
    [busy, kind, qc],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  const open = useCallback(async (id: string) => {
    setError(null);
    try {
      setRun((await apiGet<{ run: RunView }>(`/api/generation/runs/${id}`)).run);
    } catch (err) {
      setError(err instanceof ApiError ? toGenerationError(err) : { code: "NETWORK", message: "Couldn't load that generation.", retryable: true, retryAfter: null, details: {}, fields: {} });
    }
  }, []);

  return { busy, status, error, run, stopped, start, stop, open, clearError: () => setError(null), clearRun: () => setRun(null), clearStopped: () => setStopped(false) };
}
