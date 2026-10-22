import { describe, expect, it } from "vitest";
import { can, requirePermission } from "../../src/auth/authorize.js";
import { getSessionUserFromHeaders } from "../../src/auth/session.js";
import { createUser, makeAdmin } from "../helpers/users.js";
import { db } from "../../src/lib/db.js";
import { recordAudit } from "../../src/lib/audit.js";

describe("role-based permissions with real sessions", () => {
  it("regular users cannot use admin permissions", async () => {
    const u = await createUser();
    const user = (await getSessionUserFromHeaders(u.headers))!;
    expect(can(user, "admin:dashboard:view")).toBe(false);
    expect(() => requirePermission(user, "admin:dashboard:view")).toThrow();
  });

  it("admins can; granting does not require a new session", async () => {
    const u = await createUser();
    await makeAdmin(u.id);
    const user = (await getSessionUserFromHeaders(u.headers))!;
    expect(can(user, "admin:dashboard:view")).toBe(true);
  });
});

describe("audit logging", () => {
  it("redacts secret-looking metadata and stores only a keyed hash of the IP", async () => {
    await recordAudit({
      action: "account.profile_updated",
      metadata: { note: "ok", password: "hunter2", nested: { apiKey: "sk-abcdefghijklmnopqrstuv" } },
      ip: "198.51.100.7",
    });
    const ev = await db.auditEvent.findFirstOrThrow({ where: { ipHash: { not: null } }, orderBy: { createdAt: "desc" } });
    const text = JSON.stringify(ev);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-abcdef");
    expect(text).not.toContain("198.51.100.7");
    expect(ev.ipHash).toHaveLength(32);
  });
});
