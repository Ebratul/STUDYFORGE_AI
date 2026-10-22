import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { BACKEND_URL } from "./config";

export class BackendError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/** Server-side call to the backend on behalf of the current request (forwards the session cookie). */
export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const h = await headers();
  const forward = new Headers(init.headers);
  const cookie = h.get("cookie");
  if (cookie) forward.set("cookie", cookie);
  const xff = h.get("x-forwarded-for");
  if (xff) forward.set("x-forwarded-for", xff);
  return fetch(new URL(path, BACKEND_URL), { ...init, headers: forward, cache: "no-store" });
}

export async function backendJson<T>(path: string): Promise<T> {
  const res = await backendFetch(path);
  if (!res.ok) {
    let code = "ERROR";
    let message = "Request failed.";
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON */
    }
    if (res.status === 404) notFound();
    if (res.status === 401) redirect("/login");
    throw new BackendError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export type Me = {
  user: { id: string; name: string; email: string; emailVerified: boolean; role: "USER" | "SUPPORT" | "ADMIN"; createdAt: string };
  unread: number;
  preference: { theme: "SYSTEM" | "LIGHT" | "DARK"; locale: string };
};

/** Memoised per request. Null when signed out (or the backend is unreachable, which we treat as signed out). */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    const res = await backendFetch("/api/me");
    if (res.status === 401) return null;
    if (!res.ok) return null;
    return (await res.json()) as Me;
  } catch {
    return null;
  }
});

/**
 * For pages/layouts. Layouts do not re-run on client navigation, so every protected page calls this itself.
 * The backend re-validates the session on every data request regardless.
 */
export async function requireMe(returnTo?: string): Promise<Me> {
  const me = await getMe();
  if (!me) redirect(returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login");
  return me;
}
