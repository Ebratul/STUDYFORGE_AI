import { z } from "zod";
import type { AiProvider, CredentialStatus } from "../../generated/prisma/client.js";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { RagAgentError } from "../../clients/rag-agent.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { recordAudit } from "../../lib/audit.js";
import type { SessionUser } from "../../auth/types.js";
import { toWire } from "./providers.js";

/** Plain key shape check only (no provider-specific format assumptions): printable ASCII, no spaces, sane length. */
export const apiKeySchema = z
  .string()
  .trim()
  .min(8, "That key looks too short.")
  .max(512, "That key looks too long.")
  .regex(/^[\x21-\x7e]+$/, "API keys contain no spaces or special characters.");

export type CredentialView = {
  provider: AiProvider;
  masked: string; // "••••abcd" — the only representation that ever leaves the server
  status: CredentialStatus;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  rotatedAt: string | null;
};

const aad = (userId: string, provider: AiProvider) => `${userId}:${provider}`;

/** Explicit select: ciphertext/iv/authTag are never loaded for listing, so they cannot leak by accident. */
const VIEW_SELECT = { provider: true, last4: true, status: true, lastTestedAt: true, lastErrorCode: true, createdAt: true, rotatedAt: true } as const;

function toView(r: { provider: AiProvider; last4: string; status: CredentialStatus; lastTestedAt: Date | null; lastErrorCode: string | null; createdAt: Date; rotatedAt: Date | null }): CredentialView {
  return {
    provider: r.provider,
    masked: `••••${r.last4}`,
    status: r.status,
    lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
    lastErrorCode: r.lastErrorCode,
    createdAt: r.createdAt.toISOString(),
    rotatedAt: r.rotatedAt?.toISOString() ?? null,
  };
}

export async function listCredentials(user: SessionUser): Promise<CredentialView[]> {
  const rows = await db.providerCredential.findMany({ where: { userId: user.id }, select: VIEW_SELECT, orderBy: { provider: "asc" } });
  return rows.map(toView);
}

export async function saveCredential(user: SessionUser, provider: AiProvider, apiKey: string): Promise<CredentialView> {
  const enc = encryptSecret(apiKey, aad(user.id, provider));
  const last4 = apiKey.slice(-4);
  const existing = await db.providerCredential.findUnique({ where: { userId_provider: { userId: user.id, provider } }, select: { id: true } });
  const data = { ...enc, last4, status: "UNTESTED" as const, lastTestedAt: null, lastErrorCode: null };
  const row = existing
    ? await db.providerCredential.update({ where: { id: existing.id }, data: { ...data, rotatedAt: new Date() }, select: VIEW_SELECT })
    : await db.providerCredential.create({ data: { userId: user.id, provider, ...data }, select: VIEW_SELECT });
  // Audit metadata carries the provider only — never any part of the key.
  await recordAudit({ actorId: user.id, action: existing ? "ai.credential_rotated" : "ai.credential_saved", targetType: "credential", metadata: { provider } });
  return toView(row);
}

export async function deleteCredential(user: SessionUser, provider: AiProvider): Promise<void> {
  const { count } = await db.providerCredential.deleteMany({ where: { userId: user.id, provider } });
  if (count === 0) throw Errors.notFound();
  await recordAudit({ actorId: user.id, action: "ai.credential_deleted", targetType: "credential", metadata: { provider } });
}

/**
 * INTERNAL: returns the plaintext key for server-side use only (calls to rag_agent).
 * Always scoped by the acting user's id; a different user's credential id can never be resolved here.
 */
export async function getDecryptedKey(userId: string, provider: AiProvider): Promise<{ key: string; credentialId: string }> {
  const row = await db.providerCredential.findUnique({ where: { userId_provider: { userId, provider } } });
  if (!row) throw new AppError("NOT_CONFIGURED", `Add your ${provider.toLowerCase()} API key in Settings first.`);
  return { key: decryptSecret(row, aad(userId, provider)), credentialId: row.id };
}

export type TestOutcome = { ok: boolean; code?: string; message?: string; latencyMs?: number; modelsCount?: number };

async function runTest(rag: RagAgentClient, provider: AiProvider, key: string): Promise<TestOutcome> {
  try {
    const r = await rag.testProvider(toWire(provider), key);
    return r.ok ? { ok: true, latencyMs: r.latency_ms, modelsCount: r.models_count } : { ok: false, code: r.code, message: r.message };
  } catch (err) {
    if (err instanceof RagAgentError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

function statusFor(o: TestOutcome): CredentialStatus {
  if (o.ok) return "VALID";
  return o.code === "PROVIDER_AUTH_INVALID" ? "INVALID" : "ERROR";
}

/** Test a key BEFORE saving it. Nothing is stored. */
export function testCandidate(rag: RagAgentClient, provider: AiProvider, apiKey: string) {
  return runTest(rag, provider, apiKey);
}

export async function testStored(rag: RagAgentClient, user: SessionUser, provider: AiProvider): Promise<TestOutcome> {
  const { key, credentialId } = await getDecryptedKey(user.id, provider);
  const outcome = await runTest(rag, provider, key);
  await db.providerCredential.updateMany({
    where: { id: credentialId, userId: user.id },
    data: { status: statusFor(outcome), lastTestedAt: new Date(), lastErrorCode: outcome.ok ? null : (outcome.code ?? "UNKNOWN") },
  });
  await recordAudit({ actorId: user.id, action: "ai.credential_tested", targetType: "credential", metadata: { provider, ok: outcome.ok } });
  return outcome;
}

export async function markCredentialInvalid(credentialId: string) {
  await db.providerCredential.updateMany({ where: { id: credentialId }, data: { status: "INVALID", lastErrorCode: "PROVIDER_AUTH_INVALID", lastTestedAt: new Date() } });
}
