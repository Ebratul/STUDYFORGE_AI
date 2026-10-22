/** Browser-side client for the backend API (same-origin; the Next.js app proxies /api/*). */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; details?: { fields?: Record<string, string> } & Record<string, unknown> } } = {};
  try {
    body = await res.json();
  } catch {
    /* not JSON (e.g. proxy/network error page) */
  }
  const e = body.error;
  const { fields, ...details } = e?.details ?? {};
  return new ApiError(res.status, e?.code ?? "ERROR", e?.message ?? "Something went wrong. Please try again.", fields ?? {}, details);
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined || isForm ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
      signal: init.signal,
      credentials: "same-origin",
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "Couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const apiSend = <T = { ok: true }>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => api<T>(path, { method, body: body ?? (method === "DELETE" ? undefined : {}) });
