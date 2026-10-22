"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiSend } from "@/lib/api";
import { draftIsSendable, draftPayload, type ExamDraftInput } from "@/lib/exams";

export type DraftSaveStatus = "saved" | "unsaved" | "saving" | "rejected" | "incomplete";

/**
 * Debounced autosave of the draft (PUT /api/exams/:id/draft). Server field errors are exposed by path so the form can show them.
 * "saved" is only reported after the server accepted exactly the current content.
 */
export function useDraftSave(examId: string, draft: ExamDraftInput, enabled: boolean) {
  const payload = draftPayload(draft);
  const serialized = JSON.stringify(payload);
  const sendable = draftIsSendable(draft);
  const [saved, setSaved] = useState(serialized); // what the server is known to hold
  const [rejected, setRejected] = useState<string | null>(null); // a payload the server refused (not resent until it changes)
  const [saving, setSaving] = useState(false);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);
  const latest = useRef({ payload, serialized, sendable });
  useEffect(() => { latest.current = { payload, serialized, sendable }; });

  const send = useCallback(async (body: ExamDraftInput, key: string): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setSaving(true);
    try {
      await apiSend("PUT", `/api/exams/${examId}/draft`, body);
      setSaved(key);
      setRejected(null);
      setServerFields({});
      setMessage(null);
      return true;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 422 || err.status === 409)) {
        setRejected(key);
        setServerFields(err.fields);
        setMessage(err.message);
      } else {
        setMessage("Couldn't save the draft. We'll retry.");
      }
      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [examId]);

  useEffect(() => {
    if (!enabled || serialized === saved || serialized === rejected || !sendable || saving) return;
    const t = setTimeout(() => void send(payload, serialized), 800);
    return () => clearTimeout(t);
  }, [enabled, serialized, saved, rejected, sendable, saving, payload, send]);

  /** Awaits any in-flight save and sends pending changes now. Resolves true when the server holds the current draft. */
  const flush = useCallback(async (): Promise<boolean> => {
    for (let i = 0; i < 50 && busy.current; i++) await new Promise((r) => setTimeout(r, 100));
    const { payload: p, serialized: s, sendable: ok } = latest.current;
    if (s === saved) return true;
    if (!ok) return false;
    return send(p, s);
  }, [saved, send]);

  const status: DraftSaveStatus = saving ? "saving" : serialized === saved ? "saved" : serialized === rejected ? "rejected" : !sendable ? "incomplete" : "unsaved";
  return { status, serverFields, message, flush };
}
