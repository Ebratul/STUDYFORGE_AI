import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../src/lib/db.js";
import { decryptSecret } from "../../src/lib/crypto.js";
import { getDecryptedKey } from "../../src/modules/ai/credentials.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser } from "../helpers/users.js";

let t: TestApp;
beforeAll(() => {
  t = makeApp();
});
afterEach(() => {
  t.rag.testCalls.length = 0;
  vi.restoreAllMocks();
});

const KEY = "mock-valid-key";
const SECRET_LOOKING = "sk-proj-SuperSecretValue1234567890abcd";

describe("BYOK credential storage", () => {
  it("stores only ciphertext, never the key, and returns only a masked form", async () => {
    const u = await createUser();
    const res = await client(t, u).put("/api/ai/credentials/openai", { apiKey: SECRET_LOOKING });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET_LOOKING);
    expect(JSON.parse(text).credential.masked).toBe("••••abcd");

    const row = await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } });
    expect(JSON.stringify(row)).not.toContain(SECRET_LOOKING);
    expect(row.last4).toBe("abcd");
    expect(decryptSecret(row, `${u.id}:OPENAI`)).toBe(SECRET_LOOKING);
  });

  it("no endpoint ever returns the key, ciphertext, iv or tag (response scan)", async () => {
    const u = await createUser();
    const c = client(t, u);
    await c.put("/api/ai/credentials/openai", { apiKey: SECRET_LOOKING });
    const row = await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } });
    const paths = ["/api/ai/credentials", "/api/ai/providers", "/api/ai/preferences", "/api/ai/usage", "/api/account/export", "/api/me", "/api/profile"];
    for (const p of paths) {
      const body = await (await c.get(p)).text();
      for (const needle of [SECRET_LOOKING, row.ciphertext, row.iv, row.authTag]) expect(body, p).not.toContain(needle);
    }
  });

  it("rotation replaces the ciphertext, resets status and is audited without the key", async () => {
    const u = await createUser();
    const c = client(t, u);
    await c.put("/api/ai/credentials/openai", { apiKey: "sk-first-key-0000000001" });
    const before = await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } });
    const res = await c.put("/api/ai/credentials/openai", { apiKey: "sk-second-key-000000002" });
    expect((await res.json()).credential.rotatedAt).not.toBeNull();
    const after = await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } });
    expect(after.id).toBe(before.id);
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(await getDecryptedKey(u.id, "OPENAI").then((k) => k.key)).toBe("sk-second-key-000000002");
    const audits = await db.auditEvent.findMany({ where: { actorId: u.id, action: { startsWith: "ai.credential" } } });
    expect(audits.map((a) => a.action).sort()).toEqual(["ai.credential_rotated", "ai.credential_saved"]);
    expect(JSON.stringify(audits)).not.toMatch(/sk-first|sk-second/);
  });

  it("delete removes the credential and dependent model preferences", async () => {
    const u = await createUser();
    const c = client(t, u);
    await c.put("/api/ai/credentials/mock", { apiKey: KEY });
    await c.put("/api/ai/preferences", { default: { provider: "mock", modelId: "mock-chat" } });
    expect((await c.delete("/api/ai/credentials/mock")).status).toBe(200);
    expect(await db.providerCredential.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.modelPreference.count({ where: { userId: u.id } })).toBe(0);
    expect((await c.delete("/api/ai/credentials/mock")).status).toBe(404);
  });

  it("rejects malformed keys and unknown providers", async () => {
    const c = client(t, await createUser());
    expect((await c.put("/api/ai/credentials/openai", { apiKey: "short" })).status).toBe(422);
    expect((await c.put("/api/ai/credentials/openai", { apiKey: "has spaces in the key" })).status).toBe(422);
    expect((await c.put("/api/ai/credentials/anthropic", { apiKey: "sk-whatever-1234567890" })).status).toBe(422);
  });

  it("cross-user: B cannot see, test, list models for, delete or use A's credential", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await client(t, a).put("/api/ai/credentials/mock", { apiKey: KEY });
    const cb = client(t, b);
    expect((await (await cb.get("/api/ai/credentials")).json()).items).toEqual([]);
    expect((await cb.post("/api/ai/credentials/mock/test")).status).toBe(422); // B has no key: NOT_CONFIGURED, A's is never used
    expect((await cb.get("/api/ai/credentials/mock/models")).status).toBe(422);
    expect((await cb.delete("/api/ai/credentials/mock")).status).toBe(404);
    expect(t.rag.testCalls).toHaveLength(0);
    expect(await db.providerCredential.count({ where: { userId: a.id } })).toBe(1);
  });

  it("a ciphertext copied into another user's row cannot be decrypted (AAD binding)", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await client(t, a).put("/api/ai/credentials/mock", { apiKey: KEY });
    const row = await db.providerCredential.findFirstOrThrow({ where: { userId: a.id } });
    await db.providerCredential.create({ data: { userId: b.id, provider: "MOCK", ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, keyId: row.keyId, last4: row.last4 } });
    await expect(getDecryptedKey(b.id, "MOCK")).rejects.toThrow("could not be decrypted");
  });

  it("the mock provider is not offered when disabled", async () => {
    const prev = process.env.ALLOW_MOCK_PROVIDER;
    const { resetEnvCache } = await import("../../src/config/env.js");
    process.env.ALLOW_MOCK_PROVIDER = "false";
    resetEnvCache();
    try {
      const c = client(t, await createUser());
      expect((await c.put("/api/ai/credentials/mock", { apiKey: KEY })).status).toBe(422);
      const providers = (await (await c.get("/api/ai/providers")).json()).providers.map((p: { id: string }) => p.id);
      expect(providers).toEqual(["openai", "openrouter", "groq"]);
    } finally {
      process.env.ALLOW_MOCK_PROVIDER = prev;
      resetEnvCache();
    }
  });
});

describe("connection testing", () => {
  it("tests a candidate key without storing it", async () => {
    const u = await createUser();
    const c = client(t, u);
    const ok = await (await c.post("/api/ai/credentials/test", { provider: "mock", apiKey: KEY })).json();
    expect(ok).toMatchObject({ ok: true, modelsCount: 2 });
    const bad = await (await c.post("/api/ai/credentials/test", { provider: "mock", apiKey: "mock-wrong-key-1" })).json();
    expect(bad).toMatchObject({ ok: false, code: "PROVIDER_AUTH_INVALID" });
    expect(await db.providerCredential.count({ where: { userId: u.id } })).toBe(0);
  });

  it("testing a stored key updates its status; an invalid key is marked INVALID", async () => {
    const u = await createUser();
    const c = client(t, u);
    await c.put("/api/ai/credentials/mock", { apiKey: "mock-wrong-key-1" });
    expect((await (await c.post("/api/ai/credentials/mock/test")).json()).ok).toBe(false);
    expect((await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("INVALID");
    await c.put("/api/ai/credentials/mock", { apiKey: KEY });
    expect((await (await c.post("/api/ai/credentials/mock/test")).json()).ok).toBe(true);
    const row = await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.status).toBe("VALID");
    expect(row.lastTestedAt).not.toBeNull();
  });

  it("is rate limited per user", async () => {
    const c = client(t, await createUser());
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await c.post("/api/ai/credentials/test", { provider: "mock", apiKey: KEY })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("reports an unavailable AI service as 503 without leaking internals", async () => {
    const c = client(t, await createUser());
    t.rag.available = false;
    const res = await c.get("/api/ai/providers");
    t.rag.available = true;
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("lists models from the provider for the user's own key and caches them", async () => {
    const u = await createUser();
    const c = client(t, u);
    await c.put("/api/ai/credentials/mock", { apiKey: KEY });
    const before = t.rag.modelCalls;
    const first = await (await c.get("/api/ai/credentials/mock/models")).json();
    expect(first.models.map((m: { id: string }) => m.id)).toEqual(["mock-chat", "mock-embed"]);
    expect(first.cached).toBe(false);
    const second = await (await c.get("/api/ai/credentials/mock/models")).json();
    expect(second.cached).toBe(true);
    await c.get("/api/ai/credentials/mock/models?refresh=1");
    expect(t.rag.modelCalls - before).toBe(2);
  });
});

describe("secrets never reach logs", () => {
  it("a failing request containing a key does not log it", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const u = await createUser();
      t.rag.testProvider = async () => {
        throw new Error(`upstream blew up for key ${SECRET_LOOKING} Bearer abcdefghijklmnop123456`);
      };
      const res = await client(t, u).post("/api/ai/credentials/test", { provider: "mock", apiKey: SECRET_LOOKING });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(SECRET_LOOKING);
    } finally {
      process.env.LOG_LEVEL = prev;
    }
    expect(logs.join("\n")).not.toContain(SECRET_LOOKING);
    expect(logs.join("\n")).not.toMatch(/Bearer abcdefghijklmnop/);
  });
});
