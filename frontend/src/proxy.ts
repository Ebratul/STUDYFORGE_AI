import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy responsibilities:
 *  1. Per-request CSP nonce + CSP header.
 *  2. An *optimistic* redirect for signed-out visitors (UX only).
 *
 * This is NOT an authorization layer. Real checks happen on the server in every page,
 * server action and route handler (see src/server/auth/session.ts).
 */
const PROTECTED_PREFIXES = [
  "/workspace", "/dashboard", "/chat", "/mcq", "/cq", "/documents", "/question-bank",
  "/exams", "/attempts", "/groups", "/join", "/notifications", "/settings", "/admin",
];
const SESSION_COOKIES = ["studyforge.session_token", "__Secure-studyforge.session_token"];

function buildCsp(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (isProtected && !hasSessionCookie) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!api|_next/static|_next/image|favicon.ico).*)", missing: [{ type: "header", key: "next-router-prefetch" }] }],
};
