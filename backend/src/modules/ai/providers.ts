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

export const PROVIDER_LABEL: Record<AiProvider, string> = { OPENAI: "OpenAI", OPENROUTER: "OpenRouter", GROQ: "Groq", MOCK: "Mock (testing only)" };

/**
 * The connection form has no provider selector: the provider is derived from the key (AI_CONNECTION_SPEC §0.3) and every provider has a
 * fixed, server-side endpoint, so nothing the user types can choose a destination. Unrecognised keys default to OpenRouter.
 * The mock provider is returned only when explicitly enabled (never in production, where the configuration refuses to start with it).
 */
export function deriveProvider(apiKey: string, allowMock: boolean = getEnv().ALLOW_MOCK_PROVIDER): AiProvider {
  const k = apiKey.trim();
  if (allowMock && k.startsWith("mock-")) return "MOCK";
  if (k.startsWith("sk-or-")) return "OPENROUTER";
  if (k.startsWith("gsk_")) return "GROQ";
  if (k.startsWith("sk-")) return "OPENAI";
  return "OPENROUTER";
}
