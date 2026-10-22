import type { AiProvider } from "../../generated/prisma/client.js";
import type { ModelsResult, RagAgentClient } from "../../clients/rag-agent.js";
import type { SessionUser } from "../../auth/types.js";
import { db } from "../../lib/db.js";
import { getDecryptedKey } from "./credentials.js";
import { toWire } from "./providers.js";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: ModelsResult }>();

export function clearModelCache() {
  cache.clear();
}

/**
 * Lists the models the provider reports for THIS user's key (cached per credential, per rotation).
 * Nothing here is hard-coded: availability comes from the provider's own API.
 */
export async function getModels(rag: RagAgentClient, user: SessionUser, provider: AiProvider, refresh: boolean) {
  const cred = await db.providerCredential.findUnique({ where: { userId_provider: { userId: user.id, provider } }, select: { id: true, updatedAt: true } });
  const cacheKey = cred ? `${cred.id}:${cred.updatedAt.getTime()}` : "";
  const hit = cacheKey ? cache.get(cacheKey) : undefined;
  if (hit && !refresh && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };
  const { key } = await getDecryptedKey(user.id, provider);
  const value = await rag.listModels(toWire(provider), key);
  if (cacheKey) cache.set(cacheKey, { at: Date.now(), value });
  return { ...value, cached: false };
}
