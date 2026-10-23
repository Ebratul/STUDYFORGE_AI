import { beforeEach, describe, expect, it } from "vitest";
import { CloudinaryStorage, toStorageError } from "../../src/modules/documents/storage/cloudinary.js";
import { CLOUDINARY_KEY_PATTERN, StorageError } from "../../src/modules/documents/storage/types.js";
import { CLOUDINARY_TEST_SECRET, FakeCloudinary, fakeConfig } from "../helpers/fake-cloudinary.js";

let fake: FakeCloudinary;
const make = (over: Parameters<typeof fakeConfig>[0] = {}) => new CloudinaryStorage(fakeConfig(over), { sdk: fake.sdk, fetch: fake.fetch });
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

beforeEach(() => {
  fake = new FakeCloudinary();
});

describe("CloudinaryStorage keys", () => {
  it("generates unique, stable keys with the cld/ prefix", () => {
    const s = make();
    const [a, b] = [s.newKey("user1"), s.newKey("user1")];
    expect(a).toMatch(CLOUDINARY_KEY_PATTERN);
    expect(a).not.toBe(b);
    expect(a.startsWith("cld/user1/")).toBe(true);
  });

  it("refuses keys it did not generate (no traversal, no local keys)", async () => {
    const s = make();
    await expect(s.get("../../etc/passwd")).rejects.toThrow("invalid storage key");
    await expect(s.put("cld/x/../../y", bytes("x"), "application/pdf")).rejects.toThrow("invalid storage key");
    await expect(s.delete("u/user1/" + "a".repeat(32))).rejects.toThrow("invalid storage key");
  });

  it("requires credentials (no silent fallback)", () => {
    expect(() => new CloudinaryStorage({ ...fakeConfig(), apiSecret: "" }, { sdk: fake.sdk })).toThrow(StorageError);
  });
});

describe("CloudinaryStorage.put", () => {
  it("uploads as a raw, authenticated asset under the configured folder", async () => {
    const s = make({ folder: "/studyforge/documents/" });
    const key = s.newKey("user1");
    await s.put(key, bytes("%PDF-1.7 hello"), "application/pdf");
    const up = fake.calls.find((c) => c.op === "upload")!;
    expect(up.options).toMatchObject({ resource_type: "raw", type: "authenticated", overwrite: false, public_id: `studyforge/documents/user1/${key.split("/")[2]}` });
    expect(fake.store.get(up.publicId!)).toMatchObject({ resourceType: "raw", type: "authenticated" });
  });

  it("round-trips the exact bytes", async () => {
    const s = make();
    const key = s.newKey("user1");
    const data = new Uint8Array(300_000).map((_, i) => i % 251);
    await s.put(key, data, "application/pdf");
    expect(Buffer.from(await s.get(key)).equals(Buffer.from(data))).toBe(true);
  });

  it("enforces the optional provider cap before contacting Cloudinary", async () => {
    const s = make({ maxFileBytes: 10 });
    await expect(s.put(s.newKey("u1"), bytes("this is longer than ten bytes"), "application/pdf")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(fake.calls).toHaveLength(0);
  });

  it("removes an object that did not land as authenticated and reports a rejection", async () => {
    fake.forceUploadType = "upload"; // would be publicly deliverable
    const s = make();
    await expect(s.put(s.newKey("u1"), bytes("%PDF-"), "application/pdf")).rejects.toMatchObject({ code: "REJECTED" });
    expect(fake.store.size).toBe(0);
    expect(fake.calls.find((c) => c.op === "destroy")!.options).toMatchObject({ type: "upload" });
  });

  it.each([
    [{ http_code: 420, message: "Rate Limit Exceeded" }, "RATE_LIMITED"],
    [{ http_code: 429, message: "Too many" }, "RATE_LIMITED"],
    [{ http_code: 400, message: "File size too large. Got 12582912. Maximum is 10485760." }, "FILE_TOO_LARGE"],
    [{ http_code: 400, message: "Storage quota exceeded for this plan" }, "PROVIDER_QUOTA"],
    [{ http_code: 499, message: "Request Timeout", name: "TimeoutError" }, "UNAVAILABLE"],
    [{ http_code: 503, message: "upstream" }, "UNAVAILABLE"],
    [{ http_code: 401, message: `Invalid api_key 1234 ${CLOUDINARY_TEST_SECRET}` }, "NOT_CONFIGURED"],
  ] as const)("maps provider failure %j to %s with a sanitized message", async (fault, code) => {
    fake.fail("upload", fault);
    const s = make();
    const err = await s.put(s.newKey("u1"), bytes("%PDF-"), "application/pdf").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe(code);
    expect((err as StorageError).message).not.toMatch(/Invalid api_key|1234|secret|Maximum is|Rate Limit/i);
    expect((err as StorageError).message).not.toContain(CLOUDINARY_TEST_SECRET);
    expect(fake.store.size).toBe(0);
  });

  it("marks only transient failures as retryable", () => {
    expect(toStorageError({ http_code: 429 }).retryable).toBe(true);
    expect(toStorageError({ http_code: 503 }).retryable).toBe(true);
    expect(toStorageError({ http_code: 400, message: "quota exceeded" }).retryable).toBe(false);
    expect(toStorageError({ http_code: 401 }).retryable).toBe(false);
  });
});

describe("CloudinaryStorage.get", () => {
  it("reads through a short-lived signed API URL for the raw/authenticated asset, never a stored URL", async () => {
    const s = make();
    const key = s.newKey("u1");
    await s.put(key, bytes("%PDF-1.7 content"), "application/pdf");
    expect(text(await s.get(key))).toBe("%PDF-1.7 content");
    const signed = fake.calls.find((c) => c.op === "signed_url")!;
    expect(signed.options).toMatchObject({ resource_type: "raw", type: "authenticated" });
    const ttl = (signed.options.expires_at as number) - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
    expect(await s.signedDownloadUrl()).toBeNull(); // clients never receive provider URLs
  });

  it("reports a missing object as NOT_FOUND", async () => {
    await expect(make().get(make().newKey("u1"))).rejects.toMatchObject({ code: "NOT_FOUND", retryable: false });
  });

  it.each([
    [429, "RATE_LIMITED"],
    [503, "UNAVAILABLE"],
    [401, "NOT_CONFIGURED"],
    [403, "NOT_CONFIGURED"],
  ])("maps download HTTP %i to %s without surfacing the response body", async (status, code) => {
    fake.downloadStatus = status;
    const err = await make().get(make().newKey("u1")).catch((e: unknown) => e);
    expect((err as StorageError).code).toBe(code);
    expect((err as StorageError).message).not.toMatch(/error body/);
  });

  it("maps network failures and timeouts to a retryable UNAVAILABLE", async () => {
    for (const fault of [{ name: "TimeoutError", message: "timed out" }, { code: "ECONNRESET", message: "reset" }]) {
      fake.fail("download", fault);
      await expect(make().get(make().newKey("u1"))).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    }
  });

  it("refuses to buffer more than the configured read cap", async () => {
    const s = make({ maxReadBytes: 16 });
    const key = s.newKey("u1");
    await s.put(key, bytes("x".repeat(64)), "application/pdf");
    await expect(s.get(key)).rejects.toMatchObject({ code: "REJECTED" });
  });
});

describe("CloudinaryStorage.delete", () => {
  it("deletes the raw/authenticated object and invalidates the CDN", async () => {
    const s = make();
    const key = s.newKey("u1");
    await s.put(key, bytes("%PDF-"), "application/pdf");
    await s.delete(key);
    expect(fake.store.size).toBe(0);
    expect(fake.calls.find((c) => c.op === "destroy")!.options).toMatchObject({ resource_type: "raw", type: "authenticated", invalidate: true });
  });

  it("is idempotent: an already-missing object (and a repeated delete) succeeds", async () => {
    const s = make();
    const key = s.newKey("u1");
    await s.delete(key);
    await s.put(key, bytes("%PDF-"), "application/pdf");
    await s.delete(key);
    await s.delete(key);
    fake.fail("destroy", { http_code: 404, message: "Resource not found" });
    await s.delete(key);
  });

  it("throws on transient failures so the queued job retries, and keeps the object", async () => {
    const s = make();
    const key = s.newKey("u1");
    await s.put(key, bytes("%PDF-"), "application/pdf");
    fake.fail("destroy", { http_code: 429, message: "Rate Limit Exceeded" });
    await expect(s.delete(key)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fake.store.size).toBe(1);
    await s.delete(key); // the retry succeeds
    expect(fake.store.size).toBe(0);
  });
});

describe("CloudinaryStorage.ping", () => {
  it("succeeds without writing anything, and fails with a sanitized error", async () => {
    const s = make();
    await s.ping();
    expect(fake.store.size).toBe(0);
    fake.fail("ping", { http_code: 401, message: "Invalid credentials" });
    await expect(s.ping()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("credential handling", () => {
  it("only passes credentials to the SDK per call (never through global config) and never into URLs or errors", async () => {
    const s = make();
    const key = s.newKey("u1");
    await s.put(key, bytes("%PDF-"), "application/pdf");
    await s.get(key);
    const urls = fake.calls.filter((c) => c.op === "download").map((c) => JSON.stringify(c));
    for (const u of urls) expect(u).not.toContain(CLOUDINARY_TEST_SECRET);
    expect(JSON.stringify(Object.keys(s))).not.toContain(CLOUDINARY_TEST_SECRET);
  });
});
