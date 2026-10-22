import { getAuth } from "./auth.js";
import type { SessionUser } from "./types.js";
import { db } from "../lib/db.js";

export type ResolvedSession = { user: SessionUser; sessionId: string };

/**
 * Resolves the signed-in user for a set of request headers (cookie).
 * Re-reads role/status from the database on every request so suspensions, demotions and
 * session revocations apply immediately (no signed cookie cache).
 */
export async function resolveSession(h: Headers): Promise<ResolvedSession | null> {
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) return null;
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, emailVerified: true, image: true, role: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") return null;
  return { user, sessionId: session.session.id };
}

export async function getSessionUserFromHeaders(h: Headers): Promise<SessionUser | null> {
  return (await resolveSession(h))?.user ?? null;
}
