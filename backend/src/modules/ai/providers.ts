import type { AiProvider } from "../../generated/prisma/client.js";
import type { ProviderId } from "../../clients/rag-agent.js";
import { getEnv } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";

export const toWire = (p: AiProvider): ProviderId => p.toLowerCase() as ProviderId;
export const fromWire = (p: string): AiProvider => p.toUpperCase() as AiProvider;

export const REAL_PROVIDERS: AiProvider[] = ["OPENAI", "OPENROUTER", "GROQ"];

export function enabledProviders(): AiProvider[] {
  return getEnv().ALLOW_MOCK_PROVIDER ? [...REAL_PROVIDERS, "MOCK"] : REAL_PROVIDERS;
}

/** Parses a provider path/body value; the mock provider is invisible unless explicitly enabled. */
export function parseProvider(value: string): AiProvider {
  const p = value.toUpperCase();
  if (!(enabledProviders() as string[]).includes(p)) throw new AppError("VALIDATION", "Unknown provider.", { fields: { provider: "Choose a supported provider." } });
  return p as AiProvider;
}
