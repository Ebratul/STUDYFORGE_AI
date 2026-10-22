import { describe, expect, it } from "vitest";
import { can } from "../../src/auth/authorize.js";
import { hasAdminArea, PERMISSIONS, roleHasPermission, type Permission } from "../../src/auth/permissions.js";
import { errorCategory } from "../../src/http/middleware.js";
import { maskEmail } from "../../src/modules/admin/service.js";

const user = (role: "USER" | "SUPPORT" | "ADMIN", status: "ACTIVE" | "SUSPENDED" = "ACTIVE") => ({ id: "u", name: "n", email: "e@x.y", emailVerified: true, image: null, role, status });

describe("permission catalogue", () => {
  const manage: Permission[] = ["admin:users:manage", "admin:jobs:manage", "admin:config:view"];
  const read: Permission[] = ["admin:dashboard:view", "admin:users:view", "admin:audit:view", "admin:metrics:view", "admin:usage:view", "admin:jobs:view", "admin:health:view"];

  it("USER has no admin permission, SUPPORT is read-only, ADMIN has all", () => {
    for (const p of [...read, ...manage]) {
      expect(roleHasPermission("USER", p), p).toBe(false);
      expect(roleHasPermission("ADMIN", p), p).toBe(true);
    }
    for (const p of read) expect(roleHasPermission("SUPPORT", p), p).toBe(true);
    for (const p of manage) expect(roleHasPermission("SUPPORT", p), p).toBe(false);
  });

  it("every role keeps control of its own account", () => {
    for (const r of ["USER", "SUPPORT", "ADMIN"] as const) expect(roleHasPermission(r, "account:manage-own")).toBe(true);
  });

  it("a suspended account has no permission whatever its role", () => {
    for (const p of Object.keys(PERMISSIONS) as Permission[]) expect(can(user("ADMIN", "SUSPENDED"), p), p).toBe(false);
  });

  it("there is no permission that grants access to private content", () => {
    expect(Object.keys(PERMISSIONS).filter((p) => /conversation|document|credential|answer|attempt|message|key/i.test(p))).toEqual([]);
  });

  it("hasAdminArea is true only for SUPPORT and ADMIN", () => {
    expect([hasAdminArea("USER"), hasAdminArea("SUPPORT"), hasAdminArea("ADMIN")]).toEqual([false, true, true]);
  });
});

describe("helpers", () => {
  it("masks e-mail addresses", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@e***.com");
    expect(maskEmail("weird")).toBe("w***@***");
  });
  it("maps error codes to categories", () => {
    expect(errorCategory("NOT_FOUND")).toBe("validation");
    expect(errorCategory("SOMETHING_NEW")).toBe("internal");
  });
});
