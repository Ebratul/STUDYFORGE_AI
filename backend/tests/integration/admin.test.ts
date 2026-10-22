import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { setClock } from "../../src/lib/clock.js";
import { maskEmail, updateUser } from "../../src/modules/admin/service.js";
import { heartbeatOnce } from "../../src/modules/admin/jobs.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { opsHandlers } from "../../src/modules/admin/jobs.js";
import { recordAudit } from "../../src/lib/audit.js";
import { client, makeApp, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, signInAgain, type TestUser } from "../helpers/users.js";
import { seedBankQuestions, seedPublishedExam } from "../helpers/exam-fixtures.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
  setClock(null);
});

const asRole = async (role: "USER" | "SUPPORT" | "ADMIN", overrides: { name?: string; email?: string } = {}) => {
  const u = await createUser(overrides);
  if (role !== "USER") await db.user.update({ where: { id: u.id }, data: { role } });
  return u;
};
const status = async (u: TestUser, method: "get" | "post" | "patch", path: string, body?: unknown) => {
  const c = client(t, u);
  return (await (method === "get" ? c.get(path) : method === "post" ? c.post(path, body) : c.patch(path, body))).status;
};

describe("admin permission matrix", () => {
  const view = ["/api/admin/overview", "/api/admin/users", "/api/admin/usage", "/api/admin/metrics", "/api/admin/jobs", "/api/admin/health", "/api/admin/audit"];
  const adminOnlyGet = ["/api/admin/config"];

  it("anonymous callers get 401 everywhere", async () => {
    const c = client(t);
    for (const p of [...view, ...adminOnlyGet]) expect((await c.get(p)).status, p).toBe(401);
    expect((await c.patch("/api/admin/users/x", { status: "SUSPENDED" })).status).toBe(401);
  });

  it("regular users get 404 on every admin route (the surface isn't advertised)", async () => {
    const u = await asRole("USER");
    for (const p of [...view, ...adminOnlyGet]) expect(await status(u, "get", p), p).toBe(404);
    expect(await status(u, "patch", "/api/admin/users/x", { status: "SUSPENDED" })).toBe(404);
    expect(await status(u, "post", "/api/admin/users/x/revoke-sessions")).toBe(404);
    expect(await status(u, "post", "/api/admin/jobs/x/retry")).toBe(404);
  });

  it("SUPPORT can read operational views but not config or any mutation", async () => {
    const s = await asRole("SUPPORT");
    for (const p of view) expect(await status(s, "get", p), p).toBe(200);
    expect(await status(s, "get", "/api/admin/config")).toBe(404);
    const target = await asRole("USER");
    expect(await status(s, "patch", `/api/admin/users/${target.id}`, { status: "SUSPENDED" })).toBe(404);
    expect(await status(s, "post", `/api/admin/users/${target.id}/revoke-sessions`)).toBe(404);
    expect(await status(s, "post", "/api/admin/jobs/x/retry")).toBe(404);
    expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("ACTIVE");
  });

  it("ADMIN can use everything, and role changes apply to an existing session immediately", async () => {
    const a = await asRole("ADMIN");
    for (const p of [...view, ...adminOnlyGet]) expect(await status(a, "get", p), p).toBe(200);
    await db.user.update({ where: { id: a.id }, data: { role: "USER" } });
    expect(await status(a, "get", "/api/admin/overview")).toBe(404);
    await db.user.update({ where: { id: a.id }, data: { role: "SUPPORT" } });
    expect(await status(a, "get", "/api/admin/overview")).toBe(200);
    expect(await status(a, "get", "/api/admin/config")).toBe(404);
  });

  it("a suspended administrator has no access at all", async () => {
    const a = await asRole("ADMIN");
    await db.user.update({ where: { id: a.id }, data: { status: "SUSPENDED" } });
    expect(await status(a, "get", "/api/admin/overview")).toBe(401);
  });
});

describe("overview and users", () => {
  it("returns aggregates and recent events without e-mail addresses", async () => {
    const a = await asRole("ADMIN");
    const body = await (await client(t, a).get("/api/admin/overview")).json();
    expect(body).toMatchObject({ users: expect.any(Number), verified: expect.any(Number), newUsers: expect.any(Number), suspended: expect.any(Number), sessions: expect.any(Number) });
    expect(body.documents).toMatchObject({ total: expect.any(Number), bytes: expect.any(Number) });
    expect(body.jobs).toMatchObject({ pending: expect.any(Number), running: expect.any(Number), failed: expect.any(Number) });
    expect(Array.isArray(body.events)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/@example\.test/);
  });

  it("lists users with search, filters and capped pagination; ADMIN sees full e-mail, SUPPORT a masked one", async () => {
    const tag = randomUUID().slice(0, 8);
    const [a, s] = [await asRole("ADMIN"), await asRole("SUPPORT")];
    const target = await createUser({ name: `Zed ${tag}`, email: `zed.${tag}@example.test` });
    await db.document.create({ data: { ownerId: target.id, name: "secret-notes.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: 2048, sha256: randomUUID(), storageKey: `u/${target.id}/${randomUUID().replaceAll("-", "")}`, status: "READY" } });
    await db.usageRecord.create({ data: { userId: target.id, category: "llm.tokens", quantity: 1234n, metadata: { task: "CHAT" } } });

    const full = await (await client(t, a).get(`/api/admin/users?q=${tag}`)).json();
    expect(full.total).toBe(1);
    expect(full.items[0]).toMatchObject({ id: target.id, name: `Zed ${tag}`, email: `zed.${tag}@example.test`, role: "USER", status: "ACTIVE", documents: 1, storageBytes: 2048, tokens30d: 1234 });
    expect(Object.keys(full.items[0]).sort()).toEqual(["createdAt", "documents", "email", "emailVerified", "id", "lastSessionAt", "name", "role", "status", "storageBytes", "tokens30d"]);
    expect(JSON.stringify(full)).not.toContain("secret-notes.pdf"); // aggregates only, never document names

    const byName = await (await client(t, s).get(`/api/admin/users?q=Zed ${tag}`)).json();
    expect(byName.items[0].email).toBe(maskEmail(`zed.${tag}@example.test`));
    expect(byName.items[0].email).not.toContain("zed.");
    // SUPPORT cannot probe addresses by substring; an exact address finds the (masked) user
    expect((await (await client(t, s).get(`/api/admin/users?q=zed.${tag}`)).json()).total).toBe(0);
    expect((await (await client(t, s).get(`/api/admin/users?q=zed.${tag}@example.test`)).json()).total).toBe(1);

    expect((await (await client(t, a).get(`/api/admin/users?role=SUPPORT&pageSize=2`)).json()).items.every((x: { role: string }) => x.role === "SUPPORT")).toBe(true);
    expect((await client(t, a).get("/api/admin/users?pageSize=51")).status).toBe(422);
    expect((await client(t, a).get("/api/admin/users?role=ROOT")).status).toBe(422);
    const p1 = await (await client(t, a).get("/api/admin/users?pageSize=2")).json();
    const p2 = await (await client(t, a).get("/api/admin/users?pageSize=2&page=2")).json();
    expect(p1.items).toHaveLength(2);
    expect(p2.items.map((x: { id: string }) => x.id)).not.toEqual(expect.arrayContaining(p1.items.map((x: { id: string }) => x.id)));
  });

  it("masks e-mail addresses predictably", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@e***.com");
    expect(maskEmail("b@x.co.uk")).toBe("b***@x***.uk");
  });
});

describe("user management guards", () => {
  it("validates the body strictly and returns 404 for unknown users", async () => {
    const a = await asRole("ADMIN");
    const c = client(t, a);
    const target = await createUser();
    expect((await c.patch(`/api/admin/users/${target.id}`, {})).status).toBe(422);
    expect((await c.patch(`/api/admin/users/${target.id}`, { status: "BANNED" })).status).toBe(422);
    expect((await c.patch(`/api/admin/users/${target.id}`, { status: "ACTIVE", email: "x@y.z" })).status).toBe(422);
    expect((await c.patch("/api/admin/users/does-not-exist", { status: "SUSPENDED" })).status).toBe(404);
    expect((await c.post("/api/admin/users/does-not-exist/revoke-sessions")).status).toBe(404);
  });

  it("can't change your own role or status or revoke your own sessions", async () => {
    const a = await asRole("ADMIN");
    const c = client(t, a);
    expect((await c.patch(`/api/admin/users/${a.id}`, { role: "USER" })).status).toBe(403);
    expect((await c.patch(`/api/admin/users/${a.id}`, { status: "SUSPENDED" })).status).toBe(403);
    expect((await c.post(`/api/admin/users/${a.id}/revoke-sessions`)).status).toBe(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: a.id } })).role).toBe("ADMIN");
  });

  it("suspension revokes every session at once, blocks the API and sign-in, and is audited; re-activation restores access", async () => {
    const a = await asRole("ADMIN");
    const target = await createUser();
    const second = await signInAgain(target);
    const c = client(t, a);
    expect(await status(target, "get", "/api/me")).toBe(200);
    expect(await db.session.count({ where: { userId: target.id } })).toBeGreaterThanOrEqual(2);

    const res = await c.patch(`/api/admin/users/${target.id}`, { status: "SUSPENDED", reason: "abuse report #12" });
    expect(res.status).toBe(200);
    expect((await res.json()).user).toMatchObject({ id: target.id, status: "SUSPENDED", changed: true });
    expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await status(target, "get", "/api/me")).toBe(401);
    expect((await t.app.request("/api/me", { headers: second })).status).toBe(401);
    await expect(signInAgain(target)).rejects.toThrow(); // sign-in refused while suspended

    const events = await db.auditEvent.findMany({ where: { action: "admin.user_status_changed", targetId: target.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: a.id });
    expect(events[0]!.metadata).toMatchObject({ from: "ACTIVE", to: "SUSPENDED", reason: "abuse report #12" });

    expect((await c.patch(`/api/admin/users/${target.id}`, { status: "ACTIVE" })).status).toBe(200);
    expect(await signInAgain(target)).toBeTruthy();
  });

  it("role changes are audited, apply immediately, and an unchanged request is a no-op", async () => {
    const a = await asRole("ADMIN");
    const target = await createUser();
    const c = client(t, a);
    expect(await status(target, "get", "/api/admin/overview")).toBe(404);
    expect((await (await c.patch(`/api/admin/users/${target.id}`, { role: "SUPPORT" })).json()).user).toMatchObject({ role: "SUPPORT", changed: true });
    expect(await status(target, "get", "/api/admin/overview")).toBe(200); // same cookie, no re-login
    expect((await (await c.patch(`/api/admin/users/${target.id}`, { role: "SUPPORT" })).json()).user.changed).toBe(false);
    expect(await db.auditEvent.count({ where: { action: "admin.user_role_changed", targetId: target.id } })).toBe(1);
  });

  it("never leaves the platform without an active administrator, even when two admins demote each other concurrently", async () => {
    const [a, b] = [await asRole("ADMIN"), await asRole("ADMIN")];
    // make these two the only admins for the duration of the test
    const others = await db.user.findMany({ where: { role: "ADMIN", id: { notIn: [a.id, b.id] } }, select: { id: true } });
    await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { role: "USER" } });
    try {
      const actor = (u: TestUser) => ({ id: u.id, name: u.name, email: u.email, emailVerified: true, image: null, role: "ADMIN" as const, status: "ACTIVE" as const });
      const results = await Promise.allSettled([updateUser(actor(a), b.id, { role: "USER" }), updateUser(actor(b), a.id, { role: "USER" })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "CONFLICT" });
      expect(await db.user.count({ where: { role: "ADMIN", status: "ACTIVE" } })).toBe(1);
    } finally {
      await db.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { role: "ADMIN" } });
    }
  });

  it("revoke-sessions ends the user's sessions and records how many", async () => {
    const a = await asRole("ADMIN");
    const target = await createUser();
    await signInAgain(target);
    const res = await (await client(t, a).post(`/api/admin/users/${target.id}/revoke-sessions`)).json();
    expect(res.revoked).toBeGreaterThanOrEqual(2);
    expect(await status(target, "get", "/api/me")).toBe(401);
    expect((await db.auditEvent.findFirstOrThrow({ where: { action: "admin.sessions_revoked", targetId: target.id } })).metadata).toMatchObject({ count: res.revoked });
  });
});

describe("usage, jobs, health", () => {
  it("usage returns storage, processing and AI aggregates with ids and names only", async () => {
    const a = await asRole("ADMIN");
    const u = await createUser({ name: "Heavy User", email: `heavy.${randomUUID()}@example.test` });
    await db.document.create({ data: { ownerId: u.id, name: "private-file.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: 9_999_999, sha256: randomUUID(), storageKey: `u/${u.id}/${randomUUID().replaceAll("-", "")}`, status: "READY", processedAt: new Date(), createdAt: new Date(Date.now() - 4000) } });
    await db.usageRecord.createMany({ data: [{ userId: u.id, category: "llm.tokens", quantity: 500n, metadata: { task: "CHAT" } }, { userId: u.id, category: "llm.requests", quantity: 2n, metadata: { task: "CHAT" } }] });
    const body = await (await client(t, a).get("/api/admin/usage")).json();
    expect(body.storage.topUsers[0]).toMatchObject({ id: u.id, name: "Heavy User", bytes: 9_999_999, documents: 1 });
    expect(Object.keys(body.storage.topUsers[0]).sort()).toEqual(["bytes", "documents", "id", "name"]);
    expect(body.storage.byStatus.find((s: { status: string }) => s.status === "READY")).toBeTruthy();
    expect(body.processing).toMatchObject({ ingestJobsByStatus: expect.any(Array) });
    const chat = body.ai.last7Days.find((x: { task: string }) => x.task === "CHAT");
    expect(chat.tokens).toBeGreaterThanOrEqual(500);
    expect(chat.requests).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(body)).not.toMatch(/private-file|@example\.test/);
  });

  it("jobs: counts by type/status, redacted truncated failures, retry only for FAILED, audited", async () => {
    const a = await asRole("ADMIN");
    const failed = await db.job.create({ data: { type: "ingest", payload: { documentId: "d1" }, status: "FAILED", attempts: 4, maxAttempts: 4, lastError: `connect postgresql://admin:hunter2pass@db.internal:5432/x failed ${"x".repeat(400)} sk-abcdefghijklmnopqrstuv` } });
    const pending = await db.job.create({ data: { type: "exam.expire", payload: {}, status: "PENDING", runAt: new Date(Date.now() - 30_000) } });
    const body = await (await client(t, a).get("/api/admin/jobs")).json();
    expect(body.counts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "ingest", status: "FAILED" }), expect.objectContaining({ type: "exam.expire", status: "PENDING" })]));
    expect(body.oldestPendingSeconds).toBeGreaterThanOrEqual(30);
    const f = body.recentFailures.find((x: { id: string }) => x.id === failed.id);
    expect(f.lastError.length).toBeLessThanOrEqual(201);
    expect(f.lastError).not.toMatch(/hunter2pass|sk-abcdef/);

    const c = client(t, a);
    expect((await c.post(`/api/admin/jobs/${pending.id}/retry`)).status).toBe(409);
    expect((await c.post("/api/admin/jobs/nope/retry")).status).toBe(404);
    expect((await c.post(`/api/admin/jobs/${failed.id}/retry`)).status).toBe(200);
    expect(await db.job.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "PENDING", attempts: 0, lastError: null });
    expect(await db.auditEvent.count({ where: { action: "admin.job_retried", targetId: failed.id, actorId: a.id } })).toBe(1);
    expect((await c.post(`/api/admin/jobs/${failed.id}/retry`)).status).toBe(409); // already pending
  });

  it("health reports dependencies, the worker heartbeat and the queue, without secrets or connection strings", async () => {
    const a = await asRole("ADMIN");
    await db.serviceHeartbeat.deleteMany();
    const never = await (await client(t, a).get("/api/admin/health")).json();
    expect(never).toMatchObject({ database: { ok: true }, ragAgent: { ok: true }, storage: { driver: "local", writable: true }, worker: { lastBeatAt: null, ageSeconds: null, status: "never" } });
    expect(never.queue).toEqual({ pending: expect.any(Number), running: expect.any(Number), failed: expect.any(Number), oldestPendingSeconds: expect.anything() });
    expect(t.storage.files.size).toBe(0); // the writable probe cleans up after itself

    await heartbeatOnce();
    expect((await (await client(t, a).get("/api/admin/health")).json()).worker.status).toBe("ok");
    setClock(() => new Date(Date.now() + 200 * 1000));
    expect((await (await client(t, a).get("/api/admin/health")).json()).worker.status).toBe("stale");
    setClock(() => new Date(Date.now() + 3600 * 1000));
    expect((await (await client(t, a).get("/api/admin/health")).json()).worker.status).toBe("down");
    setClock(null);

    t.rag.available = false;
    const degraded = await (await client(t, a).get("/api/admin/health")).json();
    expect(degraded.ragAgent.ok).toBe(false);
    expect(degraded.status).toBe("degraded");
    const raw = JSON.stringify(degraded);
    for (const secret of [process.env.BETTER_AUTH_SECRET!, process.env.CREDENTIAL_ENCRYPTION_KEY!, process.env.RAG_AGENT_TOKEN!, process.env.DATABASE_URL!, "postgresql://", "127.0.0.1:9"]) expect(raw).not.toContain(secret);
  });

  it("the ops heartbeat job writes the heartbeat and re-queues itself in the other slot", async () => {
    await db.job.deleteMany({ where: { type: "ops.heartbeat" } });
    await db.job.create({ data: { type: "ops.heartbeat", payload: { slot: "a" }, dedupeKey: "ops-heartbeat-a" } });
    await db.serviceHeartbeat.deleteMany();
    expect(await runDueJobs(opsHandlers())).toBeGreaterThanOrEqual(1);
    expect(await db.serviceHeartbeat.count({ where: { name: "worker" } })).toBe(1);
    const next = await db.job.findFirstOrThrow({ where: { type: "ops.heartbeat", status: "PENDING" } });
    expect(next).toMatchObject({ dedupeKey: "ops-heartbeat-b", payload: { slot: "b" } });
    expect(next.runAt.getTime()).toBeGreaterThan(Date.now());
    await db.job.deleteMany({ where: { type: "ops.heartbeat" } });
  });
});

describe("audit and config", () => {
  it("filters, paginates (cap 100), truncates ids and exposes only allow-listed metadata", async () => {
    const a = await asRole("ADMIN");
    const actor = await createUser();
    const tag = `ztest.${randomUUID().slice(0, 6)}`;
    await recordAudit({ actorId: actor.id, action: "admin.job_retried", targetType: "job", targetId: "j".repeat(30), metadata: { reason: "ok", count: 3, apiKey: "sk-abcdefghijklmnopqrstuvwxyz", note: "internal note", nested: { a: 1 }, token: "abc" } });
    await recordAudit({ actorId: actor.id, action: "group.created", targetType: "group", targetId: tag });
    const c = client(t, a);
    const byAction = await (await c.get(`/api/admin/audit?action=admin.job&actor=${actor.id}`)).json();
    expect(byAction.total).toBe(1);
    const e = byAction.items[0];
    expect(e.metadata).toEqual({ reason: "ok", count: 3 });
    expect(e.targetId).toBe(`${"j".repeat(12)}…`);
    expect(e.actor).toBe(`${actor.id.slice(0, 8)}…`);
    expect(JSON.stringify(byAction)).not.toMatch(/sk-abc|internal note|"token"/);
    expect((await (await c.get(`/api/admin/audit?actor=${actor.id}&action=group.created`)).json()).total).toBe(1);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await (await c.get(`/api/admin/audit?actor=${actor.id}&from=${encodeURIComponent(future)}`)).json()).total).toBe(0);
    expect((await c.get("/api/admin/audit?pageSize=101")).status).toBe(422);
    expect((await c.get("/api/admin/audit?from=yesterday")).status).toBe(422);
    expect((await c.get("/api/admin/audit?action=a%20b%3B--")).status).toBe(422);
  });

  it("config is built from an allow-list: effective limits and flags, never a secret", async () => {
    const a = await asRole("ADMIN");
    const body = await (await client(t, a).get("/api/admin/config")).json();
    expect(body.config).toMatchObject({ environment: "test", appOrigin: "http://localhost:3100", flags: { mockProviderEnabled: true, jobWorkerEnabled: false, smtpConfigured: false }, storage: { driver: "local" } });
    expect(body.config.providers).toContain("openai");
    expect(body.config.limits.exams.maxQuestions).toBe(200);
    const raw = JSON.stringify(body);
    const secrets = [process.env.BETTER_AUTH_SECRET, process.env.CREDENTIAL_ENCRYPTION_KEY, process.env.RAG_AGENT_TOKEN, process.env.DATABASE_URL, process.env.RAG_AGENT_URL, process.env.LOCAL_STORAGE_DIR];
    for (const s of secrets) expect(raw).not.toContain(s!);
    expect(raw).not.toMatch(/postgres|password|secret_key|apikey/i);
    // adding a secret-looking env var must not change the response
    process.env.S3_SECRET_ACCESS_KEY = "super-secret-s3-value";
    process.env.SMTP_URL = "smtp://user:pw@mail.example:25";
    try {
      const { resetEnvCache } = await import("../../src/config/env.js");
      resetEnvCache();
      const again = JSON.stringify(await (await client(t, a).get("/api/admin/config")).json());
      expect(again).not.toMatch(/super-secret-s3-value|user:pw|mail\.example/);
      expect(JSON.parse(again).config.flags.smtpConfigured).toBe(true);
    } finally {
      delete process.env.S3_SECRET_ACCESS_KEY;
      delete process.env.SMTP_URL;
      const { resetEnvCache } = await import("../../src/config/env.js");
      resetEnvCache();
    }
  });
});

describe("administrators have no path into private content", () => {
  it("an ADMIN session gets 404 on another user's conversations, questions, collections, runs, exams, attempts and groups", async () => {
    const [admin, victim] = [await asRole("ADMIN"), await createUser({ name: "Victim", email: `victim.${randomUUID()}@example.test` })];
    await setupAi(t, victim);
    const vc = client(t, victim);
    const conv = (await (await vc.post("/api/conversations", { title: "Private diary" })).json()).conversation.id as string;
    await db.message.create({ data: { conversationId: conv, role: "USER", content: "my private message text" } });
    const [q] = await seedBankQuestions(victim, 1);
    const col = (await (await vc.post("/api/collections", { title: "Victim set" })).json()).collection.id as string;
    const group = await db.group.create({ data: { ownerId: victim.id, title: "Victim group", capacity: 5 } });
    await db.groupMember.create({ data: { groupId: group.id, userId: victim.id, role: "OWNER" } });
    const { exam, version } = await seedPublishedExam({ owner: victim, questionCount: 2 });
    const attempt = await db.examAttempt.create({ data: { examVersionId: version.id, userId: victim.id, attemptNo: 1, status: "IN_PROGRESS", startedAt: new Date(), deadlineAt: new Date(Date.now() + 3_600_000), questionOrder: [], optionOrder: {} } });
    const doc = await db.document.create({ data: { ownerId: victim.id, name: "victim-secret.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: 10, sha256: randomUUID(), storageKey: `u/${victim.id}/${randomUUID().replaceAll("-", "")}`, status: "READY" } });
    const run = await db.generationRun.create({ data: { userId: victim.id, kind: "MCQ", status: "SUCCEEDED", settings: {}, provider: "MOCK", model: "m", result: { questions: [] }, expiresAt: new Date(Date.now() + 1e9) } });

    const ac = client(t, admin);
    const paths = [
      `/api/conversations/${conv}`, `/api/conversations/${conv}/messages`, `/api/questions/${q!.id}`, `/api/questions/${q!.id}/revisions`, `/api/collections/${col}`, `/api/collections/${col}/questions`,
      `/api/generation/runs/${run.id}`, `/api/exams/${exam.id}`, `/api/attempts/${attempt.id}`, `/api/attempts/${attempt.id}/result`, `/api/groups/${group.id}`, `/api/groups/${group.id}/members`,
      `/api/documents/${doc.id}`,
    ];
    for (const p of paths) expect((await ac.get(p)).status, p).toBe(404);
    expect((await ac.delete(`/api/conversations/${conv}`)).status).toBe(404);
    // "my attempts for this exam" lists only the caller's own attempts: for an admin it is empty (same answer as for a nonexistent exam)
    expect(await (await ac.get(`/api/exams/${exam.id}/attempts`)).json()).toEqual({ items: [] });
    expect(await (await ac.get("/api/exams/nonexistent/attempts")).json()).toEqual({ items: [] });
    expect((await ac.put(`/api/attempts/${attempt.id}/answers`, { answers: [{ questionId: "q", optionId: null, seq: 1 }] })).status).toBe(404);
    expect((await ac.post(`/api/attempts/${attempt.id}/submit`, {})).status).toBe(404);
    // the admin's own lists never contain the victim's data, and there is no credential endpoint that takes another user id
    const own = JSON.stringify([await (await ac.get("/api/conversations")).json(), await (await ac.get("/api/documents")).json(), await (await ac.get("/api/ai/credentials")).json(), await (await ac.get("/api/questions")).json()]);
    expect(own).not.toMatch(/Private diary|victim-secret|mock-valid-key|Victim set/);
    expect((await ac.get(`/api/ai/credentials/mock`)).status).not.toBe(200);
    expect(await db.document.count({ where: { id: doc.id } })).toBe(1);
  });

  it("no admin response ever contains secrets or private content seeded for other users", async () => {
    const [admin, victim] = [await asRole("ADMIN"), await createUser({ name: "Quiet Victim", email: `quiet.${randomUUID()}@example.test` })];
    await setupAi(t, victim); // stores an encrypted provider key for the victim
    const conv = (await (await client(t, victim).post("/api/conversations", { title: "Confidential chat title" })).json()).conversation.id as string;
    await db.message.create({ data: { conversationId: conv, role: "USER", content: "confidential chat body" } });
    await db.document.create({ data: { ownerId: victim.id, name: "confidential-doc.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: 5, sha256: randomUUID(), storageKey: `u/${victim.id}/${randomUUID().replaceAll("-", "")}`, status: "READY" } });
    const cred = await db.providerCredential.findFirstOrThrow({ where: { userId: victim.id } });
    const c = client(t, admin);
    const all: string[] = [];
    for (const p of ["overview", "users?q=Quiet", "usage", "metrics", "jobs", "health", "audit?pageSize=100", "config"]) all.push(JSON.stringify(await (await c.get(`/api/admin/${p}`)).json()));
    const blob = all.join("\n");
    for (const forbidden of ["mock-valid-key", cred.ciphertext, cred.iv, cred.authTag, "Confidential chat", "confidential-doc", process.env.BETTER_AUTH_SECRET!, process.env.CREDENTIAL_ENCRYPTION_KEY!, process.env.RAG_AGENT_TOKEN!]) expect(blob).not.toContain(forbidden);
    expect(blob).not.toMatch(/ciphertext|authTag|"password"|"token"/);
  });
});
