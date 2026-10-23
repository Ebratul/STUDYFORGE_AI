import { z } from "zod";
import type { AiProvider, CredentialStatus } from "../../generated/prisma/client.js";
import { RagAgentError, type RagAgentClient, type ValidateConfigResult, type ValidationCheck } from "../../clients/rag-agent.js";
import type { SessionUser } from "../../auth/types.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { encryptSecret } from "../../lib/crypto.js";
import { recordAudit } from "../../lib/audit.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { recordProviderEvent } from "../../lib/metrics.js";
import { redactString } from "../../lib/redact.js";
import { aad, apiKeySchema, getDecryptedKey } from "./credentials.js";
import { currentEmbeddingIdentity, documentCounts, documentIdentitySelect, EXPECTED_DIMENSION, isStale, type EmbeddingIdentity } from "./embedding-identity.js";
import { modelIdSchema } from "./preferences.js";
import { deriveProvider, PROVIDER_LABEL, toWire } from "./providers.js";

export const COST_NOTE = "Saving makes two tiny paid requests (one chat, one embedding) with your key, so your provider may charge a very small amount.";

/** Three inputs, nothing else. A blank/omitted key means "keep the saved key" (an empty field can never overwrite it). */
export const connectionInput = z.strictObject({
  apiKey: z
    .string()
    .max(1000, "That key looks too long.")
    .optional()
    .transform((v) => v?.trim() || undefined)
    .pipe(apiKeySchema.optional()),
  chatModelId: modelIdSchema,
  embeddingModelId: modelIdSchema,
});
export type ConnectionInput = z.infer<typeof connectionInput>;

export type ConnectionView = {
  configured: boolean;
  provider: "openrouter" | "openai" | "groq" | "mock" | null;
  providerLabel: string | null;
  apiKey: { configured: boolean; masked: string | null; status: CredentialStatus | null };
  chatModelId: string | null;
  embeddingModelId: string | null;
  embeddingDimension: number | null;
  expectedDimension: number;
  validatedAt: string | null;
  documents: { ready: number; stale: number; processing: number };
  /** True when chat and embedding still point at different credentials (set up before the single connection form existed). */
  mixedProviders: boolean;
  costNote: string;
};

/** Explicit selects only: ciphertext/iv/authTag are never loaded here, so they cannot leak by accident. */
const CRED_SELECT = { id: true, provider: true, last4: true, status: true } as const;

export async function getConnection(user: SessionUser): Promise<ConnectionView> {
  const prefs = await db.modelPreference.findMany({
    where: { userId: user.id, task: { in: ["DEFAULT", "EMBEDDING"] } },
    select: { task: true, modelId: true, credentialId: true, validatedAt: true, embeddingDimension: true, credential: { select: CRED_SELECT } },
  });
  const chat = prefs.find((p) => p.task === "DEFAULT") ?? null;
  const emb = prefs.find((p) => p.task === "EMBEDDING") ?? null;
  const cred = chat?.credential ?? emb?.credential ?? (await db.providerCredential.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" }, select: CRED_SELECT }));
  const identity: EmbeddingIdentity | null = emb ? { provider: emb.credential.provider, model: emb.modelId, dimension: emb.embeddingDimension ?? EXPECTED_DIMENSION } : null;
  const mixed = Boolean(chat && emb && chat.credentialId !== emb.credentialId);
  return {
    configured: Boolean(chat && emb && !mixed),
    provider: cred ? (toWire(cred.provider) as ConnectionView["provider"]) : null,
    providerLabel: cred ? PROVIDER_LABEL[cred.provider] : null,
    apiKey: { configured: Boolean(cred), masked: cred ? `••••${cred.last4}` : null, status: cred?.status ?? null },
    chatModelId: chat?.modelId ?? null,
    embeddingModelId: emb?.modelId ?? null,
    embeddingDimension: emb?.embeddingDimension ?? null,
    expectedDimension: EXPECTED_DIMENSION,
    validatedAt: (emb?.validatedAt ?? chat?.validatedAt)?.toISOString() ?? null,
    documents: await documentCounts(user.id, identity),
    mixedProviders: mixed,
    costNote: COST_NOTE,
  };
}

const failMessage = (c: ValidationCheck, fallback: string) => redactString(c.message ?? fallback).slice(0, 300);

/** Maps the three provider checks onto the three form fields (never any upstream text: rag_agent only returns fixed safe messages). */
function fieldErrors(r: ValidateConfigResult): Record<string, string> {
  const f: Record<string, string> = {};
  const { auth, chat, embedding } = r.checks;
  if (auth.ok === false) f.apiKey = failMessage(auth, "The provider rejected this API key.");
  if (chat.ok === false) f.chatModelId = failMessage(chat, "The chat model couldn't be used with this key.");
  if (embedding.ok === false) f.embeddingModelId = failMessage(embedding, "The embedding model couldn't be used with this key.");
  return f;
}

function mapRag(err: unknown): never {
  if (err instanceof RagAgentError)
    throw new AppError(err.code === "UPSTREAM_UNAVAILABLE" ? "UPSTREAM_UNAVAILABLE" : "PROVIDER_ERROR", err.message, { providerCode: err.code, retryable: err.retryable, retryAfterSec: err.retryAfterSeconds ?? undefined });
  throw err;
}

export type SaveResult = {
  connection: ConnectionView;
  checks: ValidateConfigResult["checks"];
  reembedRequired: boolean;
  documentsAffected: number;
};

/**
 * Validates the key and both model ids with the provider, then — only if every check passed — activates them in ONE transaction.
 * A failed attempt (or an unreachable AI service) writes nothing, so the previous working configuration stays active.
 */
export async function saveConnection(rag: RagAgentClient, user: SessionUser, input: ConnectionInput): Promise<SaveResult> {
  await enforceRateLimit({ key: `ai-connection:${user.id}`, limit: 5, windowSec: 60 });

  // Which key and provider? A newly typed key decides the provider; otherwise the saved credential is reused.
  let provider: AiProvider;
  let plaintext: string;
  if (input.apiKey) {
    provider = deriveProvider(input.apiKey);
    plaintext = input.apiKey;
  } else {
    const existing =
      (await db.modelPreference.findFirst({ where: { userId: user.id, task: { in: ["DEFAULT", "EMBEDDING"] } }, orderBy: { task: "asc" }, select: { credential: { select: { provider: true } } } }))?.credential.provider ??
      (await db.providerCredential.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" }, select: { provider: true } }))?.provider;
    if (!existing) throw new AppError("VALIDATION", "Enter your API key.", { fields: { apiKey: "Enter your API key." } });
    provider = existing;
    plaintext = (await getDecryptedKey(user.id, provider)).key; // server-side only
  }

  const previous = await currentEmbeddingIdentity(user.id);

  let result: ValidateConfigResult;
  try {
    result = await rag.validateConfig({ provider: toWire(provider), api_key: plaintext, chat_model: input.chatModelId, embedding_model: input.embeddingModelId });
  } catch (err) {
    recordProviderEvent(provider, "validate", false, err instanceof RagAgentError ? err.code : "INTERNAL");
    return mapRag(err);
  }

  // Defence in depth: never trust "ok" blindly. The embedding must be a usable vector of the one length this installation can store.
  const dimension = result.checks.embedding.dimension ?? result.embedding_dimension;
  const embeddingUsable = result.checks.embedding.ok === true && dimension === EXPECTED_DIMENSION;
  const passed = result.ok && result.checks.auth.ok === true && result.checks.chat.ok === true && embeddingUsable;
  const firstFailure = [result.checks.auth, result.checks.chat, result.checks.embedding].find((c) => c.ok === false);
  recordProviderEvent(provider, "validate", passed, passed ? null : (firstFailure?.code ?? "VALIDATION"));
  if (!passed) {
    const checks = { ...result.checks };
    if (result.checks.embedding.ok === true && !embeddingUsable)
      checks.embedding = { ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", message: `This model produces ${dimension ?? "unknown"}-dimensional vectors; StudyForge stores ${EXPECTED_DIMENSION}.`, ...(dimension ? { dimension } : {}) };
    const fields = fieldErrors({ ...result, checks });
    throw new AppError("AI_CONFIG_INVALID", "We couldn't activate this configuration. Your previous settings are unchanged.", { checks, provider: toWire(provider), fields });
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    let credentialId: string;
    const existing = await tx.providerCredential.findUnique({ where: { userId_provider: { userId: user.id, provider } }, select: { id: true } });
    if (input.apiKey) {
      const data = { ...encryptSecret(input.apiKey, aad(user.id, provider)), last4: input.apiKey.slice(-4), status: "VALID" as const, lastTestedAt: now, lastErrorCode: null };
      const row = existing
        ? await tx.providerCredential.update({ where: { id: existing.id }, data: { ...data, rotatedAt: now }, select: { id: true } })
        : await tx.providerCredential.create({ data: { userId: user.id, provider, ...data }, select: { id: true } });
      credentialId = row.id;
    } else {
      credentialId = existing!.id;
      await tx.providerCredential.update({ where: { id: credentialId }, data: { status: "VALID", lastTestedAt: now, lastErrorCode: null } });
    }
    // Params (temperature etc.) of an existing DEFAULT row are kept; task-specific rows (CHAT/MCQ/CQ/ANALYSIS) are not touched.
    await tx.modelPreference.upsert({
      where: { userId_task: { userId: user.id, task: "DEFAULT" } },
      create: { userId: user.id, task: "DEFAULT", credentialId, modelId: input.chatModelId, validatedAt: now },
      update: { credentialId, modelId: input.chatModelId, validatedAt: now },
    });
    await tx.modelPreference.upsert({
      where: { userId_task: { userId: user.id, task: "EMBEDDING" } },
      create: { userId: user.id, task: "EMBEDDING", credentialId, modelId: input.embeddingModelId, validatedAt: now, embeddingDimension: dimension! },
      update: { credentialId, modelId: input.embeddingModelId, validatedAt: now, embeddingDimension: dimension! },
    });
  });

  const current: EmbeddingIdentity = { provider, model: input.embeddingModelId, dimension: dimension! };
  const changed = !previous || previous.provider !== current.provider || previous.model !== current.model || previous.dimension !== current.dimension;
  const docs = await db.document.findMany({ where: { ownerId: user.id }, select: documentIdentitySelect, take: 2000 });
  const documentsAffected = docs.filter((d) => isStale(d, current)).length;
  // Audit metadata: provider and what changed — never any part of the key.
  await recordAudit({ actorId: user.id, action: "ai.connection_saved", targetType: "credential", metadata: { provider, keyChanged: Boolean(input.apiKey), embeddingChanged: changed } });
  return { connection: await getConnection(user), checks: result.checks, reembedRequired: changed && documentsAffected > 0, documentsAffected };
}
