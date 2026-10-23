import { z } from "zod";
import type { AiProvider, AiTask } from "../../generated/prisma/client.js";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import type { SessionUser } from "../../auth/types.js";
import { enabledProviders, toWire } from "./providers.js";

export const TASKS = ["CHAT", "EMBEDDING", "MCQ", "CQ", "ANALYSIS"] as const;

/** Generation limits enforced for every request, regardless of what a model could technically accept. */
export const LIMITS = { temperature: { min: 0, max: 2 }, topP: { min: 0, max: 1 }, maxTokens: { min: 1, max: 32_768 } } as const;

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

export async function setPreferences(rag: RagAgentClient, user: SessionUser, input: PreferencesInputType): Promise<PreferencesView> {
  const changes: [AiTask, z.infer<typeof entry> | null][] = [];
  if (input.default !== undefined) changes.push(["DEFAULT", input.default]);
  for (const [task, value] of Object.entries(input.tasks ?? {})) if (value !== undefined) changes.push([task as AiTask, value]);

  let catalog: Awaited<ReturnType<RagAgentClient["providers"]>> | undefined;
  const creds = new Map((await db.providerCredential.findMany({ where: { userId: user.id }, select: { id: true, provider: true } })).map((c) => [c.provider, c.id]));

  const ops = [];
  for (const [task, value] of changes) {
    if (value === null) {
      ops.push(db.modelPreference.deleteMany({ where: { userId: user.id, task } }));
      continue;
    }
    const provider = value.provider.toUpperCase() as AiProvider;
    if (!(enabledProviders() as string[]).includes(provider)) throw new AppError("VALIDATION", "Unknown provider.", { fields: { [`${task}.provider`]: "Choose a supported provider." } });
    const credentialId = creds.get(provider);
    if (!credentialId) throw new AppError("VALIDATION", `Add your ${provider.toLowerCase()} API key first.`, { fields: { [`${task}.provider`]: "No API key saved for this provider." } });
    if (task === "EMBEDDING") {
      catalog ??= await rag.providers();
      const p = catalog.find((c) => c.id === toWire(provider));
      if (!p?.capabilities.embeddings) throw new AppError("VALIDATION", "That provider doesn't offer embeddings.", { fields: { "EMBEDDING.provider": "Choose a provider that supports embeddings." } });
    }
    const data = {
      credentialId,
      modelId: value.modelId,
      temperature: task === "EMBEDDING" ? null : (value.temperature ?? null),
      topP: task === "EMBEDDING" ? null : (value.topP ?? null),
      maxTokens: task === "EMBEDDING" ? null : (value.maxTokens ?? null),
    };
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
  params: { temperature: number | null; topP: number | null; maxTokens: number | null };
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
    params: { temperature: row.temperature, topP: row.topP, maxTokens: row.maxTokens },
  };
}
