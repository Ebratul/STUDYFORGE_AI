import { describe, expect, it } from "vitest";
import {
  activeTab, adminTabs, apiTotals, asRole, canManageJobs, canManageUsers, canViewConfig, clampPage, describeUserAction, emailDisplay, formatAge, isAdminConsoleRole, isSecretKey,
  MAX_REASON, normalizeHealth, pageCount, providerErrorRates, queueState, readConfig, readCounts, readHealth, readJobs, readMetrics, readOverview, readPaged, readUsage, readUserRow,
  safeConfigValue, sumTasks, userPatchBody, worstHealth, workerState,
} from "@/lib/admin";
import { auditPath, describeAdminError, metricsPath, usersPath } from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { mergeTasks } from "@/components/admin/usage-view";

describe("role-based visibility (display only; the server enforces every rule)", () => {
  it("only ADMIN and SUPPORT reach the console; unknown roles are the least privileged", () => {
    expect(isAdminConsoleRole("ADMIN")).toBe(true);
    expect(isAdminConsoleRole("SUPPORT")).toBe(true);
    expect(isAdminConsoleRole("USER")).toBe(false);
    expect(isAdminConsoleRole(undefined)).toBe(false);
    expect(asRole("SUPERUSER")).toBe("USER");
    expect(asRole(null)).toBe("USER");
  });
  it("mutation controls are for ADMIN only; SUPPORT is read-only", () => {
    for (const f of [canManageUsers, canManageJobs, canViewConfig]) {
      expect(f("ADMIN")).toBe(true);
      expect(f("SUPPORT")).toBe(false);
      expect(f("USER")).toBe(false);
    }
  });
  it("the Config tab is not offered to SUPPORT", () => {
    expect(adminTabs("ADMIN").map((t) => t.slug)).toEqual(["overview", "users", "usage", "metrics", "jobs", "health", "audit", "config"]);
    expect(adminTabs("SUPPORT").map((t) => t.slug)).not.toContain("config");
  });
  it("marks the active tab from the path ('/admin' only matches the overview)", () => {
    expect(activeTab("/admin")).toBe("overview");
    expect(activeTab("/admin/users")).toBe("users");
    expect(activeTab("/admin/audit/anything")).toBe("audit");
    expect(activeTab("/admin/usage")).toBe("usage");
  });
});

describe("pagination and formatting", () => {
  it("counts pages and clamps the current page", () => {
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(41, 20)).toBe(3);
    expect(pageCount(-5, 20)).toBe(1);
    expect(clampPage(9, 41, 20)).toBe(3);
    expect(clampPage(0, 41, 20)).toBe(1);
  });
  it("formats ages", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(5)).toBe("5s");
    expect(formatAge(125)).toBe("2m 5s");
    expect(formatAge(3700)).toBe("1h 1m");
    expect(formatAge(90_000)).toBe("1d 1h");
  });
  it("reads counts from maps and lists", () => {
    expect(readCounts({ READY: 3, FAILED: 1 })).toEqual([{ key: "READY", count: 3 }, { key: "FAILED", count: 1 }]);
    expect(readCounts([{ status: "QUEUED", count: 2 }, { type: "x", n: 4 }])).toEqual([{ key: "QUEUED", count: 2 }, { key: "x", count: 4 }]);
    expect(readCounts(undefined)).toEqual([]);
  });
});

describe("readers follow the real response shapes and never invent data", () => {
  it("reads the overview exactly (documents.byStatus map, jobs {pending,running,failed}) and caps events at 10", () => {
    const o = readOverview({ users: 10, verified: 8, newUsers: 2, suspended: 1, sessions: 3, documents: { total: 5, byStatus: { READY: 4, FAILED: 1 }, bytes: 2048 }, jobs: { pending: 1, running: 0, failed: 2 }, events: Array.from({ length: 15 }, (_, i) => ({ id: `e${i}`, action: "x", targetType: "user", actor: "a", createdAt: "2026-01-01T00:00:00Z" })) });
    expect(o).toMatchObject({ users: 10, suspended: 1, documents: { total: 5, bytes: 2048 } });
    expect(o.documents.byStatus).toEqual([{ key: "READY", count: 4 }, { key: "FAILED", count: 1 }]);
    expect(o.jobs.byStatus).toEqual([{ key: "PENDING", count: 1 }, { key: "RUNNING", count: 0 }, { key: "FAILED", count: 2 }]);
    expect(o.events).toHaveLength(10);
    expect(readOverview(null)).toMatchObject({ users: 0, suspended: 0, documents: { total: 0, bytes: 0, byStatus: [] }, events: [] });
  });
  it("reads audit metadata as primitives only", () => {
    const o = readOverview({ events: [{ id: "1", action: "a", metadata: { ok: true, n: 3, s: "x", nested: { secret: "no" }, list: [1] } }] });
    expect(o.events[0]!.metadata).toEqual({ ok: "true", n: "3", s: "x" });
  });
  it("reads users: unknown role/status fall back to the safest values", () => {
    expect(readUserRow({ id: "u", name: "Ana", email: "a***@d***.com", role: "WEIRD", status: "???", emailVerified: 1, documents: 2, storageBytes: 10, tokens30d: 5 })).toMatchObject({ role: "USER", status: "ACTIVE", emailVerified: false, documents: 2 });
    const p = readPaged({ items: [{ id: "1" }, { id: "2" }], total: 5, page: 2, pageSize: 50 }, readUserRow);
    expect(p).toMatchObject({ total: 5, page: 2, pageSize: 50 });
    expect(p.items).toHaveLength(2);
  });
  it("flags masked e-mails but shows them exactly as received", () => {
    expect(emailDisplay("a***@d***.com")).toEqual({ text: "a***@d***.com", masked: true });
    expect(emailDisplay("ana@example.com")).toEqual({ text: "ana@example.com", masked: false });
    expect(emailDisplay("")).toEqual({ text: "—", masked: false });
  });
  it("reads usage: storage.byStatus[{status,documents}], processing, ai tasks sorted by tokens", () => {
    const u = readUsage({
      storage: { documents: 7, bytes: 100, byStatus: [{ status: "READY", documents: 5, bytes: 90 }, { status: "FAILED", documents: 2, bytes: 10 }], topUsers: Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, name: `N${i}`, bytes: i, documents: 1 })) },
      processing: { ingestJobsByStatus: [{ status: "SUCCEEDED", count: 3 }], averageSeconds30d: 4.5 },
      ai: { last7Days: [{ task: "CHAT", requests: 2, tokens: 10 }, { task: "MCQ", requests: 1, tokens: 50 }], last30Days: [{ task: "CHAT", requests: 9, tokens: 90 }] },
    });
    expect(u.documents).toEqual({ total: 7, bytes: 100, byStatus: [{ key: "READY", count: 5 }, { key: "FAILED", count: 2 }] });
    expect(u.topUsers).toHaveLength(10);
    expect(u.ingestion).toEqual({ byStatus: [{ key: "SUCCEEDED", count: 3 }], avgSeconds: 4.5 });
    expect(u.ai.d7.map((t) => t.task)).toEqual(["MCQ", "CHAT"]);
    expect(u.ai.d30).toEqual([{ task: "CHAT", requests: 9, tokens: 90 }]);
    expect(sumTasks(u.ai.d7)).toEqual({ requests: 3, tokens: 60 });
    const empty = readUsage({});
    expect(empty.ingestion.avgSeconds).toBeNull(); // no data stays null, never 0
    expect(empty.documents).toEqual({ total: 0, bytes: 0, byStatus: [] });
  });
  it("merges 7- and 30-day usage per task", () => {
    const u = readUsage({ ai: { last7Days: [{ task: "CHAT", requests: 2, tokens: 10 }, { task: "MCQ", requests: 1, tokens: 50 }], last30Days: [{ task: "CHAT", requests: 9, tokens: 90 }] } });
    expect(mergeTasks(u.ai.d7, u.ai.d30).map((r) => [r.task, r.tokens7, r.tokens30])).toEqual([["CHAT", 10, 90], ["MCQ", 50, 0]]);
  });
});

describe("user actions", () => {
  it("describes each action and only requires nothing in the body besides the change and a trimmed reason", () => {
    expect(describeUserAction({ kind: "status", status: "SUSPENDED" }, "Ana").confirm).toBe("Suspend account");
    expect(describeUserAction({ kind: "status", status: "ACTIVE" }, "Ana").title).toMatch(/Reactivate/);
    expect(describeUserAction({ kind: "role", role: "SUPPORT" }, "Ana").description).toMatch(/read-only/);
    expect(describeUserAction({ kind: "revoke" }, "Ana").confirm).toBe("Revoke sessions");
    expect(userPatchBody({ kind: "status", status: "SUSPENDED" }, "  abuse  ")).toEqual({ status: "SUSPENDED", reason: "abuse" });
    expect(userPatchBody({ kind: "role", role: "ADMIN" }, "   ")).toEqual({ role: "ADMIN" });
    expect(userPatchBody({ kind: "status", status: "ACTIVE" }, "x".repeat(900)).reason).toHaveLength(MAX_REASON);
    expect(MAX_REASON).toBe(200); // the server limit
  });
  it("builds query strings without empty filters", () => {
    expect(usersPath({ q: " ana ", status: "", role: "SUPPORT" }, 2)).toBe("/api/admin/users?q=ana&role=SUPPORT&page=2&pageSize=20");
    expect(usersPath({ q: "", status: "", role: "" }, 1)).toBe("/api/admin/users?page=1&pageSize=20");
    expect(metricsPath(24)).toBe("/api/admin/metrics?hours=24");
  });
  it("sends whole-day ISO bounds for audit dates and never exceeds the page-size cap", () => {
    const p = auditPath({ action: "auth.sign_in", actor: "", from: "2026-03-01", to: "2026-03-02" }, 3);
    const u = new URL(p, "http://x");
    expect(u.searchParams.get("action")).toBe("auth.sign_in");
    expect(u.searchParams.get("actor")).toBeNull();
    expect(new Date(u.searchParams.get("from")!).getTime()).toBeLessThan(new Date(u.searchParams.get("to")!).getTime());
    expect(Number(u.searchParams.get("pageSize"))).toBeLessThanOrEqual(100);
    expect(u.searchParams.get("page")).toBe("3");
  });
  it("shows the server's guard messages and safe text otherwise", () => {
    expect(describeAdminError(new ApiError(409, "CONFLICT", "You can't change your own role."))).toBe("You can't change your own role.");
    expect(describeAdminError(new ApiError(422, "VALIDATION", "At least one administrator must remain."))).toMatch(/administrator/);
    expect(describeAdminError(new ApiError(404, "NOT_FOUND", "x"))).toMatch(/permission/);
    expect(describeAdminError(new ApiError(500, "INTERNAL", "SELECT * FROM secrets"))).not.toMatch(/SELECT/);
    expect(describeAdminError(new Error("boom"))).toMatch(/Something went wrong/);
  });
});

describe("metrics (real shapes)", () => {
  const raw = {
    hours: 24, since: "2026-03-01T00:00:00Z", totals: { requests: 20, errors4xx: 3, errors5xx: 2 },
    api: [{ hour: "2026-03-01T11:00:00Z", "2xx": 10, "3xx": 0, "4xx": 0, "5xx": 0 }, { hour: "2026-03-01T10:00:00Z", "2xx": 5, "3xx": 1, "4xx": 3, "5xx": 2 }, { "2xx": 99 }],
    apiByGroup: [{ group: "auth", total: 5, "2xx": 5, "3xx": 0, "4xx": 0, "5xx": 0 }, { group: "exams", total: 15, "2xx": 10, "3xx": 0, "4xx": 3, "5xx": 2 }],
    providers: [
      { provider: "openai", task: "CHAT", ok: 10, error: 2, errorRate: 2 / 12, byCode: [{ code: "PROVIDER_TIMEOUT", count: 1 }, { code: "PROVIDER_RATE_LIMITED", count: 1 }] },
      { provider: "openai", task: "MCQ", ok: 8, error: 0, errorRate: 0, byCode: [] },
      { provider: "groq", task: "CHAT", ok: 0, error: 0, errorRate: null, byCode: [] },
    ],
    blocks: { rateLimit: [{ group: "chat", count: 5 }, { group: "gen", count: 9 }], quota: [{ group: "daily", count: 3 }] },
  };
  it("reads totals, the zero-filled hourly series (dropping rows without an hour), groups and blocks", () => {
    const m = readMetrics(raw);
    expect(m).toMatchObject({ hours: 24, since: "2026-03-01T00:00:00Z", totals: { requests: 20, errors4xx: 3, errors5xx: 2 } });
    expect(m.api).toHaveLength(2);
    expect(m.api[0]).toMatchObject({ hour: "2026-03-01T11:00:00Z", total: 10 });
    expect(m.api[1]).toMatchObject({ "2xx": 5, "3xx": 1, "4xx": 3, "5xx": 2, total: 11 });
    expect(apiTotals(m.api)).toEqual({ "2xx": 15, "3xx": 1, "4xx": 3, "5xx": 2, total: 21 });
    expect(m.apiByGroup.map((g) => g.group)).toEqual(["exams", "auth"]); // busiest first
    expect(m.blocks.rateLimit).toEqual([{ label: "gen", count: 9 }, { label: "chat", count: 5 }]);
    expect(m.blocks.quota).toEqual([{ label: "daily", count: 3 }]);
  });
  it("keeps provider outcomes and error codes, with a null rate when there were no calls", () => {
    const m = readMetrics(raw);
    expect(m.providers.map((p) => `${p.provider}/${p.task}`)).toEqual(["groq/CHAT", "openai/CHAT", "openai/MCQ"]);
    expect(m.providers.find((p) => p.task === "CHAT" && p.provider === "openai")!.byCode.map((c) => c.code)).toEqual(["PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT"]);
    expect(m.providers.find((p) => p.provider === "groq")!.errorRate).toBeNull();
    const rates = providerErrorRates(m.providers);
    expect(rates.find((r) => r.provider === "openai")).toMatchObject({ calls: 20, errors: 2 });
    expect(rates.find((r) => r.provider === "openai")!.rate).toBeCloseTo(0.1);
    expect(rates.find((r) => r.provider === "groq")!.rate).toBeNull();
  });
  it("an empty or malformed payload yields empty collections, never invented numbers", () => {
    for (const bad of [null, {}, "x", { api: "nope", providers: 3 }]) {
      const m = readMetrics(bad);
      expect(m).toMatchObject({ totals: { requests: 0, errors4xx: 0, errors5xx: 0 }, api: [], apiByGroup: [], providers: [], blocks: { rateLimit: [], quota: [] } });
    }
  });
});

describe("jobs (real shape)", () => {
  it("builds the type × status matrix, totals, oldest pending age and recent failures (with maxAttempts, truncated errors)", () => {
    const a = readJobs({ counts: [{ type: "ingest", status: "FAILED", count: 2 }, { type: "ingest", status: "SUCCEEDED", count: 5 }, { type: "exam.expire", status: "PENDING", count: 1 }], oldestPendingSeconds: 42, recentFailures: [{ id: "j", type: "ingest", attempts: 3, maxAttempts: 3, lastError: "e".repeat(500), updatedAt: "2026-01-01T00:00:00Z" }] });
    expect(a.matrix.map((r) => [r.type, r.total])).toEqual([["exam.expire", 1], ["ingest", 7]]);
    expect(a.totals).toMatchObject({ FAILED: 2, SUCCEEDED: 5, PENDING: 1 });
    expect(a.oldestPendingSeconds).toBe(42);
    expect(a.failures[0]).toMatchObject({ attempts: 3, maxAttempts: 3 });
    expect(a.failures[0]!.lastError).toHaveLength(200);
    expect(readJobs({})).toMatchObject({ matrix: [], failures: [], oldestPendingSeconds: null });
    expect(readJobs({ counts: [{ type: "x", status: "pending", count: 1 }], oldestPendingSeconds: null }).oldestPendingSeconds).toBeNull();
  });
});

describe("health (real shape)", () => {
  it("only the server's exact words map to states; anything else is Unknown, never OK", () => {
    expect(normalizeHealth("ok")).toBe("ok");
    expect(normalizeHealth("degraded")).toBe("degraded");
    expect(normalizeHealth("stale")).toBe("degraded");
    expect(normalizeHealth("down")).toBe("down");
    expect(normalizeHealth("never")).toBe("idle");
    for (const v of ["UP", "healthy", "banana", undefined, null, {}, 1]) expect(normalizeHealth(v), String(v)).toBe("unknown");
  });
  it("takes the worst state", () => {
    expect(worstHealth(["ok", "ok"])).toBe("ok");
    expect(worstHealth(["ok", "idle"])).toBe("idle");
    expect(worstHealth(["ok", "unknown"])).toBe("unknown");
    expect(worstHealth(["ok", "degraded", "unknown"])).toBe("degraded");
    expect(worstHealth(["down", "degraded", "ok"])).toBe("down");
  });
  it("maps the worker heartbeat status: ok → Operational, stale → Degraded, down → Down, never → Not started", () => {
    expect(workerState("ok")).toBe("ok");
    expect(workerState("stale")).toBe("degraded");
    expect(workerState("down")).toBe("down");
    expect(workerState("never")).toBe("idle");
    expect(workerState(undefined)).toBe("unknown");
  });
  it("derives queue state from failures and lag", () => {
    expect(queueState({ failed: 0, oldestPendingSeconds: null })).toBe("ok");
    expect(queueState({ failed: 0, oldestPendingSeconds: 300 })).toBe("ok");
    expect(queueState({ failed: 0, oldestPendingSeconds: 301 })).toBe("degraded");
    expect(queueState({ failed: 1, oldestPendingSeconds: null })).toBe("degraded");
    expect(queueState({ failed: 0, oldestPendingSeconds: 1801 })).toBe("down");
  });
  const body = (over: Record<string, unknown> = {}) => ({
    status: "ok", database: { ok: true, latencyMs: 3 }, ragAgent: { ok: true }, worker: { enabledHere: true, lastBeatAt: "2026-01-01T00:00:00Z", ageSeconds: 20, status: "ok" },
    queue: { pending: 1, running: 0, failed: 0, oldestPendingSeconds: 5 }, storage: { driver: "local", writable: true }, runtime: { node: "v24.1.0", uptimeSeconds: 3700, environment: "production" }, ...over,
  });
  it("reads the payload and uses the server's overall status", () => {
    const h = readHealth(body());
    expect(h.overall).toBe("ok");
    expect(h.database).toEqual({ state: "ok", latencyMs: 3 });
    expect(h.worker).toMatchObject({ state: "ok", enabledHere: true, ageSeconds: 20 });
    expect(h.runtime).toEqual([{ key: "Environment", value: "production" }, { key: "Node.js", value: "v24.1.0" }, { key: "Uptime", value: "1h 1m" }]);
    expect(readHealth(body({ status: "degraded" })).overall).toBe("degraded");
    expect(readHealth(body({ status: "down", ragAgent: { ok: false } }))).toMatchObject({ overall: "down", ragAgent: "down" });
  });
  it("falls back to the worst component when the overall status is missing or unrecognised, never to 'ok' by default", () => {
    expect(readHealth(body({ status: undefined, ragAgent: { ok: false } })).overall).toBe("down");
    expect(readHealth(body({ status: "weird", worker: { status: "stale", ageSeconds: 400 } })).overall).toBe("degraded");
    expect(readHealth({}).overall).toBe("unknown");
    expect(readHealth(body({ storage: {} })).storage.state).toBe("unknown");
  });
  it("shows a worker that never started as 'Not started'", () => {
    const h = readHealth(body({ worker: { enabledHere: false, lastBeatAt: null, ageSeconds: null, status: "never" } }));
    expect(h.worker).toMatchObject({ state: "idle", enabledHere: false, lastBeatAt: null });
  });
});

describe("config never shows secrets", () => {
  it("shows the real config shape: groups, flags, limits and the note, but hides secret-shaped entries", () => {
    const g = readConfig({ config: { environment: "production", appOrigin: "https://app.example.com", flags: { mockProviderEnabled: false, smtpConfigured: true }, storage: { driver: "s3" }, providers: ["openai", "groq"], limits: { ai: { dailyTokenLimit: 500000 }, exams: { maxQuestions: 200 } }, secretsNote: "Secret values are never shown." } });
    const all = Object.fromEntries(g.flatMap((x) => x.entries.map((e) => [`${x.group}/${e.key}`, e])));
    expect(all["General/environment"]).toMatchObject({ value: "production", hidden: false });
    expect(all["Flags/mockProviderEnabled"]).toMatchObject({ value: "Disabled", hidden: false });
    expect(all["Flags/smtpConfigured"]).toMatchObject({ value: "Enabled" });
    expect(all["Limits/ai.dailyTokenLimit"]).toMatchObject({ value: "500000", hidden: false });
    expect(all["General/secretsNote"]).toMatchObject({ value: "Secret values are never shown.", hidden: false });
    expect(all["General/providers"]).toMatchObject({ value: "openai, groq" });
  });
  it("recognises secret-shaped keys but not token budgets", () => {
    for (const k of ["BETTER_AUTH_SECRET", "RAG_AGENT_TOKEN", "apiKey", "credentialEncryptionKey", "databasePassword", "authToken", "DATABASE_CONNECTION"]) expect(isSecretKey(k), k).toBe(true);
    for (const k of ["aiDailyTokenLimit", "AI_DAILY_TOKEN_LIMIT", "maxOutputTokens", "tokenLimit", "storageDriver", "genMaxLlmCalls"]) expect(isSecretKey(k), k).toBe(false);
  });
  it("hides secret-shaped values even under an innocent key", () => {
    expect(safeConfigValue("note", "postgresql://u:p@h/db")).toMatchObject({ hidden: true, value: "hidden" });
    expect(safeConfigValue("note", "sk-abcdefghijklmnopqrstuvwxyz")).toMatchObject({ hidden: true });
    expect(safeConfigValue("endpoint", "https://user:pw@host/x")).toMatchObject({ hidden: true });
    expect(safeConfigValue("RAG_AGENT_TOKEN", "abc")).toMatchObject({ hidden: true });
    expect(safeConfigValue("apiKey", 12345)).toMatchObject({ hidden: true });
    expect(safeConfigValue("list", ["a", "postgres://x:y@z/db"])).toMatchObject({ hidden: true });
    expect(safeConfigValue("allowMock", true)).toEqual({ key: "allowMock", value: "Enabled", hidden: false });
    expect(safeConfigValue("aiDailyTokenLimit", 500000)).toEqual({ key: "aiDailyTokenLimit", value: "500000", hidden: false });
    expect(safeConfigValue("storageDriver", "local")).toEqual({ key: "storageDriver", value: "local", hidden: false });
    expect(safeConfigValue("x", null).value).toBe("—");
  });
  it("flattens grouped and nested config", () => {
    const g = readConfig({ config: { limits: { aiDailyTokenLimit: 100, nested: { depth: 2 } }, storage: { driver: "local" }, flag: true, ragToken: "abc" } });
    expect(g.map((x) => x.group)).toEqual(["Limits", "Storage", "General"]);
    expect(g[0]!.entries.map((e) => e.key)).toEqual(["aiDailyTokenLimit", "nested.depth"]);
    const general = g.find((x) => x.group === "General")!;
    expect(general.entries.find((e) => e.key === "ragToken")).toMatchObject({ hidden: true });
    expect(readConfig(null)).toEqual([]);
  });
});
