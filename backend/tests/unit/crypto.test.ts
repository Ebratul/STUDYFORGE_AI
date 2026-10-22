import { beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../../src/config/env.js";
import { CryptoError, decryptSecret, encryptSecret, resetKeyringCache, signToken, verifyToken } from "../../src/lib/crypto.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

function useKeys(current: string, previous?: string) {
  process.env.CREDENTIAL_ENCRYPTION_KEY = current;
  if (previous) process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = previous;
  else delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
  resetEnvCache();
  resetKeyringCache();
}

beforeEach(() => useKeys(KEY_A));

describe("credential encryption (AES-256-GCM)", () => {
  const secret = "sk-test-0123456789abcdefghijkl";

  it("round-trips and never stores the plaintext", () => {
    const enc = encryptSecret(secret, "user1:OPENAI");
    expect(JSON.stringify(enc)).not.toContain(secret);
    expect(decryptSecret(enc, "user1:OPENAI")).toBe(secret);
  });

  it("uses a fresh IV every time (no deterministic ciphertext)", () => {
    const a = encryptSecret(secret, "u:OPENAI");
    const b = encryptSecret(secret, "u:OPENAI");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("rejects a ciphertext moved to another user/provider (AAD binding)", () => {
    const enc = encryptSecret(secret, "user1:OPENAI");
    expect(() => decryptSecret(enc, "user2:OPENAI")).toThrow(CryptoError);
    expect(() => decryptSecret(enc, "user1:GROQ")).toThrow(CryptoError);
  });

  it("detects tampering with ciphertext, tag or iv", () => {
    const enc = encryptSecret(secret, "u:OPENAI");
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString("base64");
    };
    expect(() => decryptSecret({ ...enc, ciphertext: flip(enc.ciphertext) }, "u:OPENAI")).toThrow(CryptoError);
    expect(() => decryptSecret({ ...enc, authTag: flip(enc.authTag) }, "u:OPENAI")).toThrow(CryptoError);
    expect(() => decryptSecret({ ...enc, iv: flip(enc.iv) }, "u:OPENAI")).toThrow(CryptoError);
  });

  it("fails with a generic error that reveals nothing", () => {
    const enc = encryptSecret(secret, "u:OPENAI");
    try {
      decryptSecret({ ...enc, keyId: "unknown" }, "u:OPENAI");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("The stored credential could not be decrypted.");
    }
  });

  it("supports key rotation via CREDENTIAL_ENCRYPTION_KEY_PREVIOUS", () => {
    const enc = encryptSecret(secret, "u:OPENAI"); // encrypted with KEY_A
    useKeys(KEY_B); // rotate without the old key
    expect(() => decryptSecret(enc, "u:OPENAI")).toThrow(CryptoError);
    useKeys(KEY_B, KEY_A); // old key kept as "previous"
    expect(decryptSecret(enc, "u:OPENAI")).toBe(secret);
    expect(encryptSecret(secret, "u:OPENAI").keyId).not.toBe(enc.keyId); // new writes use the new key
  });
});

describe("signed tokens", () => {
  it("verifies valid tokens and rejects tampered, wrong-purpose and expired ones", () => {
    const t = signToken({ d: "doc1", exp: Math.floor(Date.now() / 1000) + 60 }, "p1");
    expect(verifyToken<{ d: string }>(t, "p1")?.d).toBe("doc1");
    expect(verifyToken(t, "p2")).toBeNull();
    expect(verifyToken(`${t.slice(0, -2)}xx`, "p1")).toBeNull();
    expect(verifyToken(t.replace(/^[^.]+/, Buffer.from('{"d":"doc2"}').toString("base64url")), "p1")).toBeNull();
    expect(verifyToken(signToken({ d: "x", exp: Math.floor(Date.now() / 1000) - 5 }, "p1"), "p1")).toBeNull();
    expect(verifyToken("garbage", "p1")).toBeNull();
  });
});
