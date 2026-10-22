import { ApiError, api } from "@/lib/api";
import { SaveFailure, type AttemptView, type SaveItem, type SaveResponse } from "@/lib/exams";

/** Autosave transport: turns API errors into the three outcomes the queue understands. */
export async function sendAnswers(attemptId: string, items: SaveItem[]): Promise<SaveResponse> {
  try {
    return await api<SaveResponse>(`/api/attempts/${attemptId}/answers`, { method: "PUT", body: { answers: items } });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "ATTEMPT_EXPIRED") throw new SaveFailure("expired", err.message);
      if (err.status === 0 || err.status >= 500 || err.status === 429 || err.code === "UPSTREAM_UNAVAILABLE") throw new SaveFailure("network", err.message);
      throw new SaveFailure("rejected", err.message);
    }
    throw new SaveFailure("network", "Couldn't reach the server.");
  }
}

export type SubmitResponse = { alreadyFinalized?: boolean; status?: string };

/** Final submission. Unconfirmed answers ride along; the server decides (by its own clock) whether they still count. */
export function submitAttempt(attemptId: string, pending: SaveItem[]): Promise<SubmitResponse> {
  return api<SubmitResponse>(`/api/attempts/${attemptId}/submit`, { method: "POST", body: pending.length ? { answers: pending } : {} });
}

export const fetchAttempt = (attemptId: string, signal?: AbortSignal) => api<{ attempt: AttemptView } | AttemptView>(`/api/attempts/${attemptId}`, { signal }).then((r) => ("attempt" in r ? r.attempt : r));
