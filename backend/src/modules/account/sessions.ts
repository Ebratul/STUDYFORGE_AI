import { db } from "../../lib/db.js";
import type { SessionUser } from "../../auth/types.js";
import { Errors } from "../../lib/errors.js";

export type SessionSummary = { id: string; userAgent: string | null; createdAt: Date; expiresAt: Date; current: boolean };

/** Session tokens never leave the server: only opaque row ids are exposed to the UI. */
export async function listSessions(user: SessionUser, currentSessionId: string): Promise<SessionSummary[]> {
  const rows = await db.session.findMany({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, userAgent: true, createdAt: true, expiresAt: true },
  });
  return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
}

export async function revokeSession(user: SessionUser, sessionId: string, currentSessionId: string) {
  if (sessionId === currentSessionId) throw Errors.forbidden(); // use sign out for the current device
  const { count } = await db.session.deleteMany({ where: { id: sessionId, userId: user.id } });
  if (count === 0) throw Errors.notFound();
}

export async function revokeOtherSessions(user: SessionUser, currentSessionId: string) {
  const { count } = await db.session.deleteMany({ where: { userId: user.id, id: { not: currentSessionId } } });
  return count;
}
