import "server-only";

/** Server-side only. The browser never sees this URL. */
export const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";
