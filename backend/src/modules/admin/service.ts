import { randomBytes } from "node:crypto";
import { Prisma, type Role, type UserStatus } from "../../generated/prisma/client.js";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { recordAudit } from "../../lib/audit.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { flushMetrics, hourStart } from "../../lib/metrics.js";
import { redactString } from "../../lib/redact.js";
import { can } from "../../auth/authorize.js";
import { enabledProviders } from "../ai/providers.js";
import type { Storage } from "../documents/storage/types.js";

const DAY = 86_400_000;
const trunc = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/** `alice@example.com` -> `a***@e***.com` (SUPPORT never sees full addresses). */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------------------------------
export async function overview() {
  const since = new Date(clockNow().getTime() - 7 * DAY);
  const [users, verified, newUsers, suspended, sessions, docs, jobs, events] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { emailVerified: true } }),
    db.user.count({ where: { createdAt: { gte: since } } }),
    db.user.count({ where: { status: "SUSPENDED" } }),
    db.session.count({ where: { expiresAt: { gt: new Date() } } }),
    db.document.groupBy({ by: ["status"], _count: true, _sum: { sizeBytes: true } }),
    db.job.groupBy({ by: ["status"], _count: true }),
    db.auditEvent.findMany({ orderBy: { createdAt: "desc" }, take: 10, select: { id: true, action: true, targetType: true, createdAt: true, actorId: true } }),
  ]);
  const byStatus = Object.fromEntries(docs.map((d) => [d.status, d._count]));
  const jobCount = (s: string) => jobs.find((j) => j.status === s)?._count ?? 0;
  return {
    users,
    verified,
    newUsers,
    suspended,
    sessions,
    documents: { total: docs.reduce((n, d) => n + d._count, 0), byStatus, bytes: docs.reduce((n, d) => n + (d._sum.sizeBytes ?? 0), 0) },
    jobs: { pending: jobCount("PENDING"), running: jobCount("RUNNING"), failed: jobCount("FAILED") },
    events: events.map((e) => ({ id: e.id, action: e.action, targetType: e.targetType, actor: e.actorId ? `${e.actorId.slice(0, 8)}…` : null, createdAt: e.createdAt.toISOString() })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------------------------------
export async function listUsers(viewer: SessionUser, q: { q?: string | undefined; status?: UserStatus | undefined; role?: Role | undefined; page: number; pageSize: number }) {
  const full = can(viewer, "admin:users:manage"); // ADMIN sees full e-mail; SUPPORT sees it masked and can't substring-search addresses
  const term = q.q;
  const search: Prisma.UserWhereInput | undefined = term
    ? full
      ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] }
      : { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: term.toLowerCase() }] }
    : undefined;
  const where: Prisma.UserWhereInput = { ...(search ?? {}), ...(q.status ? { status: q.status } : {}), ...(q.role ? { role: q.role } : {}) };
  const [total, rows] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true, name: true, email: true, role: true, status: true, emailVerified: true, createdAt: true } }),
  ]);
  const ids = rows.map((r) => r.id);
  const since = new Date(clockNow().getTime() - 30 * DAY);
  const [docs, sessions, tokens] = ids.length
    ? await Promise.all([
        db.document.groupBy({ by: ["ownerId"], where: { ownerId: { in: ids } }, _count: true, _sum: { sizeBytes: true } }),
        db.session.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { updatedAt: true } }),
        db.usageRecord.groupBy({ by: ["userId"], where: { userId: { in: ids }, category: "llm.tokens", createdAt: { gte: since } }, _sum: { quantity: true } }),
      ])
    : [[], [], []];
  return {
    items: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: full ? u.email : maskEmail(u.email),
      role: u.role,
      status: u.status,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt.toISOString(),
      lastSessionAt: sessions.find((s) => s.userId === u.id)?._max.updatedAt?.toISOString() ?? null,
      documents: docs.find((d) => d.ownerId === u.id)?._count ?? 0,
      storageBytes: docs.find((d) => d.ownerId === u.id)?._sum.sizeBytes ?? 0,
      tokens30d: Number(tokens.find((t) => t.userId === u.id)?._sum.quantity ?? 0),
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/**
 * Status/role change with the safety rules of PART5_SPEC §9: never on yourself, never leave the platform without an active ADMIN
 * (serialized with an advisory lock so two concurrent demotions can't both pass), suspension revokes every session immediately.
 */
export async function updateUser(actor: SessionUser, targetId: string, input: { status?: UserStatus | undefined; role?: Role | undefined; reason?: string | undefined }) {
  if (targetId === actor.id) throw new AppError("FORBIDDEN", "You can't change your own role or status. Ask another administrator.");
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-role-change', 0))`;
    const target = await tx.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, status: true } });
    if (!target) throw Errors.notFound();
    const nextRole = input.role ?? target.role;
    const nextStatus = input.status ?? target.status;
    if (target.role === "ADMIN" && target.status === "ACTIVE" && (nextRole !== "ADMIN" || nextStatus !== "ACTIVE")) {
      const activeAdmins = await tx.user.count({ where: { role: "ADMIN", status: "ACTIVE" } });
      if (activeAdmins <= 1) throw new AppError("CONFLICT", "That would leave the platform without an active administrator.");
    }
    const statusChanged = nextStatus !== target.status;
    const roleChanged = nextRole !== target.role;
    if (statusChanged || roleChanged) await tx.user.update({ where: { id: targetId }, data: { status: nextStatus, role: nextRole } });
    let revoked = 0;
    if (statusChanged && nextStatus === "SUSPENDED") revoked = (await tx.session.deleteMany({ where: { userId: targetId } })).count;
    return { from: target, to: { role: nextRole, status: nextStatus }, statusChanged, roleChanged, revoked };
  });
  const reason = input.reason ? trunc(redactString(input.reason), 200) : undefined;
  if (result.statusChanged)
    await recordAudit({ actorId: actor.id, action: "admin.user_status_changed", targetType: "user", targetId, metadata: { from: result.from.status, to: result.to.status, count: result.revoked, ...(reason ? { reason } : {}) } });
  if (result.roleChanged)
    await recordAudit({ actorId: actor.id, action: "admin.user_role_changed", targetType: "user", targetId, metadata: { from: result.from.role, to: result.to.role, ...(reason ? { reason } : {}) } });
  return { id: targetId, role: result.to.role, status: result.to.status, changed: result.statusChanged || result.roleChanged, sessionsRevoked: result.revoked };
}

export async function revokeUserSessions(actor: SessionUser, targetId: string) {
  if (targetId === actor.id) throw new AppError("FORBIDDEN", "Use sign out to end your own sessions.");
  if (!(await db.user.findUnique({ where: { id: targetId }, select: { id: true } }))) throw Errors.notFound();
  const { count } = await db.session.deleteMany({ where: { userId: targetId } });
  await recordAudit({ actorId: actor.id, action: "admin.sessions_revoked", targetType: "user", targetId, metadata: { count } });
  return { revoked: count };
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage (storage, processing, AI aggregates) — aggregates and ids/names only
// ---------------------------------------------------------------------------------------------------------------------
export async function usage() {
  const at = clockNow();
  const [docs, top, ingest, avg, ai7, ai30] = await Promise.all([
    db.document.groupBy({ by: ["status"], _count: true, _sum: { sizeBytes: true } }),
    db.$queryRaw<{ id: string; name: string; bytes: bigint; documents: bigint }[]>`
      SELECT u."id", u."name", sum(d."sizeBytes") AS "bytes", count(*) AS "documents" FROM "Document" d JOIN "User" u ON u."id" = d."ownerId"
      GROUP BY u."id", u."name" ORDER BY sum(d."sizeBytes") DESC, u."id" LIMIT 10`,
    db.job.groupBy({ by: ["status"], where: { type: "ingest" }, _count: true }),
    db.$queryRaw<{ seconds: number | null }[]>`
      SELECT avg(extract(epoch FROM ("processedAt" - "createdAt")))::float8 AS "seconds" FROM "Document"
      WHERE "status" = 'READY' AND "processedAt" IS NOT NULL AND "createdAt" > ${new Date(at.getTime() - 30 * DAY)}`,
    aiByTask(new Date(at.getTime() - 7 * DAY)),
    aiByTask(new Date(at.getTime() - 30 * DAY)),
  ]);
  return {
    storage: {
      documents: docs.reduce((n, d) => n + d._count, 0),
      bytes: docs.reduce((n, d) => n + (d._sum.sizeBytes ?? 0), 0),
      byStatus: docs.map((d) => ({ status: d.status, documents: d._count, bytes: d._sum.sizeBytes ?? 0 })),
      topUsers: top.map((t) => ({ id: t.id, name: t.name, bytes: Number(t.bytes), documents: Number(t.documents) })),
    },
    processing: { ingestJobsByStatus: ingest.map((j) => ({ status: j.status, count: j._count })), averageSeconds30d: avg[0]?.seconds == null ? null : Math.round(avg[0].seconds) },
    ai: { last7Days: ai7, last30Days: ai30 },
  };
}

async function aiByTask(since: Date) {
  const rows = await db.$queryRaw<{ task: string | null; category: string; total: bigint }[]>`
    SELECT "metadata"->>'task' AS "task", "category", sum("quantity") AS "total" FROM "UsageRecord"
    WHERE "category" IN ('llm.tokens','llm.requests') AND "createdAt" >= ${since} GROUP BY 1, 2`;
  const tasks = [...new Set(rows.map((r) => r.task ?? "unknown"))].sort();
  return tasks.map((task) => ({
    task,
    requests: Number(rows.find((r) => (r.task ?? "unknown") === task && r.category === "llm.requests")?.total ?? 0),
    tokens: Number(rows.find((r) => (r.task ?? "unknown") === task && r.category === "llm.tokens")?.total ?? 0),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------------------------------
const CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;

export async function metrics(hours: number) {
  await flushMetrics(); // include this process's pending counters
  const end = hourStart(clockNow());
  const start = new Date(end.getTime() - (hours - 1) * 3_600_000);
  const rows = await db.metricBucket.findMany({ where: { bucket: { gte: start } }, select: { bucket: true, name: true, label: true, count: true } });
  const zero = () => ({ "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 });
  const perHour = new Map<number, ReturnType<typeof zero>>();
  for (let i = 0; i < hours; i++) perHour.set(start.getTime() + i * 3_600_000, zero());
  const byGroup = new Map<string, ReturnType<typeof zero>>();
  const providers = new Map<string, { provider: string; task: string; ok: number; error: number; byCode: Map<string, number> }>();
  const rate = new Map<string, number>();
  const quota = new Map<string, number>();
  for (const r of rows) {
    const [a = "", b = "", c = "", d = ""] = r.label.split("|");
    if (r.name === "api.request" && (CLASSES as readonly string[]).includes(b)) {
      const h = perHour.get(r.bucket.getTime());
      if (h) h[b as (typeof CLASSES)[number]] += r.count;
      const g = byGroup.get(a) ?? zero();
      g[b as (typeof CLASSES)[number]] += r.count;
      byGroup.set(a, g);
    } else if (r.name === "provider.call") {
      const key = `${a}|${b}`;
      const p = providers.get(key) ?? { provider: a, task: b, ok: 0, error: 0, byCode: new Map<string, number>() };
      if (c === "ok") p.ok += r.count;
      else {
        p.error += r.count;
        p.byCode.set(d || "UNKNOWN", (p.byCode.get(d || "UNKNOWN") ?? 0) + r.count);
      }
      providers.set(key, p);
    } else if (r.name === "block.rate_limit") rate.set(r.label, (rate.get(r.label) ?? 0) + r.count);
    else if (r.name === "block.quota") quota.set(r.label, (quota.get(r.label) ?? 0) + r.count);
  }
  const sum = (o: ReturnType<typeof zero>) => o["2xx"] + o["3xx"] + o["4xx"] + o["5xx"];
  const api = [...perHour.entries()].map(([t, v]) => ({ hour: new Date(t).toISOString(), ...v }));
  const totals = api.reduce((acc, h) => ({ requests: acc.requests + sum(h), errors4xx: acc.errors4xx + h["4xx"], errors5xx: acc.errors5xx + h["5xx"] }), { requests: 0, errors4xx: 0, errors5xx: 0 });
  return {
    hours,
    since: start.toISOString(),
    totals,
    api,
    apiByGroup: [...byGroup.entries()].map(([group, v]) => ({ group, total: sum(v), ...v })).sort((x, y) => y.total - x.total),
    providers: [...providers.values()]
      .map((p) => ({ provider: p.provider, task: p.task, ok: p.ok, error: p.error, errorRate: p.ok + p.error > 0 ? p.error / (p.ok + p.error) : null, byCode: [...p.byCode.entries()].map(([code, count]) => ({ code, count })).sort((x, y) => y.count - x.count) }))
      .sort((x, y) => y.error - x.error),
    blocks: {
      rateLimit: [...rate.entries()].map(([group, count]) => ({ group, count })).sort((x, y) => y.count - x.count),
      quota: [...quota.entries()].map(([group, count]) => ({ group, count })).sort((x, y) => y.count - x.count),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------------------------------
export async function jobs() {
  const at = clockNow();
  const [counts, oldest, failures] = await Promise.all([
    db.job.groupBy({ by: ["type", "status"], _count: true }),
    db.job.findFirst({ where: { status: "PENDING", runAt: { lte: at } }, orderBy: { runAt: "asc" }, select: { runAt: true } }),
    db.job.findMany({ where: { status: "FAILED" }, orderBy: { updatedAt: "desc" }, take: 20, select: { id: true, type: true, attempts: true, maxAttempts: true, lastError: true, updatedAt: true } }),
  ]);
  return {
    counts: counts.map((c) => ({ type: c.type, status: c.status, count: c._count })).sort((a, b) => a.type.localeCompare(b.type) || a.status.localeCompare(b.status)),
    oldestPendingSeconds: oldest ? Math.max(0, Math.round((at.getTime() - oldest.runAt.getTime()) / 1000)) : null,
    recentFailures: failures.map((f) => ({ id: f.id, type: f.type, attempts: f.attempts, maxAttempts: f.maxAttempts, lastError: trunc(redactString(f.lastError ?? ""), 200), updatedAt: f.updatedAt.toISOString() })),
  };
}

export async function retryJob(actor: SessionUser, id: string) {
  const { count } = await db.job.updateMany({ where: { id, status: "FAILED" }, data: { status: "PENDING", attempts: 0, runAt: new Date(), lastError: null, lockedAt: null, lockedBy: null } });
  if (count === 0) {
    const exists = await db.job.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw Errors.notFound();
    throw new AppError("CONFLICT", "Only failed jobs can be retried.");
  }
  await recordAudit({ actorId: actor.id, action: "admin.job_retried", targetType: "job", targetId: id });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------------------------
export const HEARTBEAT_INTERVAL_SECONDS = 30;

export async function health(deps: { rag: RagAgentClient; storage: Storage }) {
  const at = clockNow();
  const t0 = Date.now();
  const database: { ok: boolean; latencyMs: number | null } = await db.$queryRaw`SELECT 1`.then(
    () => ({ ok: true, latencyMs: Date.now() - t0 }),
    () => ({ ok: false, latencyMs: null }),
  );
  const ragOk = await deps.rag.ready().catch(() => false);
  const writable = await (async () => {
    const key = `u/_health/${randomBytes(16).toString("hex")}`;
    await deps.storage.put(key, new Uint8Array([1]), "application/octet-stream");
    await deps.storage.delete(key);
    return true;
  })().catch(() => false);
  const [beat, queue] = database.ok
    ? await Promise.all([
        db.serviceHeartbeat.findUnique({ where: { name: "worker" } }),
        Promise.all([db.job.count({ where: { status: "PENDING" } }), db.job.count({ where: { status: "RUNNING" } }), db.job.count({ where: { status: "FAILED" } }), db.job.findFirst({ where: { status: "PENDING", runAt: { lte: at } }, orderBy: { runAt: "asc" }, select: { runAt: true } })]),
      ])
    : [null, [0, 0, 0, null] as const];
  const age = beat ? Math.max(0, Math.round((at.getTime() - beat.beatAt.getTime()) / 1000)) : null;
  const workerStatus = age === null ? "never" : age <= HEARTBEAT_INTERVAL_SECONDS * 3 ? "ok" : age <= 600 ? "stale" : "down";
  const overall = database.ok && ragOk && writable && (workerStatus === "ok" || !getEnv().JOB_WORKER_ENABLED) ? "ok" : database.ok ? "degraded" : "down";
  return {
    status: overall,
    database,
    ragAgent: { ok: ragOk },
    worker: { enabledHere: getEnv().JOB_WORKER_ENABLED, lastBeatAt: beat?.beatAt.toISOString() ?? null, ageSeconds: age, status: workerStatus },
    queue: { pending: queue[0], running: queue[1], failed: queue[2], oldestPendingSeconds: queue[3] ? Math.max(0, Math.round((at.getTime() - queue[3].runAt.getTime()) / 1000)) : null },
    storage: { driver: deps.storage.driver, writable },
    runtime: { node: process.version, uptimeSeconds: Math.round(process.uptime()), environment: getEnv().NODE_ENV },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------------------------------
const META_ALLOW = new Set(["via", "reason", "from", "to", "status", "role", "count", "format", "kind", "created", "tasks", "slot", "runId", "provider", "keyChanged", "embeddingChanged"]);

function safeMetadata(meta: unknown): Record<string, string | number | boolean> | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (!META_ALLOW.has(k)) continue;
    if (typeof v === "string") out[k] = trunc(redactString(v), 100)!;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export async function auditEvents(q: { action?: string | undefined; actor?: string | undefined; from?: string | undefined; to?: string | undefined; page: number; pageSize: number }) {
  const where: Prisma.AuditEventWhereInput = {
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.actor ? { actorId: q.actor } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
  };
  const [total, rows] = await Promise.all([
    db.auditEvent.count({ where }),
    db.auditEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  return {
    items: rows.map((e) => ({
      id: e.id,
      action: e.action,
      targetType: e.targetType,
      targetId: trunc(e.targetId, 12),
      actor: e.actorId ? `${e.actorId.slice(0, 8)}…` : null,
      ipHash: e.ipHash ? e.ipHash.slice(0, 8) : null,
      metadata: safeMetadata(e.metadata),
      createdAt: e.createdAt.toISOString(),
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Configuration: an explicit allow-list of NON-secret effective settings. Nothing is copied from process.env wholesale.
// ---------------------------------------------------------------------------------------------------------------------
export function effectiveConfig() {
  const e = getEnv();
  return {
    environment: e.NODE_ENV,
    appOrigin: new URL(e.APP_URL).origin,
    flags: {
      mockProviderEnabled: e.ALLOW_MOCK_PROVIDER,
      emailVerificationRequired: e.AUTH_REQUIRE_EMAIL_VERIFICATION,
      jobWorkerEnabled: e.JOB_WORKER_ENABLED,
      videoUploadsEnabled: e.VIDEO_UPLOADS_ENABLED,
      smtpConfigured: Boolean(e.SMTP_URL),
    },
    storage: { driver: e.STORAGE_DRIVER },
    providers: enabledProviders().map((p) => p.toLowerCase()),
    limits: {
      uploads: { maxUploadBytes: e.MAX_UPLOAD_BYTES, maxFilesPerUpload: e.MAX_FILES_PER_UPLOAD, userStorageQuotaBytes: e.USER_STORAGE_QUOTA_BYTES, maxDocumentsPerUser: e.MAX_DOCUMENTS_PER_USER },
      ai: {
        dailyTokenLimit: e.AI_DAILY_TOKEN_LIMIT, dailyRequestLimit: e.AI_DAILY_REQUEST_LIMIT, monthlyTokenLimit: e.AI_MONTHLY_TOKEN_LIMIT, monthlyRequestLimit: e.AI_MONTHLY_REQUEST_LIMIT,
        chatMaxMessageChars: e.CHAT_MAX_MESSAGE_CHARS, retrievalTopK: e.RETRIEVAL_TOP_K, ragAgentTimeoutMs: e.RAG_AGENT_TIMEOUT_MS,
      },
      generation: {
        mcqMaxQuestionsPerRun: e.MCQ_MAX_QUESTIONS_PER_RUN, cqMaxQuestionsPerRun: e.CQ_MAX_QUESTIONS_PER_RUN, maxLlmCalls: e.GEN_MAX_LLM_CALLS, maxOutputTokens: e.GEN_MAX_OUTPUT_TOKENS,
        timeoutMs: e.GEN_TIMEOUT_MS, ratePerMinute: e.GEN_RATE_PER_MINUTE,
      },
      exams: { maxQuestions: e.EXAM_MAX_QUESTIONS, maxDurationMinutes: e.EXAM_MAX_DURATION_MINUTES, maxAttemptLimit: e.EXAM_MAX_ATTEMPT_LIMIT, graceSeconds: e.EXAM_GRACE_SECONDS, sweepIntervalSeconds: e.EXAM_SWEEP_INTERVAL_SECONDS },
      groups: { maxOwnedPerUser: e.GROUP_MAX_OWNED_PER_USER, maxCapacity: e.GROUP_MAX_CAPACITY, inviteMaxUses: e.INVITE_MAX_USES, inviteAttemptsPerHourUser: e.INVITE_ATTEMPTS_PER_HOUR_USER, inviteAttemptsPerHourIp: e.INVITE_ATTEMPTS_PER_HOUR_IP },
      analysis: { maxAttempts: e.ANALYSIS_MAX_ATTEMPTS, maxOutputTokens: e.ANALYSIS_MAX_OUTPUT_TOKENS, retryPerHour: e.ANALYSIS_RETRY_PER_HOUR },
      operations: { jobConcurrency: e.JOB_CONCURRENCY, jobPollIntervalMs: e.JOB_POLL_INTERVAL_MS, metricsRetentionDays: e.METRICS_RETENTION_DAYS, metricsFlushSeconds: e.METRICS_FLUSH_SECONDS },
    },
    secretsNote: "Secret values (keys, tokens, connection strings) are never shown here.",
  };
}
