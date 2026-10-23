import { z } from "zod";
import type { AiProvider, CredentialStatus } from "../../generated/prisma/client.js";
import { RagAgentError, type RagAgentClient, type ValidateConfigRequest, type ValidateConfigResult, type ValidationCheck, type VectorStatus } from "../../clients/rag-agent.js";
import type { SessionUser } from "../../auth/types.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { encryptSecret } from "../../lib/crypto.js";
import { recordAudit } from "../../lib/audit.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { recordProviderEvent } from "../../lib/metrics.js";
import { redactString } from "../../lib/redact.js";
import { aad, apiKeySchema, getDecryptedKey } from "./credentials.js";
import { getEnv } from "../../config/env.js";
import { DIMENSION_LIMITS, documentCounts, LEGACY_DIMENSION, MAX_EMBEDDING_DIMENSION, MIN_EMBEDDING_DIMENSION, resolveRequestedDimension, type DimensionSource, type EmbeddingIdentity } from "./embedding-identity.js";
import { applyEmbeddingTarget, getReindexView, type ReindexView } from "./reindex.js";
import { logger } from "../../lib/logger.js";
import { generationParamsInput, LIMITS, modelIdSchema, NO_PARAMS, paramsFromRow, paramsToColumns, toWireParams, type GenerationParams } from "./preferences.js";
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
  /**
   * Vector size. A number asks for exactly that size (verified with the provider, never padded or truncated); `null` = Automatic (the
   * deployment default if one is set, else the model's own size); omitted = keep the saved size when the embedding model is unchanged.
   */
  embeddingDimension: z
    .number({ error: `Enter a whole number between ${MIN_EMBEDDING_DIMENSION} and ${MAX_EMBEDDING_DIMENSION}, or leave it empty for Automatic.` })
    .int(`Enter a whole number between ${MIN_EMBEDDING_DIMENSION} and ${MAX_EMBEDDING_DIMENSION}.`)
    .min(MIN_EMBEDDING_DIMENSION, `The smallest supported size is ${MIN_EMBEDDING_DIMENSION}.`)
    .max(MAX_EMBEDDING_DIMENSION, `The largest supported size is ${MAX_EMBEDDING_DIMENSION}.`)
    .nullable()
    .optional(),
  /** Generation settings. Omitted = keep the saved ones; a field set to null = provider default. Range-checked here, not just in the UI. */
  params: generationParamsInput.optional(),
});
export type ConnectionInput = z.infer<typeof connectionInput>;

export type ConnectionView = {
  configured: boolean;
  provider: "openrouter" | "openai" | "groq" | "mock" | null;
  providerLabel: string | null;
  apiKey: { configured: boolean; masked: string | null; status: CredentialStatus | null };
  chatModelId: string | null;
  embeddingModelId: string | null;
  /** ACTIVE index: the vector length that was measured when it was activated (database value; overrides the deployment default). */
  embeddingDimension: number | null;
  /** Non-null = the model is asked for exactly this size (a shortened vector); null = its native size is used. */
  embeddingRequestDimensions: number | null;
  dimensionLimits: typeof DIMENSION_LIMITS;
  /** Deployment default (env EMBEDDING_DIMENSIONS); only seeds a configuration whose size is left blank. */
  defaultEmbeddingDimension: number | null;
  /** A staged re-index (BUILDING or FAILED), if any. The active index keeps serving meanwhile. */
  reindex: ReindexView | null;
  /** Saved generation settings (null = provider default / not sent) and the server-side ranges. */
  params: GenerationParams;
  paramLimits: typeof LIMITS;
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
    select: { task: true, modelId: true, credentialId: true, validatedAt: true, embeddingDimension: true, embeddingRequestDimensions: true, temperature: true, topP: true, maxTokens: true, extraParams: true, credential: { select: CRED_SELECT } },
  });
  const chat = prefs.find((p) => p.task === "DEFAULT") ?? null;
  const emb = prefs.find((p) => p.task === "EMBEDDING") ?? null;
  const cred = chat?.credential ?? emb?.credential ?? (await db.providerCredential.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" }, select: CRED_SELECT }));
  const identity: EmbeddingIdentity | null = emb ? { provider: emb.credential.provider, model: emb.modelId, dimension: emb.embeddingDimension ?? LEGACY_DIMENSION } : null;
  const reindex = await getReindexView(user.id);
  // While a new embedding index is being built the embedding preference deliberately lags behind the chat one (it may use another credential).
  const mixed = Boolean(chat && emb && chat.credentialId !== emb.credentialId) && !reindex;
  return {
    configured: Boolean(chat && emb && !mixed),
    provider: cred ? (toWire(cred.provider) as ConnectionView["provider"]) : null,
    providerLabel: cred ? PROVIDER_LABEL[cred.provider] : null,
    apiKey: { configured: Boolean(cred), masked: cred ? `••••${cred.last4}` : null, status: cred?.status ?? null },
    chatModelId: chat?.modelId ?? null,
    embeddingModelId: emb?.modelId ?? null,
    embeddingDimension: emb ? (emb.embeddingDimension ?? LEGACY_DIMENSION) : null,
    embeddingRequestDimensions: emb?.embeddingRequestDimensions ?? null,
    dimensionLimits: DIMENSION_LIMITS,
    defaultEmbeddingDimension: getEnv().EMBEDDING_DIMENSIONS ?? null,
    reindex,
    params: chat ? paramsFromRow(chat) : NO_PARAMS,
    paramLimits: LIMITS,
    validatedAt: (emb?.validatedAt ?? chat?.validatedAt)?.toISOString() ?? null,
    documents: await documentCounts(user.id, identity),
    mixedProviders: mixed,
    costNote: COST_NOTE,
  };
}

const failMessage = (c: ValidationCheck, fallback: string) => redactString(c.message ?? fallback).slice(0, 300);

/** The six checks the form shows, in order. Each one is explained separately so the user knows exactly what to change. */
export type CheckKey = "auth" | "chat" | "chatParams" | "embedding" | "dimension" | "database";
export type DisplayChecks = Record<CheckKey, ValidationCheck>;
export const CHECK_KEYS: CheckKey[] = ["auth", "chat", "chatParams", "embedding", "dimension", "database"];
const SKIPPED: ValidationCheck = { ok: null, skipped: true };

/** Maps the checks onto the three form fields plus the generation settings (never any upstream text: only fixed safe messages). */
function fieldErrors(c: DisplayChecks): Record<string, string> {
  const f: Record<string, string> = {};
  if (c.auth.ok === false) f.apiKey = failMessage(c.auth, "The provider rejected this API key.");
  if (c.chat.ok === false) f.chatModelId = failMessage(c.chat, "The chat model couldn't be used with this key.");
  if (c.chatParams.ok === false) f.params = failMessage(c.chatParams, "The chat model doesn't accept these generation settings.");
  if (c.embedding.ok === false) f.embeddingModelId = failMessage(c.embedding, "The embedding model couldn't be used with this key.");
  else if (c.dimension.ok === false) f.embeddingDimension = failMessage(c.dimension, "This embedding model can't produce vectors of that size.");
  else if (c.database.ok === false) {
    // A size the vector index does not hold is fixed by changing the size (or model); anything else is about the installation.
    const msg = failMessage(c.database, "This installation's database can't store these vectors.");
    if (c.database.code === "VECTOR_DIMENSION_UNSUPPORTED") f.embeddingDimension = msg;
    else f.embeddingModelId = msg;
  }
  return f;
}

export type VectorStorageFacts = {
  extension: string | null;
  column: string | null;
  /** Set (with `remote`) only when VECTOR_STORE is dual or pinecone. Absent = pgvector, the original behaviour. */
  mode?: VectorStatus["mode"];
  /** What rag_agent reports about its vector store; null = it could not be reached. */
  remote?: VectorStatus | null;
};

/** Facts about the vector column, read from the live database catalogue, plus (dual / pinecone) what rag_agent says about the vector index. Nothing is written. */
export async function readVectorStorage(rag?: RagAgentClient): Promise<VectorStorageFacts> {
  const rows = await db.$queryRaw<{ ext: string | null; col: string | null }[]>`
    SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS ext,
           (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = '"DocumentChunk"'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped) AS col`;
  const facts: VectorStorageFacts = { extension: rows[0]?.ext ?? null, column: rows[0]?.col ?? null };
  const mode = getEnv().VECTOR_STORE;
  if (mode === "pgvector" || !rag) return facts;
  return { ...facts, mode, remote: await rag.vectorStatus().catch(() => null) };
}

/** dual / pinecone: can the vector index hold exactly `dimension` numbers, and do the two services agree on where vectors live? */
function remoteStorageCheck(storage: VectorStorageFacts, dimension: number): ValidationCheck {
  if (!storage.remote) return { ok: false, code: "VECTOR_STORE_UNAVAILABLE", message: "The document search index can't be reached right now. Try again in a moment." };
  if (storage.remote.mode !== storage.mode) return { ok: false, code: "VECTOR_STORE_MISCONFIGURED", message: "This installation's services are set to different vector stores. Contact the administrator." };
  const sizes = storage.remote.dimensions ?? [];
  if (!sizes.includes(dimension)) {
    return {
      ok: false,
      code: "VECTOR_DIMENSION_UNSUPPORTED",
      message: `This installation's document search index supports ${sizes.join(", ") || "no"}-dimensional vectors only; this setup produces ${dimension}. Choose a model or size that matches, or ask the administrator to add an index for it. Vectors are never padded or truncated.`,
      dimension,
    };
  }
  return { ok: true, dimension };
}

/**
 * Can the vectors be stored? pgvector: the chunk table must hold exactly `dimension` numbers (`vector(N)` needs N to match; the current
 * unconstrained `vector` accepts any length). dual / pinecone: the vector index must also hold that size.
 */
export function vectorStorageCheck(storage: VectorStorageFacts, dimension: number): ValidationCheck {
  if (storage.mode && storage.mode !== "pgvector") {
    const remote = remoteStorageCheck(storage, dimension);
    if (!remote.ok || storage.mode === "pinecone") return remote; // pinecone mode keeps no vector in the column, so its limits do not apply
  }
  if (!storage.extension) return { ok: false, code: "DB_VECTOR_UNAVAILABLE", message: "The database does not have the pgvector extension, so embeddings can't be stored." };
  if (!storage.column) return { ok: false, code: "DB_VECTOR_UNAVAILABLE", message: "The database has no embedding column for document chunks." };
  if (dimension > 16_000) return { ok: false, code: "DB_DIMENSION_MISMATCH", message: "pgvector cannot store vectors longer than 16000 numbers.", dimension };
  const m = /^vector\((\d+)\)$/.exec(storage.column);
  if (m && Number(m[1]) !== dimension) return { ok: false, code: "DB_DIMENSION_MISMATCH", message: `The database stores ${m[1]}-dimensional vectors; this model returns ${dimension}. A different size needs a database change first.`, dimension: Number(m[1]) };
  return { ok: true, dimension };
}

type DimInfo = { requested: number | null; source: DimensionSource };

const SIZE_CODES = new Set(["EMBEDDING_DIMENSION_MISMATCH", "EMBEDDING_DIMENSION_UNSUPPORTED"]);

/** Wording for "the model can't give this size". Built here from numbers the service measured; no upstream text is ever shown. */
function sizeMessage(code: string, d: DimInfo, returned: number | undefined, native: number | undefined): string {
  const origin = d.source === "environment" ? `The default size for this installation (${d.requested}) can't be used with this model. ` : d.source === "database" ? `Your saved size (${d.requested}) can't be used with this model. ` : "";
  const own = native ? ` This model's own size is ${native}.` : "";
  const fix = native ? ` Enter ${native} (its own size) or another size it supports.` : " Enter a size the model supports.";
  if (code === "EMBEDDING_DIMENSION_UNSUPPORTED") return `${origin}The provider doesn't let this model return ${d.requested}-dimensional vectors.${own}${fix}`;
  return `${origin}This model returned ${returned ?? "different"}-dimensional vectors when asked for ${d.requested}, so it doesn't support that size.${own} Vectors are never padded or truncated.${fix}`;
}

function composeChecks(raw: ValidateConfigResult, storage: VectorStorageFacts, dim: DimInfo): { checks: DisplayChecks; measured: number | null; native: number | null; requestDimensions: number | null } {
  const { auth, chat, embedding } = raw.checks;
  const chatParams = raw.checks.chat_params ?? SKIPPED;
  const sizeFailure = embedding.ok === false && SIZE_CODES.has(embedding.code ?? "");
  const latency = embedding.latency_ms !== undefined ? { latency_ms: embedding.latency_ms } : {};
  // "Is the embedding model available?" and "can it produce the size we need?" are different questions with different fixes.
  const available: ValidationCheck = sizeFailure || embedding.ok === true ? { ok: true, ...latency } : embedding;
  const native = embedding.native_dimension ?? null;

  let dimension: ValidationCheck = SKIPPED;
  let measured: number | null = null;
  let requestDimensions: number | null = null;
  if (sizeFailure) {
    dimension = { ok: false, code: embedding.code!, message: sizeMessage(embedding.code!, dim, embedding.dimension, native ?? undefined), ...(embedding.dimension !== undefined ? { dimension: embedding.dimension } : {}), ...(native !== null ? { native_dimension: native } : {}) };
  } else if (embedding.ok === true) {
    const got = embedding.dimension ?? raw.embedding_dimension ?? null;
    const req = embedding.request_dimensions ?? null;
    if (got === null) {
      dimension = { ok: false, code: "PROVIDER_ERROR", message: "The AI service did not report the vector size, so the model could not be verified." };
    } else if (got < MIN_EMBEDDING_DIMENSION || got > MAX_EMBEDDING_DIMENSION) {
      dimension = { ok: false, code: "EMBEDDING_DIMENSION_OUT_OF_RANGE", message: `This model returns ${got}-dimensional vectors; StudyForge supports ${MIN_EMBEDDING_DIMENSION} to ${MAX_EMBEDDING_DIMENSION}.`, dimension: got };
    } else if ((dim.requested !== null && got !== dim.requested) || (req !== null && req !== got)) {
      // Defence in depth: rag_agent already enforces this, but nothing is activated on its word alone.
      dimension = { ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", message: sizeMessage("EMBEDDING_DIMENSION_MISMATCH", dim, got, native ?? undefined), dimension: got };
    } else {
      measured = got;
      requestDimensions = req;
      dimension = { ok: true, dimension: got, ...(native !== null ? { native_dimension: native } : {}), ...(req !== null ? { request_dimensions: req } : {}) };
    }
  }
  const database: ValidationCheck = dimension.ok === true && measured !== null ? vectorStorageCheck(storage, measured) : SKIPPED;
  return { checks: { auth, chat, chatParams, embedding: available, dimension, database }, measured, native, requestDimensions };
}

/** rag_agent answered with a protocol error (404 / 422 / 500) rather than a provider result: it is not running the code this backend expects. */
function looksOutdated(err: RagAgentError): boolean {
  return err.httpStatus === 404 || err.code === "VALIDATION" || err.code === "NOT_FOUND" || err.code === "INTERNAL";
}

function mapRag(err: unknown): never {
  if (err instanceof RagAgentError) {
    if (looksOutdated(err)) {
      logger.error("ai.connection.rag_contract_mismatch", { status: err.httpStatus, code: err.code });
      throw new AppError("UPSTREAM_UNAVAILABLE", "The AI service didn't recognise this request, so it is probably out of date. Restart rag_agent and try again.", { providerCode: "AI_SERVICE_OUTDATED", retryable: false });
    }
    throw new AppError(err.code === "UPSTREAM_UNAVAILABLE" ? "UPSTREAM_UNAVAILABLE" : "PROVIDER_ERROR", err.message, { providerCode: err.code, retryable: err.retryable, retryAfterSec: err.retryAfterSeconds ?? undefined });
  }
  throw err;
}

/** Which key and provider? A newly typed key decides the provider; otherwise the saved credential is reused. */
async function resolveKey(user: SessionUser, input: ConnectionInput): Promise<{ provider: AiProvider; plaintext: string }> {
  if (input.apiKey) return { provider: deriveProvider(input.apiKey), plaintext: input.apiKey };
  const existing =
    (await db.modelPreference.findFirst({ where: { userId: user.id, task: { in: ["DEFAULT", "EMBEDDING"] } }, orderBy: { task: "asc" }, select: { credential: { select: { provider: true } } } }))?.credential.provider ??
    (await db.providerCredential.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: "desc" }, select: { provider: true } }))?.provider;
  if (!existing) throw new AppError("VALIDATION", "Enter your API key.", { fields: { apiKey: "Enter your API key." } });
  return { provider: existing, plaintext: (await getDecryptedKey(user.id, existing)).key }; // server-side only
}

/** The generation settings being tested/saved: what the form sent, else what is saved. Absent fields mean "provider default". */
async function effectiveParams(user: SessionUser, input: ConnectionInput): Promise<GenerationParams> {
  if (input.params) {
    const p = input.params;
    return { temperature: p.temperature ?? null, topP: p.topP ?? null, maxTokens: p.maxTokens ?? null, frequencyPenalty: p.frequencyPenalty ?? null, presencePenalty: p.presencePenalty ?? null, seed: p.seed ?? null };
  }
  const row = await db.modelPreference.findUnique({ where: { userId_task: { userId: user.id, task: "DEFAULT" } }, select: { temperature: true, topP: true, maxTokens: true, extraParams: true } });
  return row ? paramsFromRow(row) : NO_PARAMS;
}

type Run = { provider: AiProvider; plaintext: string; params: GenerationParams; raw: ValidateConfigResult; checks: DisplayChecks; measured: number | null; native: number | null; requestDimensions: number | null; dim: DimInfo; passed: boolean };

/** Which size is being asked for, and where that came from (EMBEDDING_SETTINGS_SPEC §2). Database values are re-checked: a corrupt row is ignored. */
async function candidateDimension(user: SessionUser, input: ConnectionInput): Promise<DimInfo> {
  const saved = await db.modelPreference.findUnique({ where: { userId_task: { userId: user.id, task: "EMBEDDING" } }, select: { modelId: true, embeddingDimension: true } });
  const savedDim = saved?.embeddingDimension != null && saved.embeddingDimension >= MIN_EMBEDDING_DIMENSION && saved.embeddingDimension <= MAX_EMBEDDING_DIMENSION ? saved.embeddingDimension : null;
  return resolveRequestedDimension(input.embeddingDimension, saved ? { modelId: saved.modelId, dimension: savedDim } : null, input.embeddingModelId, getEnv().EMBEDDING_DIMENSIONS ?? null);
}

/** Calls rag_agent (auth -> chat -> chat parameters -> embedding) and the database catalogue. Writes nothing. */
async function runChecks(rag: RagAgentClient, user: SessionUser, input: ConnectionInput): Promise<Run> {
  const { provider, plaintext } = await resolveKey(user, input);
  const params = await effectiveParams(user, input);
  const wireParams = toWireParams(params);
  const dim = await candidateDimension(user, input);
  const request: ValidateConfigRequest = {
    provider: toWire(provider),
    api_key: plaintext,
    chat_model: input.chatModelId,
    embedding_model: input.embeddingModelId,
    ...(dim.requested !== null ? { embedding_dimension: dim.requested } : {}),
    ...(Object.keys(wireParams).length ? { chat_params: wireParams } : {}),
  };
  let raw: ValidateConfigResult;
  try {
    raw = await rag.validateConfig(request);
  } catch (err) {
    recordProviderEvent(provider, "validate", false, err instanceof RagAgentError ? err.code : "INTERNAL");
    return mapRag(err);
  }
  const { checks, measured, native, requestDimensions } = composeChecks(raw, await readVectorStorage(rag), dim);
  // Defence in depth: never trust "ok" blindly; the verdict is recomputed from the individual checks.
  const passed = CHECK_KEYS.every((k) => checks[k].ok !== false) && checks.auth.ok === true && checks.chat.ok === true && checks.embedding.ok === true && checks.dimension.ok === true && checks.database.ok === true;
  const firstFailure = CHECK_KEYS.map((k) => checks[k]).find((c) => c.ok === false);
  recordProviderEvent(provider, "validate", passed, passed ? null : (firstFailure?.code ?? "VALIDATION"));
  if (!passed) {
    // Safe diagnostics for the operator: which check, which code, which endpoint/status. Never a key, body or prompt.
    for (const k of CHECK_KEYS) {
      const c = checks[k];
      if (c.ok === false) logger.warn("ai.connection.check_failed", { userId: user.id, provider: toWire(provider), check: k, code: c.code, ...(c.diagnostics ?? {}) });
    }
  }
  return { provider, plaintext, params, raw, checks, measured, native, requestDimensions, dim, passed };
}

export type TestResult = {
  ok: boolean;
  provider: ReturnType<typeof toWire>;
  checks: DisplayChecks;
  /** The verified vector length (null unless the dimension check passed). */
  measuredDimension: number | null;
  /** What the model returns without a `dimensions` parameter, when the probe got that far. */
  nativeDimension: number | null;
  /** The size that was asked for (null = Automatic and no deployment default: the native size). */
  requestedDimension: number | null;
  dimensionSource: DimensionSource;
};

/** "Test configuration": the same checks as saving, but nothing is written, ever. Only runs when the user asks for it. */
export async function testConnection(rag: RagAgentClient, user: SessionUser, input: ConnectionInput): Promise<TestResult> {
  await enforceRateLimit({ key: `ai-connection-test:${user.id}`, limit: 8, windowSec: 60 });
  const run = await runChecks(rag, user, input);
  return { ok: run.passed, provider: toWire(run.provider), checks: run.checks, measuredDimension: run.measured, nativeDimension: run.native, requestedDimension: run.dim.requested, dimensionSource: run.dim.source };
}

export type SaveResult = {
  connection: ConnectionView;
  checks: DisplayChecks;
  /** unchanged = same index; activated = switched immediately (nothing to re-embed); reindexing = the old index keeps serving while the new one is built. */
  embeddingChange: { status: "unchanged" | "activated" | "reindexing"; documents: number };
};

/**
 * Validates the key and both model ids with the provider, then — only if every check passed — activates them in ONE transaction.
 * A failed attempt (or an unreachable AI service) writes nothing, so the previous working configuration stays active.
 * The chat settings and credential are applied at once; the embedding configuration is either switched at once (nothing indexed yet) or
 * staged behind a verified re-index (see ./reindex.ts), so a model/size change never makes existing documents unsearchable.
 */
export async function saveConnection(rag: RagAgentClient, user: SessionUser, input: ConnectionInput): Promise<SaveResult> {
  await enforceRateLimit({ key: `ai-connection:${user.id}`, limit: 5, windowSec: 60 });
  const { provider, params, checks, measured, requestDimensions, passed } = await runChecks(rag, user, input);
  if (!passed || measured === null) throw new AppError("AI_CONFIG_INVALID", "We couldn't activate this configuration. Your previous settings are unchanged.", { checks, provider: toWire(provider), fields: fieldErrors(checks) });

  const now = new Date();
  const change = await db.$transaction(async (tx) => {
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
      create: { userId: user.id, task: "DEFAULT", credentialId, modelId: input.chatModelId, validatedAt: now, ...paramsToColumns(params) },
      update: { credentialId, modelId: input.chatModelId, validatedAt: now, ...(input.params ? paramsToColumns(params) : {}) },
    });
    return applyEmbeddingTarget(tx, user.id, credentialId, { provider, modelId: input.embeddingModelId, dimension: measured, requestDimensions }, now);
  });

  // Audit metadata: provider and what changed — never any part of the key.
  await recordAudit({ actorId: user.id, action: "ai.connection_saved", targetType: "credential", metadata: { provider, keyChanged: Boolean(input.apiKey), embeddingChanged: change.status !== "unchanged", dimension: measured, status: change.status } });
  if (change.status === "reindexing") await recordAudit({ actorId: user.id, action: "ai.embedding_reindex_started", targetType: "user", targetId: user.id, metadata: { provider, dimension: measured, count: change.documents } });
  return { connection: await getConnection(user), checks, embeddingChange: change };
}
