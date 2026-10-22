import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AdminHeader } from "@/components/admin/admin-header";
import { AdminNav } from "@/components/admin/admin-nav";
import { AuditTable } from "@/components/admin/audit-table";
import { ConfigView } from "@/components/admin/config-view";
import { HealthView } from "@/components/admin/health-view";
import { HealthChip } from "@/components/admin/common";
import { JobsView } from "@/components/admin/jobs-view";
import { OverviewView } from "@/components/admin/overview";
import { UsersView } from "@/components/admin/users-view";
import { adminTabs, readAuditRow, readConfig, readHealth, readJobs, readOverview, readPaged, readUserRow, type AdminRole } from "@/lib/admin";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/users", useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const html = (el: React.ReactElement, qc = new QueryClient()) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, el));

describe("admin frame", () => {
  it("shows the role badge and the privacy stance to every console role, and the read-only notice only to SUPPORT", () => {
    const admin = html(createElement(AdminHeader, { role: "ADMIN" as AdminRole }));
    const support = html(createElement(AdminHeader, { role: "SUPPORT" as AdminRole }));
    for (const out of [admin, support]) {
      expect(out).toContain("Administration");
      expect(out).toContain("Administrators cannot read private conversations, documents or API keys");
      expect(out).toContain('data-testid="role-badge"');
    }
    expect(admin).toContain("Admin");
    expect(admin).not.toContain("read-only");
    expect(support).toContain("Support");
    expect(support).toContain("Your role is read-only");
  });
  it("renders the section nav as links, marks the current page, and omits Config for SUPPORT", () => {
    const admin = html(createElement(AdminNav, { tabs: adminTabs("ADMIN") }));
    expect(admin).toContain('aria-label="Administration sections"');
    expect(admin).toMatch(/href="\/admin\/users"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/admin\/users"/);
    expect(admin).toContain('href="/admin/config"');
    const support = html(createElement(AdminNav, { tabs: adminTabs("SUPPORT") }));
    expect(support).not.toContain("/admin/config");
  });
});

describe("overview", () => {
  const o = readOverview({ users: 12, verified: 9, newUsers: 3, sessions: 4, suspended: 2, documents: { total: 6, byStatus: { READY: 5, FAILED: 1 }, bytes: 3 * 1024 * 1024 }, jobs: { pending: 0, running: 0, failed: 2 }, events: [{ id: "e1", action: "admin.user_status_changed", targetType: "user", actor: "abcd1234efgh", createdAt: "2026-03-01T10:00:00Z" }] });
  const out = html(createElement(OverviewView, { o }));
  it("shows the stat cards, document/job breakdowns and recent audit events", () => {
    expect(out).toContain("Total users");
    expect(out).toContain("Suspended accounts");
    expect(out).toContain("3.0 MB");
    expect(out).toContain("Ready");
    expect(out).toContain("admin.user_status_changed");
  });
  it("has honest empty states", () => {
    const empty = html(createElement(OverviewView, { o: readOverview({}) }));
    expect(empty).toContain("No documents have been uploaded.");
    expect(empty).toContain("jobs pending, running or failed");
    expect(empty).toContain("No jobs have run yet.");
    expect(empty).toContain("No events yet.");
  });
});

describe("users table is role-aware", () => {
  const data = readPaged({ items: [
    { id: "me", name: "Root Admin", email: "root@example.test", role: "ADMIN", status: "ACTIVE", emailVerified: true, documents: 1, storageBytes: 2048, tokens30d: 10 },
    { id: "u2", name: "Sam Student", email: "s***@e***.test", role: "USER", status: "SUSPENDED", emailVerified: false, documents: 0, storageBytes: 0, tokens30d: 0 },
  ], total: 2 }, readUserRow);
  const render = (role: AdminRole) => {
    const qc = new QueryClient();
    qc.setQueryData(["admin", "users", { q: "", status: "", role: "" }, 1], data);
    return html(createElement(UsersView, { role, selfId: "me" }), qc);
  };
  it("ADMIN gets an actions menu per account", () => {
    const out = render("ADMIN");
    expect(out).toContain("Actions for Root Admin");
    expect(out).toContain("Actions for Sam Student");
  });
  it("SUPPORT gets no mutation controls at all and the read-only description", () => {
    const out = render("SUPPORT");
    expect(out).not.toContain("Actions for");
    expect(out).toContain("Read-only view of account metadata.");
  });
  it("labels chips with text, flags the caller and the masked e-mail, and never relies on colour", () => {
    const out = render("SUPPORT");
    expect(out).toContain("Suspended");
    expect(out).toContain("Active");
    expect(out).toContain(">You<");
    expect(out).toContain("s***@e***.test");
    expect(out).toContain("(masked)");
    expect(out).toContain("unverified");
    expect(out).toContain("<caption");
    expect(out).toContain('scope="col"');
  });
  it("shows a loading state before data arrives", () => {
    const out = html(createElement(UsersView, { role: "ADMIN", selfId: "me" }));
    expect(out).toContain('aria-label="Loading"');
  });
});

describe("jobs", () => {
  const jobs = readJobs({ counts: [{ type: "ingest", status: "FAILED", count: 1 }, { type: "ingest", status: "SUCCEEDED", count: 4 }], oldestPendingSeconds: null, recentFailures: [{ id: "j1", type: "ingest", attempts: 3, maxAttempts: 3, lastError: "Provider unavailable", updatedAt: "2026-03-01T10:00:00Z" }] });
  const render = (role: AdminRole) => {
    const qc = new QueryClient();
    qc.setQueryData(["admin", "jobs"], jobs);
    return html(createElement(JobsView, { role }), qc);
  };
  it("ADMIN can retry failed jobs; SUPPORT only sees them", () => {
    expect(render("ADMIN")).toContain("Retry");
    expect(render("SUPPORT")).not.toContain("Retry");
    expect(render("SUPPORT")).toContain("Provider unavailable");
  });
  it("says plainly when nothing is waiting or failing", () => {
    const qc = new QueryClient();
    qc.setQueryData(["admin", "jobs"], readJobs({ counts: [] }));
    const out = html(createElement(JobsView, { role: "ADMIN" }), qc);
    expect(out).toContain("No jobs have been recorded yet.");
    expect(out).toContain("No failed jobs");
    expect(out).toContain("none waiting");
  });
});

describe("health", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    status: "down", database: { ok: true, latencyMs: 4 }, ragAgent: { ok: false }, worker: { enabledHere: true, lastBeatAt: "2026-03-01T10:00:00Z", ageSeconds: 400, status: "stale" },
    queue: { pending: 2, running: 1, failed: 3, oldestPendingSeconds: 60 }, storage: { driver: "local", writable: true }, runtime: { node: "v24.1.0", uptimeSeconds: 90, environment: "production" }, ...over,
  });
  it("spells every state out in words (icon + text, never colour alone)", () => {
    for (const [s, w] of [["ok", "Operational"], ["degraded", "Degraded"], ["down", "Down"], ["idle", "Not started"], ["unknown", "Unknown"]] as const) expect(html(createElement(HealthChip, { state: s }))).toContain(w);
  });
  it("shows the server's overall status and each component with its own state", () => {
    const out = html(createElement(HealthView, { h: readHealth(body()) }));
    expect(out).toContain('data-state="down"');
    expect(out).toContain("Database");
    expect(out).toContain("responded in 4 ms");
    expect(out).toContain("Background worker");
    expect(out).toContain("Degraded"); // stale heartbeat and failed jobs
    expect(out).toContain("3 failed");
    expect(out).toContain("local driver");
    expect(out).toContain('data-testid="runtime"');
    expect(out).toContain("production");
    expect(out).not.toMatch(/postgres(ql)?:\/\//);
  });
  it("shows a worker that has not started yet as 'Not started'", () => {
    const out = html(createElement(HealthView, { h: readHealth(body({ status: "ok", ragAgent: { ok: true }, queue: { pending: 0, running: 0, failed: 0, oldestPendingSeconds: null }, worker: { enabledHere: false, lastBeatAt: null, ageSeconds: null, status: "never" } })) }));
    expect(out).toContain("Not started");
    expect(out).toContain("disabled on this server");
  });
});

describe("audit table", () => {
  it("shows only the allow-listed metadata the API returned, and an empty state", () => {
    const rows = [readAuditRow({ id: "a", action: "admin.user_role_changed", targetType: "user", targetId: "cm12345678901234567", actor: "cm99999999999999999", createdAt: "2026-03-01T10:00:00Z", metadata: { from: "USER", to: "SUPPORT", nested: { x: 1 } } })];
    const out = html(createElement(AuditTable, { rows, caption: "Events", showMeta: true }));
    expect(out).toContain("admin.user_role_changed");
    expect(out).toContain("from");
    expect(out).toContain("SUPPORT");
    expect(out).not.toContain("nested");
    expect(out).toContain("cm1234567890…"); // ids are truncated
    expect(html(createElement(AuditTable, { rows: [], caption: "Events", empty: "No events match these filters." }))).toContain("No events match these filters.");
  });
});

describe("config", () => {
  it("renders values read-only and replaces anything secret-shaped, even if the API returned it", () => {
    const groups = readConfig({ config: { limits: { aiDailyTokenLimit: 500000 }, storage: { driver: "local", s3: { accessKeySecret: "AKIA1234567890ABCDEF" } }, note: "postgresql://u:p@h/db" } });
    const out = html(createElement(ConfigView, { groups }));
    expect(out).toContain("500000");
    expect(out).toContain("local");
    expect(out).toContain("Hidden");
    for (const leaked of ["AKIA1234567890ABCDEF", "postgresql://u:p@h/db"]) expect(out).not.toContain(leaked);
    expect(out).toContain("never displayed or returned");
    expect(out).not.toContain("<input");
  });
});
