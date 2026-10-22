import { db } from "../../lib/db.js";
import type { SessionUser } from "../../auth/types.js";
import { Errors } from "../../lib/errors.js";

export async function createWelcomeNotification(userId: string, name: string) {
  await db.notification.create({
    data: {
      userId,
      type: "system.welcome",
      title: "Welcome to StudyForge",
      body: `Hi ${name}, your account is ready. Document-grounded chat, MCQ/CQ generation and exams arrive in the next parts of the build.`,
    },
  });
}

export async function listNotifications(user: SessionUser, take = 50) {
  return db.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take,
  });
}

export async function countUnread(user: SessionUser) {
  return db.notification.count({ where: { userId: user.id, readAt: null } });
}

/** Ownership is part of the WHERE clause: someone else's id simply matches nothing. */
export async function markRead(user: SessionUser, id: string) {
  const { count } = await db.notification.updateMany({
    where: { id, userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  if (count === 0) {
    const exists = await db.notification.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!exists) throw Errors.notFound();
  }
}

export async function markAllRead(user: SessionUser) {
  const { count } = await db.notification.updateMany({
    where: { userId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}
