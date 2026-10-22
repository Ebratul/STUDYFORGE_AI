import { Hono } from "hono";
import { db } from "../../lib/db.js";
import { recordAudit } from "../../lib/audit.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { requireAuth, requirePermissionMw } from "../../http/middleware.js";
import type { AppEnv } from "../../http/context.js";
import { parseWith, readJson } from "../../http/body.js";
import { daysAgo } from "../../lib/dates.js";
import { dashboardExams } from "../exams/service.js";
import { countUnread, listNotifications, markAllRead, markRead } from "./notifications.js";
import { getProfileBundle, updatePreferences, updateProfile } from "./profile.js";
import { listSessions, revokeOtherSessions, revokeSession } from "./sessions.js";
import { preferencesSchema, profileSchema } from "./schemas.js";
import { z } from "zod";
import { getDailyUsage } from "../ai/usage.js";

export const accountRoutes = new Hono<AppEnv>();
// Per-path (not "*") so this router's middleware can never leak onto other /api routes mounted next to it.
for (const path of ["/me", "/profile", "/preferences", "/notifications", "/notifications/*", "/sessions", "/sessions/*", "/account/*", "/admin/*", "/dashboard/*"]) {
  accountRoutes.use(path, requireAuth);
}

accountRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const [unread, { preference }, createdAt] = await Promise.all([countUnread(user), getProfileBundle(user), db.user.findUnique({ where: { id: user.id }, select: { createdAt: true } })]);
  return c.json({
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, role: user.role, createdAt: createdAt?.createdAt.toISOString() ?? null },
    unread,
    preference: { theme: preference?.theme ?? "SYSTEM", locale: preference?.locale ?? "en" },
  });
});

accountRoutes.get("/profile", async (c) => {
  const user = c.get("user");
  const { profile, preference } = await getProfileBundle(user);
  return c.json({
    name: user.name,
    email: user.email,
    displayName: profile?.displayName ?? "",
    bio: profile?.bio ?? "",
    timezone: profile?.timezone ?? "UTC",
    preference: {
      theme: preference?.theme ?? "SYSTEM",
      locale: preference?.locale ?? "en",
      emailNotifications: preference?.emailNotifications ?? true,
    },
  });
});

accountRoutes.patch("/profile", async (c) => {
  const user = c.get("user");
  await enforceRateLimit({ key: `profile:${user.id}`, limit: 20, windowSec: 60 });
  const input = await readJson(c.req.raw, profileSchema);
  await updateProfile(user, input);
  return c.json({ ok: true });
});

accountRoutes.patch("/preferences", async (c) => {
  const user = c.get("user");
  await enforceRateLimit({ key: `prefs:${user.id}`, limit: 30, windowSec: 60 });
  const input = await readJson(c.req.raw, preferencesSchema);
  await updatePreferences(user, input);
  return c.json({ ok: true });
});

accountRoutes.get("/notifications", async (c) => {
  const items = await listNotifications(c.get("user"));
  return c.json({
    items: items.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: Boolean(n.readAt), createdAt: n.createdAt.toISOString() })),
  });
});

accountRoutes.post("/notifications/read-all", async (c) => {
  await markAllRead(c.get("user"));
  return c.json({ ok: true });
});

accountRoutes.post("/notifications/:id/read", async (c) => {
  const id = parseWith(z.string().min(1).max(64), c.req.param("id"));
  await markRead(c.get("user"), id);
  return c.json({ ok: true });
});

accountRoutes.get("/sessions", async (c) => {
  const sessions = await listSessions(c.get("user"), c.get("sessionId"));
  return c.json({ items: sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString() })) });
});

accountRoutes.post("/sessions/revoke-others", async (c) => {
  const n = await revokeOtherSessions(c.get("user"), c.get("sessionId"));
  return c.json({ ok: true, revoked: n });
});

accountRoutes.delete("/sessions/:id", async (c) => {
  const id = parseWith(z.string().min(1).max(64), c.req.param("id"));
  await revokeSession(c.get("user"), id, c.get("sessionId"));
  return c.json({ ok: true });
});

// Export of the signed-in user's own data. The user id comes only from the session.
accountRoutes.get("/account/export", async (c) => {
  const user = c.get("user");
  await enforceRateLimit({ key: `export:${user.id}`, limit: 3, windowSec: 3600 });
  const [profile, preference, notifications, audit, conversations, documents] = await Promise.all([
    db.userProfile.findUnique({ where: { userId: user.id } }),
    db.userPreference.findUnique({ where: { userId: user.id } }),
    db.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    db.auditEvent.findMany({ where: { actorId: user.id }, orderBy: { createdAt: "asc" }, select: { action: true, targetType: true, createdAt: true } }),
    db.conversation.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: { messages: { orderBy: { createdAt: "asc" }, select: { role: true, content: true, status: true, provider: true, model: true, createdAt: true } } },
    }),
    db.document.findMany({
      where: { ownerId: user.id },
      select: { id: true, name: true, mimeType: true, sizeBytes: true, status: true, pageCount: true, createdAt: true },
    }),
  ]);
  await recordAudit({ actorId: user.id, action: "account.data_exported" });
  // Provider credentials are intentionally excluded (never exported, even masked).
  const body = {
    exportedAt: new Date().toISOString(),
    account: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, role: user.role },
    profile,
    preference,
    notifications,
    activity: audit,
    conversations,
    documents,
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": 'attachment; filename="studyforge-export.json"',
      "cache-control": "no-store",
    },
  });
});

// Admin: aggregates and audit metadata only — never user content.
accountRoutes.get("/admin/overview", requirePermissionMw("admin:dashboard:view"), async (c) => {
  const since = daysAgo(7);
  const [users, verified, newUsers, sessions, events] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { emailVerified: true } }),
    db.user.count({ where: { createdAt: { gte: since } } }),
    db.session.count({ where: { expiresAt: { gt: new Date() } } }),
    db.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 20, select: { id: true, action: true, targetType: true, createdAt: true, actorId: true } }),
  ]);
  return c.json({
    users,
    verified,
    newUsers,
    sessions,
    events: events.map((e) => ({ id: e.id, action: e.action, targetType: e.targetType, actor: e.actorId ? `${e.actorId.slice(0, 8)}…` : null, createdAt: e.createdAt.toISOString() })),
  });
});

// Real, per-user counts for the dashboard (exam figures include released results only).
accountRoutes.get("/dashboard/summary", async (c) => {
  const user = c.get("user");
  const [unread, sessions, credentials, docsByStatus, docBytes, conversations, userMessages, usage, prefs] = await Promise.all([
    countUnread(user),
    db.session.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
    db.providerCredential.count({ where: { userId: user.id } }),
    db.document.groupBy({ by: ["status"], where: { ownerId: user.id }, _count: true }),
    db.document.aggregate({ where: { ownerId: user.id }, _sum: { sizeBytes: true } }),
    db.conversation.count({ where: { userId: user.id } }),
    db.message.count({ where: { role: "USER", conversation: { userId: user.id } } }),
    getDailyUsage(user.id),
    db.modelPreference.findMany({ where: { userId: user.id }, select: { task: true } }),
  ]);
  const count = (st: string) => docsByStatus.find((d) => d.status === st)?._count ?? 0;
  return c.json({
    unread,
    sessions,
    providersConnected: credentials,
    hasDefaultModel: prefs.some((p) => p.task === "DEFAULT" || p.task === "CHAT"),
    hasEmbeddingModel: prefs.some((p) => p.task === "EMBEDDING"),
    documents: { total: docsByStatus.reduce((n, d) => n + d._count, 0), ready: count("READY"), failed: count("FAILED") + count("NEEDS_OCR"), processing: count("QUEUED") + count("PROCESSING"), bytes: docBytes._sum.sizeBytes ?? 0 },
    conversations,
    questionsAsked: userMessages,
    usage,
    exams: await dashboardExams(user),
  });
});
