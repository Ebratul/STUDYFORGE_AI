/**
 * Types and pure helpers for the admin console (docs/PART5_SPEC.md §9, shapes as implemented by modules/admin).
 * The backend is the only authority: role helpers here decide what to *show*. Readers follow the real response shapes and never invent
 * data: a missing value stays null/empty (an unknown health value is never shown as "ok").
 */

export type AdminRole = "USER" | "SUPPORT" | "ADMIN";
export type AccountStatus = "ACTIVE" | "SUSPENDED";

export const ROLE_LABEL: Record<AdminRole, string> = { USER: "User", SUPPORT: "Support (read-only)", ADMIN: "Administrator" };
export const ROLE_SHORT: Record<AdminRole, string> = { USER: "User", SUPPORT: "Support", ADMIN: "Admin" };
export const STATUS_LABEL: Record<AccountStatus, string> = { ACTIVE: "Active", SUSPENDED: "Suspended" };

export const PRIVACY_NOTE = "Administrators cannot read private conversations, documents or API keys. This console shows aggregates, account metadata and audit events only.";

// ---------------------------------------------------------------------------------------------------------------------
// Roles → what the UI shows (the server enforces every rule independently)
// ---------------------------------------------------------------------------------------------------------------------
export const asRole = (v: unknown): AdminRole => (v === "ADMIN" || v === "SUPPORT" ? v : "USER");
export const isAdminConsoleRole = (role: unknown): boolean => role === "ADMIN" || role === "SUPPORT";
export const canManageUsers = (role: AdminRole): boolean => role === "ADMIN";
export const canManageJobs = (role: AdminRole): boolean => role === "ADMIN";
export const canViewConfig = (role: AdminRole): boolean => role === "ADMIN";

export type AdminTab = { href: string; label: string; slug: string };
const TABS: (AdminTab & { adminOnly?: boolean })[] = [
  { href: "/admin", label: "Overview", slug: "overview" },
  { href: "/admin/users", label: "Users", slug: "users" },
  { href: "/admin/usage", label: "Usage", slug: "usage" },
  { href: "/admin/metrics", label: "Metrics", slug: "metrics" },
  { href: "/admin/jobs", label: "Jobs", slug: "jobs" },
  { href: "/admin/health", label: "Health", slug: "health" },
  { href: "/admin/audit", label: "Audit", slug: "audit" },
  { href: "/admin/config", label: "Config", slug: "config", adminOnly: true },
];
export const adminTabs = (role: AdminRole): AdminTab[] => TABS.filter((t) => !t.adminOnly || canViewConfig(role)).map(({ href, label, slug }) => ({ href, label, slug }));

/** Active tab for a pathname ("/admin" is only active on the overview). */
export function activeTab(pathname: string): string {
  const hit = TABS.filter((t) => t.href !== "/admin").find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`));
  return hit?.slug ?? "overview";
}

// ---------------------------------------------------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------------------------------------------------
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const nstr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : d);
const nnum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const pageCount = (total: number, pageSize: number): number => Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
export const clampPage = (page: number, total: number, pageSize: number): number => Math.min(Math.max(1, page), pageCount(total, pageSize));

export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}
export const formatCount = (n: number): string => n.toLocaleString("en-US");

export type CountItem = { key: string; count: number };
/** Accepts `{ READY: 3 }` or `[{ status: "READY", count: 3 }]` and returns a stable list. */
export function readCounts(v: unknown, keyNames = ["status", "key", "name", "type"]): CountItem[] {
  if (Array.isArray(v)) {
    return v.map((x) => {
      const o = rec(x);
      const key = keyNames.map((k) => o[k]).find((k) => typeof k === "string") as string | undefined;
      return { key: key ?? "unknown", count: num(o.count ?? o.n ?? o.total) };
    });
  }
  return Object.entries(rec(v)).map(([key, count]) => ({ key, count: num(count) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------------------------------
export type AuditRow = { id: string; action: string; targetType: string | null; targetId: string | null; actor: string | null; ipHash: string | null; createdAt: string; metadata: Record<string, string> };
export type Overview = {
  users: number; verified: number; newUsers: number; sessions: number; suspended: number;
  documents: { total: number; bytes: number; byStatus: CountItem[] };
  jobs: { byStatus: CountItem[] };
  events: AuditRow[];
};

export function readAuditRow(raw: unknown): AuditRow {
  const e = rec(raw);
  const md = rec(e.metadata);
  return {
    id: str(e.id), action: str(e.action, "unknown"), targetType: nstr(e.targetType), targetId: nstr(e.targetId), actor: nstr(e.actor ?? e.actorId),
    ipHash: nstr(e.ipHash), createdAt: str(e.createdAt),
    // only primitives are ever shown, and only what the API chose to return (it allow-lists the keys)
    metadata: Object.fromEntries(Object.entries(md).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [k, String(v)])),
  };
}

export function readOverview(raw: unknown): Overview {
  const o = rec(raw);
  const d = rec(o.documents);
  const byStatus = readCounts(d.byStatus);
  const j = rec(o.jobs);
  return {
    users: num(o.users), verified: num(o.verified), newUsers: num(o.newUsers), sessions: num(o.sessions), suspended: num(o.suspended),
    documents: { total: num(d.total, byStatus.reduce((n, c) => n + c.count, 0)), bytes: num(d.bytes), byStatus },
    jobs: { byStatus: [{ key: "PENDING", count: num(j.pending) }, { key: "RUNNING", count: num(j.running) }, { key: "FAILED", count: num(j.failed) }] },
    events: arr(o.events).slice(0, 10).map(readAuditRow),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------------------------------
export type UserRow = {
  id: string; name: string; email: string; role: AdminRole; status: AccountStatus; emailVerified: boolean; createdAt: string;
  lastSessionAt: string | null; documents: number; storageBytes: number; tokens30d: number;
};
export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

export function readUserRow(raw: unknown): UserRow {
  const u = rec(raw);
  return {
    id: str(u.id), name: str(u.name, "—"), email: str(u.email), role: asRole(u.role), status: u.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
    emailVerified: u.emailVerified === true, createdAt: str(u.createdAt), lastSessionAt: nstr(u.lastSessionAt), documents: num(u.documents), storageBytes: num(u.storageBytes), tokens30d: num(u.tokens30d),
  };
}

export function readPaged<T>(raw: unknown, map: (x: unknown) => T, fallbackPageSize = 20): Paged<T> {
  const o = rec(raw);
  const items = arr(o.items).map(map);
  return { items, total: num(o.total, items.length), page: num(o.page, 1), pageSize: num(o.pageSize, fallbackPageSize) };
}

/** The API masks e-mails for SUPPORT (a***@d***.com). We show exactly what we receive and flag the mask. */
export function emailDisplay(email: string): { text: string; masked: boolean } {
  return { text: email || "—", masked: email.includes("***") };
}

export type UserAction = { kind: "status"; status: AccountStatus } | { kind: "role"; role: AdminRole } | { kind: "revoke" };

export function describeUserAction(a: UserAction, name: string): { title: string; description: string; confirm: string } {
  if (a.kind === "revoke") return { title: "Sign this user out everywhere?", description: `${name} will be signed out of every device immediately. They can sign in again.`, confirm: "Revoke sessions" };
  if (a.kind === "status")
    return a.status === "SUSPENDED"
      ? { title: "Suspend this account?", description: `${name} is signed out immediately and cannot sign in or use the API until reactivated. Their data is kept.`, confirm: "Suspend account" }
      : { title: "Reactivate this account?", description: `${name} will be able to sign in again.`, confirm: "Reactivate account" };
  return { title: `Change role to ${ROLE_SHORT[a.role]}?`, description: `${name} will become ${ROLE_LABEL[a.role].toLowerCase()}. ${a.role === "USER" ? "They lose all console access." : a.role === "SUPPORT" ? "They get read-only console access." : "They get full administrative permissions."}`, confirm: "Change role" };
}

export const MAX_REASON = 200;

/** The request body for PATCH /api/admin/users/:id (strict: only status/role/reason). */
export function userPatchBody(a: UserAction, reason: string): Record<string, unknown> {
  const r = reason.trim();
  const base = a.kind === "status" ? { status: a.status } : a.kind === "role" ? { role: a.role } : {};
  return r ? { ...base, reason: r.slice(0, MAX_REASON) } : base;
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------------------------------
export type TaskUsage = { task: string; requests: number; tokens: number };
export type UsageView = {
  documents: { total: number; bytes: number; byStatus: CountItem[] };
  topUsers: { id: string; name: string; bytes: number }[];
  ingestion: { byStatus: CountItem[]; avgSeconds: number | null };
  ai: { d7: TaskUsage[]; d30: TaskUsage[] };
};

const readTasks = (v: unknown): TaskUsage[] =>
  arr(v)
    .map((x) => ({ task: str(rec(x).task, "unknown"), requests: num(rec(x).requests), tokens: num(rec(x).tokens) }))
    .sort((a, b) => b.tokens - a.tokens || a.task.localeCompare(b.task));

export function readUsage(raw: unknown): UsageView {
  const o = rec(raw);
  const st = rec(o.storage);
  const pr = rec(o.processing);
  const ai = rec(o.ai);
  return {
    documents: {
      total: num(st.documents), bytes: num(st.bytes),
      byStatus: arr(st.byStatus).map((x) => ({ key: str(rec(x).status, "unknown"), count: num(rec(x).documents) })),
    },
    topUsers: arr(st.topUsers).slice(0, 10).map((u) => ({ id: str(rec(u).id), name: str(rec(u).name, "—"), bytes: num(rec(u).bytes) })),
    ingestion: { byStatus: arr(pr.ingestJobsByStatus).map((x) => ({ key: str(rec(x).status, "unknown"), count: num(rec(x).count) })), avgSeconds: nnum(pr.averageSeconds30d) },
    ai: { d7: readTasks(ai.last7Days), d30: readTasks(ai.last30Days) },
  };
}

export const sumTasks = (t: TaskUsage[]): { requests: number; tokens: number } => t.reduce((a, x) => ({ requests: a.requests + x.requests, tokens: a.tokens + x.tokens }), { requests: 0, tokens: 0 });

// ---------------------------------------------------------------------------------------------------------------------
// Metrics (hourly counter buckets; counts only, never latency)
// ---------------------------------------------------------------------------------------------------------------------
export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];
export type ApiPoint = { hour: string; total: number } & Record<StatusClass, number>;
export type ApiGroup = { group: string } & Record<StatusClass | "total", number>;
export type ProviderMetric = { provider: string; task: string; ok: number; error: number; errorRate: number | null; byCode: { code: string; count: number }[] };
export type BlockRow = { label: string; count: number };
export type MetricsData = {
  hours: number; since: string | null;
  totals: { requests: number; errors4xx: number; errors5xx: number };
  api: ApiPoint[]; apiByGroup: ApiGroup[]; providers: ProviderMetric[];
  blocks: { rateLimit: BlockRow[]; quota: BlockRow[] };
};

const classes = (o: Record<string, unknown>): Record<StatusClass, number> => ({ "2xx": num(o["2xx"]), "3xx": num(o["3xx"]), "4xx": num(o["4xx"]), "5xx": num(o["5xx"]) });
const blockRows = (v: unknown): BlockRow[] => arr(v).map((x) => ({ label: str(rec(x).group, "(all)"), count: num(rec(x).count) })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

export function readMetrics(raw: unknown): MetricsData {
  const o = rec(raw);
  const t = rec(o.totals);
  const b = rec(o.blocks);
  return {
    hours: num(o.hours, 24), since: nstr(o.since),
    totals: { requests: num(t.requests), errors4xx: num(t.errors4xx), errors5xx: num(t.errors5xx) },
    api: arr(o.api).map((x) => rec(x)).map((p) => {
      const c = classes(p);
      return { hour: str(p.hour), total: c["2xx"] + c["3xx"] + c["4xx"] + c["5xx"], ...c };
    }).filter((p) => p.hour),
    apiByGroup: arr(o.apiByGroup).map((x) => rec(x)).map((g) => {
      const c = classes(g);
      return { group: str(g.group, "other"), total: num(g.total, c["2xx"] + c["3xx"] + c["4xx"] + c["5xx"]), ...c };
    }).sort((a, b) => b.total - a.total || a.group.localeCompare(b.group)),
    providers: arr(o.providers).map((x) => rec(x)).map((p) => ({
      provider: str(p.provider, "unknown"), task: str(p.task, "—"), ok: num(p.ok), error: num(p.error), errorRate: nnum(p.errorRate),
      byCode: arr(p.byCode).map((c) => ({ code: str(rec(c).code, "unknown"), count: num(rec(c).count) })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    })).sort((a, b) => a.provider.localeCompare(b.provider) || a.task.localeCompare(b.task)),
    blocks: { rateLimit: blockRows(b.rateLimit), quota: blockRows(b.quota) },
  };
}

export const apiTotals = (s: ApiPoint[]): Record<StatusClass | "total", number> =>
  s.reduce((a, p) => ({ "2xx": a["2xx"] + p["2xx"], "3xx": a["3xx"] + p["3xx"], "4xx": a["4xx"] + p["4xx"], "5xx": a["5xx"] + p["5xx"], total: a.total + p.total }), { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, total: 0 });

/** Error share of provider calls (0–1) per provider across tasks; null when a provider has no calls. */
export function providerErrorRates(rows: ProviderMetric[]): { provider: string; calls: number; errors: number; rate: number | null }[] {
  const by = new Map<string, { calls: number; errors: number }>();
  for (const r of rows) {
    const p = by.get(r.provider) ?? { calls: 0, errors: 0 };
    p.calls += r.ok + r.error;
    p.errors += r.error;
    by.set(r.provider, p);
  }
  return [...by.entries()].map(([provider, v]) => ({ provider, ...v, rate: v.calls > 0 ? v.errors / v.calls : null })).sort((a, b) => a.provider.localeCompare(b.provider));
}

export const HOUR_OPTIONS = [6, 24, 72, 168] as const;
export const hourLabel = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

// ---------------------------------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------------------------------
export const JOB_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED"] as const;
export type JobRowView = { type: string; counts: Record<string, number>; total: number };
export type JobFailure = { id: string; type: string; attempts: number; maxAttempts: number; lastError: string; updatedAt: string };
export type JobsView = { matrix: JobRowView[]; totals: Record<string, number>; oldestPendingSeconds: number | null; failures: JobFailure[] };

/** `{ counts: [{type,status,count}], oldestPendingSeconds, recentFailures }` → a type × status matrix. */
export function readJobs(raw: unknown): JobsView {
  const o = rec(raw);
  const byType = new Map<string, Record<string, number>>();
  for (const x of arr(o.counts)) {
    const r = rec(x);
    const type = str(r.type, "unknown");
    const row = byType.get(type) ?? {};
    const status = str(r.status, "unknown").toUpperCase();
    row[status] = (row[status] ?? 0) + num(r.count);
    byType.set(type, row);
  }
  const matrix = [...byType.entries()].map(([type, counts]) => ({ type, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) })).sort((a, b) => a.type.localeCompare(b.type));
  const totals: Record<string, number> = {};
  for (const r of matrix) for (const [s, c] of Object.entries(r.counts)) totals[s] = (totals[s] ?? 0) + c;
  return {
    matrix, totals, oldestPendingSeconds: nnum(o.oldestPendingSeconds),
    failures: arr(o.recentFailures).map((f) => rec(f)).map((f) => ({ id: str(f.id), type: str(f.type, "unknown"), attempts: num(f.attempts), maxAttempts: num(f.maxAttempts, 0), lastError: str(f.lastError).slice(0, 200), updatedAt: str(f.updatedAt) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------------------------------
export type HealthState = "ok" | "degraded" | "down" | "idle" | "unknown";
export const HEALTH_LABEL: Record<HealthState, string> = { ok: "Operational", degraded: "Degraded", down: "Down", idle: "Not started", unknown: "Unknown" };
const ORDER: HealthState[] = ["ok", "idle", "unknown", "degraded", "down"];

/** The server's overall status; anything unrecognised is "unknown" — never silently "ok". */
export function normalizeHealth(v: unknown): HealthState {
  if (v === true) return "ok";
  if (v === false) return "down";
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "ok") return "ok";
    if (s === "degraded" || s === "stale") return "degraded";
    if (s === "down") return "down";
    if (s === "never") return "idle";
    return "unknown";
  }
  return "unknown";
}

export const worstHealth = (states: HealthState[]): HealthState => states.reduce<HealthState>((w, s) => (ORDER.indexOf(s) > ORDER.indexOf(w) ? s : w), "ok");

/** Worker heartbeat status from the server: ok / stale (degraded) / down / never (not started on this deployment yet). */
export const workerState = (status: unknown): HealthState => normalizeHealth(status);

/** Queue lag: failed jobs or an old pending job degrade the queue; a very old pending job means it is not draining. */
export function queueState(q: { failed: number; oldestPendingSeconds: number | null }): HealthState {
  if (q.oldestPendingSeconds !== null && q.oldestPendingSeconds > 1800) return "down";
  if (q.failed > 0 || (q.oldestPendingSeconds !== null && q.oldestPendingSeconds > 300)) return "degraded";
  return "ok";
}

export type HealthView = {
  overall: HealthState;
  database: { state: HealthState; latencyMs: number | null };
  ragAgent: HealthState;
  worker: { state: HealthState; enabledHere: boolean | null; lastBeatAt: string | null; ageSeconds: number | null };
  queue: { state: HealthState; pending: number; running: number; failed: number; oldestPendingSeconds: number | null };
  storage: { state: HealthState; driver: string | null; writable: boolean | null };
  runtime: { key: string; value: string }[];
};

export function readHealth(raw: unknown): HealthView {
  const o = rec(raw);
  const db = rec(o.database);
  const rag = rec(o.ragAgent);
  const w = rec(o.worker);
  const q = rec(o.queue);
  const s = rec(o.storage);
  const rt = rec(o.runtime);
  const queue = { pending: num(q.pending), running: num(q.running), failed: num(q.failed), oldestPendingSeconds: nnum(q.oldestPendingSeconds) };
  const writable = typeof s.writable === "boolean" ? s.writable : null;
  const okState = (v: unknown): HealthState => (typeof v === "boolean" ? (v ? "ok" : "down") : "unknown");
  const database = { state: okState(db.ok), latencyMs: nnum(db.latencyMs) };
  const ragAgent = okState(rag.ok);
  const worker = { state: workerState(w.status), enabledHere: typeof w.enabledHere === "boolean" ? w.enabledHere : null, lastBeatAt: nstr(w.lastBeatAt), ageSeconds: nnum(w.ageSeconds) };
  const qs = queueState(queue);
  const st: HealthState = writable === null ? "unknown" : writable ? "ok" : "down";
  const uptime = nnum(rt.uptimeSeconds);
  return {
    // the server computes `status`; if it is missing or unrecognised we fall back to the worst of the parts rather than claiming "ok"
    overall: o.status !== undefined && normalizeHealth(o.status) !== "unknown" ? normalizeHealth(o.status) : worstHealth([database.state, ragAgent, worker.state, qs, st]),
    database, ragAgent, worker, queue: { state: qs, ...queue }, storage: { state: st, driver: nstr(s.driver), writable },
    runtime: [
      ...(nstr(rt.environment) ? [{ key: "Environment", value: String(rt.environment) }] : []),
      ...(nstr(rt.node) ? [{ key: "Node.js", value: String(rt.node) }] : []),
      ...(uptime !== null ? [{ key: "Uptime", value: formatAge(uptime) }] : []),
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Config (read-only, non-secret). The server builds this from an allow-list; the UI also refuses to render anything secret-shaped.
// ---------------------------------------------------------------------------------------------------------------------
const SECRET_KEY = /(secret|password|passwd|credential|api[-_]?key|private|encryption|signing|salt|token(?!s|[_-]?(limit|budget|max|count))|dsn|connection)/i;
const SECRET_VALUE = /(postgres(ql)?:\/\/|redis:\/\/|:\/\/[^/\s:@]+:[^/\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,})/;

export const isSecretKey = (key: string): boolean => key !== "secretsNote" && SECRET_KEY.test(key);

export type ConfigEntry = { key: string; value: string; hidden: boolean };
export type ConfigGroup = { group: string; entries: ConfigEntry[] };

export function safeConfigValue(key: string, v: unknown): ConfigEntry {
  if (v === null || v === undefined) return { key, value: "—", hidden: false };
  if (typeof v === "boolean") return { key, value: v ? "Enabled" : "Disabled", hidden: false };
  if (typeof v === "number") return { key, value: isSecretKey(key) ? "hidden" : String(v), hidden: isSecretKey(key) };
  if (Array.isArray(v)) {
    const items = v.map((x) => String(x));
    return items.some((x) => SECRET_VALUE.test(x)) || isSecretKey(key) ? { key, value: "hidden", hidden: true } : { key, value: items.join(", ") || "—", hidden: false };
  }
  const s = String(v);
  if (isSecretKey(key) || SECRET_VALUE.test(s)) return { key, value: "hidden", hidden: true };
  return { key, value: s.length > 200 ? `${s.slice(0, 200)}…` : s, hidden: false };
}

const humanize = (k: string): string => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Flattens `{config:{group:{key:value}}}` / `{group:{…}}` / flat `{key:value}` into display groups. Nested objects become dotted keys. */
export function readConfig(raw: unknown): ConfigGroup[] {
  const root = rec(rec(raw).config ?? raw);
  const groups = new Map<string, ConfigEntry[]>();
  const walk = (group: string, key: string, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) walk(group, key ? `${key}.${k}` : k, x);
      return;
    }
    groups.set(group, [...(groups.get(group) ?? []), safeConfigValue(key, v)]);
  };
  for (const [k, v] of Object.entries(root)) {
    if (v && typeof v === "object" && !Array.isArray(v)) walk(humanize(k), "", v);
    else walk("General", k, v);
  }
  return [...groups.entries()].map(([group, entries]) => ({ group, entries })).filter((g) => g.entries.length > 0);
}
