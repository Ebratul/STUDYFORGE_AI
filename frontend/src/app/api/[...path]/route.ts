import type { NextRequest } from "next/server";
import { BACKEND_URL } from "@/lib/server/config";

/**
 * Same-origin proxy: the browser only ever talks to this app (so cookies are first-party and no CORS is needed);
 * /api/* is forwarded to the backend. Streams both ways (uploads, Server-Sent Events) and passes redirects and
 * Set-Cookie through untouched. The backend decides authentication and authorization — nothing is trusted here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const target = new URL(`/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`, BACKEND_URL);

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("x-forwarded-host", req.headers.get("host") ?? "");

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error -- required by Node's fetch when streaming a request body
      duplex: "half",
      redirect: "manual",
      signal: req.signal,
    });
  } catch {
    return Response.json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "The service is unavailable right now. Please try again shortly." } }, { status: 503 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === "content-encoding" || k === "set-cookie") return; // fetch already decoded the body
    out.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
