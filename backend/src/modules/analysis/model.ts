import type { AiProvider } from "../../generated/prisma/client.js";
import type { AnalyzeChat } from "../../clients/rag-agent.js";
import { getEnv } from "../../config/env.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { getDecryptedKey } from "../ai/credentials.js";
import { resolveModel } from "../ai/preferences.js";
import { toWire } from "../ai/providers.js";

export type AnalysisModel = { provider: AiProvider; modelId: string; key: string; credentialId: string; params: { temperature: number | null; topP: number | null; maxTokens: number | null } };

/** The ANALYSIS task preference, falling back to the user's default model. Throws NOT_CONFIGURED when there is none (or no key for it). */
export async function resolveAnalysisModel(userId: string): Promise<AnalysisModel> {
  const m = await resolveModel(userId, "ANALYSIS");
  if (!m) throw new AppError("NOT_CONFIGURED", "Choose a default model in Settings → AI connection to get AI feedback.");
  const { key, credentialId } = await getDecryptedKey(userId, m.provider);
  return { provider: m.provider, modelId: m.modelId, key, credentialId, params: m.params };
}

/** Cheap check (no decryption): does the user have a model they could use for AI feedback? */
export async function hasAnalysisModel(userId: string): Promise<boolean> {
  const m = await resolveModel(userId, "ANALYSIS");
  if (!m) return false;
  return (await db.providerCredential.count({ where: { id: m.credentialId, userId } })) > 0;
}

export function chatBlock(m: AnalysisModel): AnalyzeChat {
  const cap = getEnv().ANALYSIS_MAX_OUTPUT_TOKENS;
  return { provider: toWire(m.provider), api_key: m.key, model: m.modelId, params: { temperature: m.params.temperature, top_p: m.params.topP, max_output_tokens: Math.min(m.params.maxTokens ?? cap, cap) } };
}

/** Provider/service failures that are worth another attempt (the job is re-run with backoff). */
export const TRANSIENT_CODES = new Set(["PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"]);
