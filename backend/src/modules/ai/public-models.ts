import { z } from "zod";
import type { PublicModel, RagAgentClient } from "../../clients/rag-agent.js";
import { RagAgentError } from "../../clients/rag-agent.js";
import { AppError } from "../../lib/errors.js";
import { enabledProviders, toWire } from "./providers.js";

/** Query for the optional "browse models" suggestions. Suggestions never restrict what can be typed. */
export const publicModelsQuery = z.object({
  kind: z.enum(["chat", "embedding"]).default("chat"),
  provider: z.string().min(1).max(20).default("openrouter"),
  q: z.string().trim().max(100).default(""),
  free: z.enum(["1", "0"]).default("0"),
  /** Look up one exact model id (to show which parameters the provider lists for it). */
  exact: z.string().trim().max(200).optional(),
});
export type PublicModelsQuery = z.infer<typeof publicModelsQuery>;

const LIMIT = 40;

export async function searchPublicModels(rag: RagAgentClient, query: PublicModelsQuery) {
  const provider = query.provider.toLowerCase();
  if (!(enabledProviders().map(toWire) as string[]).includes(provider)) throw new AppError("VALIDATION", "Unknown provider.", { fields: { provider: "Choose a supported provider." } });
  let listing;
  try {
    listing = await rag.publicModels(provider as Parameters<RagAgentClient["publicModels"]>[0], query.kind);
  } catch (err) {
    if (err instanceof RagAgentError) throw new AppError(err.code === "UPSTREAM_UNAVAILABLE" ? "UPSTREAM_UNAVAILABLE" : "PROVIDER_ERROR", "The model list couldn't be loaded right now. You can still type a model ID.", { providerCode: err.code });
    throw err;
  }
  if (query.exact) return { available: listing.available, total: listing.models.length, models: [] as PublicModel[], match: listing.models.find((m) => m.id === query.exact) ?? null };
  const needle = query.q.toLowerCase();
  let rows = listing.models;
  if (query.free === "1") rows = rows.filter((m) => m.free);
  if (needle) rows = rows.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
  return { available: listing.available, total: rows.length, models: rows.slice(0, LIMIT), match: null };
}
