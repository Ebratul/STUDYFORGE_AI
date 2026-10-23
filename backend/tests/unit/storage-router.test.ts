import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnv } from "../../src/config/env.js";
import { CloudinaryStorage } from "../../src/modules/documents/storage/cloudinary.js";
import { createStorage } from "../../src/modules/documents/storage/index.js";
import { LocalStorage } from "../../src/modules/documents/storage/local.js";
import { RoutedStorage } from "../../src/modules/documents/storage/router.js";
import { FakeCloudinary, fakeConfig } from "../helpers/fake-cloudinary.js";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  APP_URL: "http://localhost:3000",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  RAG_AGENT_TOKEN: "t".repeat(24),
  AUTH_GOOGLE_ID: "",
  AUTH_GOOGLE_SECRET: "",
};
const creds = { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key-123", CLOUDINARY_API_SECRET: "secret-123" };
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function pair() {
  const fake = new FakeCloudinary();
  const local = new LocalStorage(mkdtempSync(join(tmpdir(), "sf-router-")));
  const cld = new CloudinaryStorage(fakeConfig(), { sdk: fake.sdk, fetch: fake.fetch });
  return { fake, local, cld };
}

describe("RoutedStorage", () => {
  it("sends new uploads to the primary and serves each key from the backend its prefix names", async () => {
    const { fake, local, cld } = pair();
    const routed = new RoutedStorage(cld, { u: local, cld });
    expect(routed.driver).toBe("cloudinary");

    const legacy = local.newKey("user1");
    await local.put(legacy, bytes("legacy local doc")); // uploaded before Cloudinary was enabled
    const fresh = routed.newKey("user1");
    expect(fresh.startsWith("cld/")).toBe(true);
    await routed.put(fresh, bytes("%PDF-new"), "application/pdf");

    expect(text(await routed.get(legacy))).toBe("legacy local doc");
    expect(text(await routed.get(fresh))).toBe("%PDF-new");
    expect(fake.store.size).toBe(1); // the legacy document never touched Cloudinary

    await routed.delete(legacy);
    await expect(routed.get(legacy)).rejects.toThrow();
    expect(fake.store.size).toBe(1);
    await routed.delete(fresh);
    expect(fake.store.size).toBe(0);
  });

  it("keeps local as the primary when STORAGE_DRIVER=local, and still reaches existing Cloudinary documents", async () => {
    const { fake, local, cld } = pair();
    await cld.put("cld/user1/" + "a".repeat(32), bytes("%PDF-old"), "application/pdf");
    const routed = new RoutedStorage(local, { u: local, cld });
    expect(routed.driver).toBe("local");
    expect(routed.newKey("user1").startsWith("u/")).toBe(true);
    expect(text(await routed.get("cld/user1/" + "a".repeat(32)))).toBe("%PDF-old");
    expect(fake.store.size).toBe(1);
  });

  it("fails clearly instead of falling back when Cloudinary is not configured", async () => {
    const { local } = pair();
    const routed = new RoutedStorage(local, { u: local, cld: null });
    await expect(routed.get("cld/user1/" + "a".repeat(32))).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(routed.get("x/user1/" + "a".repeat(32))).rejects.toThrow("invalid storage key");
  });

  it("health-checks the primary backend only", async () => {
    const { fake, local, cld } = pair();
    await new RoutedStorage(cld, { u: local, cld }).ping();
    expect(fake.calls.map((c) => c.op)).toEqual(["ping"]);
  });
});

describe("createStorage", () => {
  it("selects Cloudinary for new uploads when configured", () => {
    const s = createStorage(parseEnv({ ...base, STORAGE_DRIVER: "cloudinary", ...creds }));
    expect(s.driver).toBe("cloudinary");
    expect(s.newKey("u1").startsWith("cld/")).toBe(true);
  });

  it("keeps local behaviour by default", () => {
    const s = createStorage(parseEnv(base));
    expect(s.driver).toBe("local");
    expect(s.newKey("u1").startsWith("u/")).toBe(true);
  });

  it("refuses to start with STORAGE_DRIVER=cloudinary and missing credentials (no silent local fallback)", () => {
    expect(() => parseEnv({ ...base, STORAGE_DRIVER: "cloudinary" })).toThrow(/CLOUDINARY_CLOUD_NAME.*required/s);
    expect(() => parseEnv({ ...base, STORAGE_DRIVER: "cloudinary", CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "k" })).toThrow(/CLOUDINARY_API_SECRET/);
  });
});
