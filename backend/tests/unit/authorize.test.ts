import { describe, expect, it } from "vitest";
import { assertOwner, can, ownedBy, requirePermission } from "../../src/auth/authorize.js";
import type { SessionUser } from "../../src/auth/types.js";
import { AppError } from "../../src/lib/errors.js";

const base: SessionUser = { id: "u1", name: "A", email: "a@x.test", emailVerified: true, image: null, role: "USER", status: "ACTIVE" };

describe("authorization primitives", () => {
  it("grants admin permissions only to active admins", () => {
    expect(can(base, "admin:dashboard:view")).toBe(false);
    expect(can({ ...base, role: "ADMIN" }, "admin:dashboard:view")).toBe(true);
    expect(can({ ...base, role: "ADMIN", status: "SUSPENDED" }, "admin:dashboard:view")).toBe(false);
  });

  it("requirePermission throws FORBIDDEN", () => {
    try {
      requirePermission(base, "admin:audit:view");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("FORBIDDEN");
    }
  });

  it("assertOwner reports NOT_FOUND (not FORBIDDEN) for foreign or missing owners", () => {
    expect(() => assertOwner(base, "u1")).not.toThrow();
    for (const owner of ["u2", null, undefined, ""]) {
      try {
        assertOwner(base, owner);
        expect.unreachable();
      } catch (e) {
        expect((e as AppError).code).toBe("NOT_FOUND");
      }
    }
  });

  it("ownedBy scopes queries to the actor", () => {
    expect(ownedBy(base)).toEqual({ userId: "u1" });
  });
});
