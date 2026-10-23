import { z } from "zod";
import type { AiProvider, AiTask } from "../../generated/prisma/client.js";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { Prisma } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import type { SessionUser } from "../../auth/types.js";
import { enabledProviders } from "./providers.js";

export const TASKS = ["CHAT", "EMBEDDING", "MCQ", "CQ", "ANALYSIS"] as const;

/** Generation limits enforced for every request, regardless of what a model could technically accept. */
export const LIMITS = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  maxTokens: { min: 1, max: 32_768 },
  frequencyPenalty: { min: -2, max: 2 },
  presencePenalty: { min: -2, max: 2 },
  seed: { min: 0, max: 2_147_483_647 },
} as const;

const opt = (min: number, max: number, int = false) => {
  const n = int ? z.number().int() : z.number();
  return n.min(min).max(max).nullable().optional();
};

/** The user-editable generation parameters. `null` clears a parameter (provider default); every value is range-checked on the server. */
export const generationParamsInput = z.strictObject({
  temperature: opt(LIMITS.temperature.min, LIMITS.temperature.max),
  topP: opt(LIMITS.topP.min, LIMITS.topP.max),
  maxTokens: opt(LIMITS.maxTokens.min, LIMITS.maxTokens.max, true),
  frequencyPenalty: opt(LIMITS.frequencyPenalty.min, LIMITS.frequencyPenalty.max),
  presencePenalty: opt(LIMITS.presencePenalty.min, LIMITS.presencePenalty.max),
  seed: opt(LIMITS.seed.min, LIMITS.seed.max, true),
});
export type GenerationParamsInput = z.infer<typeof generationParamsInput>;

export type GenerationParams = { temperature: number | null; topP: number | null; maxTokens: number | null; frequencyPenalty: number | null; presencePenalty: number | null; seed: number | null };
export const NO_PARAMS: GenerationParams = { temperature: null, topP: null, maxTokens: null, frequencyPenalty: null, presencePenalty: null, seed: null };

const extraParamsSchema = z.object({ frequencyPenalty: z.number().min(-2).max(2).nullable().optional(), presencePenalty: z.number().min(-2).max(2).nullable().optional(), seed: z.number().int().min(0).max(LIMITS.seed.max).nullable().optional() });

/** Reads a stored row defensively: a corrupt/out-of-range JSON value is treated as "not set", never forwarded to a provider. */
export function paramsFromRow(row: { temperature: number | null; topP: number | null; maxTokens: number | null; extraParams?: unknown }): GenerationParams {
  const extra = extraParamsSchema.safeParse(row.extraParams ?? {});
  const e = extra.success ? extra.data : {};
  return { temperature: row.temperature, topP: row.topP, maxTokens: row.maxTokens, frequencyPenalty: e.frequencyPenalty ?? null, presencePenalty: e.presencePenalty ?? null, seed: e.seed ?? null };
}

/** Column values for a full parameter set (used by the connection form). */
export function paramsToColumns(p: GenerationParams) {
  const extra = { ...(p.frequencyPenalty !== null ? { frequencyPenalty: p.frequencyPenalty } : {}), ...(p.presencePenalty !== null ? { presencePenalty: p.presencePenalty } : {}), ...(p.seed !== null ? { seed: p.seed } : {}) };
  return { temperature: p.temperature, topP: p.topP, maxTokens: p.maxTokens, extraParams: Object.keys(extra).length ? extra : Prisma.DbNull };
}

/** rag_agent wire form. Only parameters the user actually set are included, so nothing unsupported is ever sent by default. */
export function toWireParams(p: GenerationParams, maxTokensCap?: number) {
  const out: Record<string, number> = {};
  if (p.temperature !== null) out.temperature = p.temperature;
  if (p.topP !== null) out.top_p = p.topP;
  const max = p.maxTokens !== null ? (maxTokensCap ? Math.min(p.maxTokens, maxTokensCap) : p.maxTokens) : maxTokensCap;
  if (max !== undefined) out.max_output_tokens = max;
  if (p.frequencyPenalty !== null) out.frequency_penalty = p.frequencyPenalty;
  if (p.presencePenalty !== null) out.presence_penalty = p.presencePenalty;
  if (p.seed !== null) out.seed = p.seed;
  return out;
}

/** Free-text model id: format only — there is deliberately no allow-list (AI_CONNECTION_SPEC §0.1). */
export const modelIdSchema = z
  .string()
  .trim()
  .min(1, "Choose or enter a model.")
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/, "Model ids contain letters, digits and . _ : / @ + - only.");

const entry = z.object({
  provider: z.string().min(1).max(20),
  modelId: modelIdSchema,
  temperature: z.number().min(LIMITS.temperature.min).max(LIMITS.temperature.max).nullable().optional(),
  topP: z.number().min(LIMITS.topP.min).max(LIMITS.topP.max).nullable().optional(),
  maxTokens: z.number().int().min(LIMITS.maxTokens.min).max(LIMITS.maxTokens.max).nullable().optional(),
});

export const preferencesInput = z.object({
  default: entry.nullable().optional(),
  tasks: z.object(Object.fromEntries(TASKS.map((t) => [t, entry.nullable().optional()])) as Record<(typeof TASKS)[number], z.ZodOptional<z.ZodNullable<typeof entry>>>).partial().optional(),
});
export type PreferencesInputType = z.infer<typeof preferencesInput>;

export type PrefView = { provider: AiProvider; modelId: string; temperature: number | null; topP: number | null; maxTokens: number | null };
export type PreferencesView = { default: PrefView | null; tasks: Partial<Record<(typeof TASKS)[number], PrefView>> };

export async function getPreferences(user: SessionUser): Promise<PreferencesView> {
  const rows = await db.modelPreference.findMany({ where: { userId: user.id }, include: { credential: { select: { provider: true } } } });
  const view: PreferencesView = { default: null, tasks: {} };
  for (const r of rows) {
    const v: PrefView = { provider: r.credential.provider, modelId: r.modelId, temperature: r.temperature, topP: r.topP, maxTokens: r.maxTokens };
    if (r.task === "DEFAULT") view.default = v;
    else (view.tasks as Record<string, PrefView>)[r.task] = v;
  }
  return view;
}

export async function setPreferences(_rag: RagAgentClient, user: SessionUser, input: PreferencesInputType): Promise<PreferencesView> {
  const changes: [AiTask, z.infer<typeof entry> | null][] = [];
  if (input.default !== undefined) changes.push(["DEFAULT", input.default]);
  for (const [task, value] of Object.entries(input.tasks ?? {})) if (value !== undefined) changes.push([task as AiTask, value]);

  const creds = new Map((await db.providerCredential.findMany({ where: { userId: user.id }, select: { id: true, provider: true } })).map((c) => [c.provider, c.id]));

  const ops = [];
  for (const [task, value] of changes) {
    if (value === null) {
      ops.push(db.modelPreference.deleteMany({ where: { userId: user.id, task } }));
      continue;
    }
    if (task === "EMBEDDING") {
      // The embedding model and its dimension are one verified unit (EMBEDDING_SETTINGS_SPEC §3/§5): changing either here would skip the
      // live check and the staged re-index and leave a stale dimension behind. Only removal is allowed on this endpoint.
      throw new AppError("VALIDATION", "Change the embedding model in Settings → AI connection, where it is verified and your documents are re-indexed safely.", { fields: { "EMBEDDING.modelId": "Use Settings → AI connection to change the embedding model." } });
    }
    const provider = value.provider.toUpperCase() as AiProvider;
    if (!(enabledProviders() as string[]).includes(provider)) throw new AppError("VALIDATION", "Unknown provider.", { fields: { [`${task}.provider`]: "Choose a supported provider." } });
    const credentialId = creds.get(provider);
    if (!credentialId) throw new AppError("VALIDATION", `Add your ${provider.toLowerCase()} API key first.`, { fields: { [`${task}.provider`]: "No API key saved for this provider." } });
    const data = { credentialId, modelId: value.modelId, temperature: value.temperature ?? null, topP: value.topP ?? null, maxTokens: value.maxTokens ?? null };
    ops.push(db.modelPreference.upsert({ where: { userId_task: { userId: user.id, task } }, create: { userId: user.id, task, ...data }, update: data }));
  }
  await db.$transaction(ops);
  await recordAudit({ actorId: user.id, action: "ai.preferences_updated", targetType: "user", targetId: user.id, metadata: { tasks: changes.map(([t]) => t) } });
  return getPreferences(user);
}

export type ResolvedModel = {
  provider: AiProvider;
  modelId: string;
  credentialId: string;
  /** EMBEDDING only: the vector length measured when the configuration was validated (null for older rows). */
  embeddingDimension: number | null;
  /** EMBEDDING only: the verified `dimensions` request parameter (null = native size, nothing is sent). */
  embeddingRequestDimensions: number | null;
  params: GenerationParams;
};

/** Task preference, falling back to the user's default for generation tasks. Embeddings never fall back to the chat default. */
export async function resolveModel(userId: string, task: (typeof TASKS)[number]): Promise<ResolvedModel | null> {
  const wanted: AiTask[] = task === "EMBEDDING" ? ["EMBEDDING"] : [task, "DEFAULT"];
  const rows = await db.modelPreference.findMany({ where: { userId, task: { in: wanted } }, include: { credential: { select: { provider: true } } } });
  const row = wanted.map((t) => rows.find((r) => r.task === t)).find(Boolean);
  if (!row) return null;
  return {
    provider: row.credential.provider,
    modelId: row.modelId,
    credentialId: row.credentialId,
    embeddingDimension: row.embeddingDimension,
    embeddingRequestDimensions: row.embeddingRequestDimensions,
    params: paramsFromRow(row),
  };
}
