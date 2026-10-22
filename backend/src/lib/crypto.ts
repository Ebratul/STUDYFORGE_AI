import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeKey, getEnv } from "../config/env.js";

/**
 * Authenticated encryption for BYOK credentials: AES-256-GCM, random 96-bit IV per record, and the
 * owner/provider bound in as AAD so a ciphertext copied to another row (user) fails to decrypt.
 * Master keys come from the environment (never the database). `keyId` selects the key at decrypt time,
 * so CREDENTIAL_ENCRYPTION_KEY can be rotated while CREDENTIAL_ENCRYPTION_KEY_PREVIOUS keeps old rows readable.
 */
export type EncryptedSecret = { ciphertext: string; iv: string; authTag: string; keyId: string };

export class CryptoError extends Error {
  constructor() {
    super("The stored credential could not be decrypted.");
    this.name = "CryptoError";
  }
}

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

type Keyring = { current: { id: string; key: Buffer }; byId: Map<string, Buffer> };

let ring: Keyring | undefined;
export function resetKeyringCache() {
  ring = undefined;
}

function keyring(): Keyring {
  if (ring) return ring;
  const env = getEnv();
  const current = decodeKey(env.CREDENTIAL_ENCRYPTION_KEY)!;
  const byId = new Map<string, Buffer>([[keyIdOf(current), current]]);
  for (const k of (env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").filter(Boolean)) {
    const buf = decodeKey(k)!;
    byId.set(keyIdOf(buf), buf);
  }
  ring = { current: { id: keyIdOf(current), key: current }, byId };
  return ring;
}

export function encryptSecret(plaintext: string, aad: string): EncryptedSecret {
  const { current } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyId: current.id,
  };
}

/** Throws a generic CryptoError for every failure (unknown key id, tampering, wrong AAD) — no detail leaks. */
export function decryptSecret(secret: EncryptedSecret, aad: string): string {
  try {
    const key = keyring().byId.get(secret.keyId);
    if (!key) throw new Error("unknown key");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new CryptoError();
  }
}

/** Purpose-bound subkey derived from BETTER_AUTH_SECRET (used for signed download links). */
export function deriveKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(getEnv().BETTER_AUTH_SECRET), Buffer.alloc(0), `studyforge:${purpose}`, 32));
}

export function signToken(payload: Record<string, unknown>, purpose: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", deriveKey(purpose)).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Returns the payload if the signature is valid, else null. Expiry (`exp`, epoch seconds) is enforced here. */
export function verifyToken<T extends object>(token: string, purpose: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", deriveKey(purpose)).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp === "number" && exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
