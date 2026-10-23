import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { createApp } from "../../src/app.js";
import { FakeRag } from "./fake-rag.js";
import { MemoryStorage } from "./memory-storage.js";
import { TEST_ORIGIN } from "./users.js";

/**
 * Drives the real Better Auth Google flow in-process with a MOCKED Google token endpoint:
 *   1. POST /api/auth/sign-in/social  -> authorization URL (+ state cookie)
 *   2. (Google would redirect back)    -> we call GET /api/auth/callback/google?code&state ourselves
 * Nothing here talks to Google, and no real credentials are needed.
 */
export type GoogleClaims = Record<string, unknown>;

export function googleClaims(overrides: GoogleClaims = {}): GoogleClaims {
  return {
    iss: "https://accounts.google.com",
    aud: process.env.AUTH_GOOGLE_ID,
    sub: `g-${randomUUID()}`,
    email: `g-${randomUUID()}@example.test`,
    email_verified: true,
    name: "Gita Google",
    picture: "https://lh3.googleusercontent.com/a/avatar-1234",
    ...overrides,
  };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** Unsigned JWT: Better Auth decodes (does not re-verify) the id_token received directly from Google's token endpoint over TLS. */
export function fakeIdToken(claims: GoogleClaims): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "RS256", typ: "JWT", kid: "test" })}.${b64({ iat: now, exp: now + 3600, ...claims })}.sig`;
}

export type MockGoogle = { tokenCalls: number; lastTokenRequest?: URLSearchParams; restore(): void };

/** Replaces fetch for Google's token endpoint only; every other request goes through untouched. */
export function mockGoogleToken(respond: (call: number) => { status?: number; body: unknown }): MockGoogle {
  const real = globalThis.fetch;
  const state: MockGoogle = { tokenCalls: 0, restore: () => void vi.unstubAllGlobals() };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      state.tokenCalls += 1;
      const body = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
      state.lastTokenRequest = new URLSearchParams(body);
      const r = respond(state.tokenCalls);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return real(input as RequestInfo, init);
  });
  return state;
}

export function tokenResponse(claims: GoogleClaims, extra: Record<string, unknown> = {}) {
  return {
    body: { access_token: "ya29.mock-access-token", refresh_token: "1//mock-refresh-token", id_token: fakeIdToken(claims), token_type: "Bearer", expires_in: 3599, scope: "openid email profile", ...extra },
  };
}

const randomIp = () => [203, ...Array.from({ length: 3 }, () => 1 + Math.floor(Math.random() * 250))].join(".");

export type GoogleHarness = ReturnType<typeof createGoogleHarness>;

export function createGoogleHarness() {
  const app = createApp({ rag: new FakeRag(), storage: new MemoryStorage() });
  /** Each call is a different client IP unless `ip` is given, so the auth rate limiter never couples unrelated tests. */
  const req = (method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null; ip?: string } = {}) => {
    const headers = new Headers({ "x-forwarded-for": opts.ip ?? randomIp() });
    if (opts.origin !== null) headers.set("origin", opts.origin ?? TEST_ORIGIN);
    if (opts.cookie) headers.set("cookie", opts.cookie);
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(opts.body);
    }
    return app.request(path, { method, headers, body, redirect: "manual" });
  };

  /** Step 1: what the "Continue with Google" button does. Returns the Google URL, our state and the cookies the browser would keep. */
  async function start(body: Record<string, unknown> = {}, cookie = "") {
    const res = await req("POST", "/api/auth/sign-in/social", { cookie, body: { provider: "google", callbackURL: "/workspace", errorCallbackURL: "/login", newUserCallbackURL: "/workspace", ...body } });
    const json = (await res.json().catch(() => ({}))) as { url?: string };
    const url = json.url ? new URL(json.url) : undefined;
    return { res, url, state: url?.searchParams.get("state") ?? "", cookies: cookieJar(res, cookie) };
  }

  /** Step 2: Google redirects the browser back to the callback. */
  async function callback(params: Record<string, string | undefined>, cookie: string) {
    const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined));
    const res = await req("GET", `/api/auth/callback/google?${q}`, { cookie, origin: null });
    return { res, location: res.headers.get("location") ?? "", cookies: cookieJar(res, cookie) };
  }

  /** Whole happy-path round trip as one browser. */
  async function signInWithGoogle(claims: GoogleClaims, opts: { cookie?: string; start?: Record<string, unknown>; token?: () => { status?: number; body: unknown } } = {}) {
    const mock = mockGoogleToken(opts.token ? opts.token : () => tokenResponse(claims));
    try {
      const s = await start(opts.start, opts.cookie);
      const cb = await callback({ code: "mock-auth-code", state: s.state }, s.cookies);
      return { ...cb, start: s, mock };
    } finally {
      mock.restore();
    }
  }

  return { app, req, start, callback, signInWithGoogle };
}

/** Merges Set-Cookie headers into a Cookie header value (deleted cookies are dropped). */
export function cookieJar(res: Response, existing = ""): string {
  const jar = new Map<string, string>();
  for (const part of existing.split(/;\s*/).filter(Boolean)) {
    const i = part.indexOf("=");
    jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const c of res.headers.getSetCookie()) {
    const [pair = ""] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    const expired = /max-age=0/i.test(c) || /expires=Thu, 01 Jan 1970/i.test(c);
    if (!value || expired) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

export const SESSION_COOKIE = "studyforge.session_token";
export const hasSession = (cookie: string) => cookie.split(/;\s*/).some((c) => c.startsWith(`${SESSION_COOKIE}=`));
