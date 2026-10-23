import { EN } from "@/lib/format-locale";
import type { TFunction } from "@/lib/i18n/translate";

export type ProviderId = "openai" | "openrouter" | "groq" | "mock";
export type CredentialStatus = "UNTESTED" | "VALID" | "INVALID" | "ERROR";
export type TaskId = "CHAT" | "EMBEDDING" | "MCQ" | "CQ" | "ANALYSIS";

export type CredentialView = {
  provider: string;
  masked: string;
  status: CredentialStatus;
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  rotatedAt: string | null;
};

export type ProviderInfo = {
  id: ProviderId;
  name: string;
  docs_url?: string;
  key_hint?: string;
  capabilities: { chat: boolean; embeddings: boolean; streaming: boolean; structured_output: string };
  embedding_dimensions_note?: string;
  credential: CredentialView | null;
};

export type ProvidersResponse = {
  providers: ProviderInfo[];
  tasks: TaskId[];
  limits: { temperature: { min: number; max: number }; topP: { min: number; max: number }; maxTokens: { min: number; max: number } };
};

export type PrefView = { provider: string; modelId: string; temperature: number | null; topP: number | null; maxTokens: number | null };
export type PreferencesResponse = { default: PrefView | null; tasks: Partial<Record<TaskId, PrefView>> };

export type ModelInfo = {
  id: string;
  name?: string;
  context_length?: number | null;
  capabilities: { chat: boolean; embeddings: boolean; streaming: boolean; structured_output: string; tools: string };
  capability_source: "api" | "catalogue" | "unverified";
  embedding_dimensions?: string;
};
export type ModelsResponse = { provider: ProviderId; fetched_at: string; models: ModelInfo[]; cached: boolean };

export type UsageResponse = { tokens: number; requests: number; tokenLimit: number; requestLimit: number; resetsAt: string };

/** Safe, human explanations for the normalised error codes (never raw provider text). */
export function describeProviderCode(code: string | null | undefined, t: TFunction = EN.t): string {
  switch (code) {
    case "PROVIDER_AUTH_INVALID": return t("The provider rejected this API key. Check that it's correct, active and has access.");
    case "PROVIDER_RATE_LIMITED": return t("The provider is rate-limiting requests. Wait a moment and try again.");
    case "PROVIDER_TIMEOUT": return t("The provider took too long to respond.");
    case "PROVIDER_UNAVAILABLE": return t("The provider is unavailable right now.");
    case "MODEL_NOT_FOUND": return t("That model wasn't found for your key.");
    case "CONTEXT_TOO_LONG": return t("The request was too long for this model.");
    case "CAPABILITY_UNSUPPORTED": return t("That model or provider doesn't support this feature.");
    case "CONTENT_FILTERED": return t("The provider declined to answer this request.");
    case "QUOTA_EXCEEDED": return t("Your provider account is out of quota or credit.");
    case "UPSTREAM_UNAVAILABLE": return t("The AI service is unavailable right now. Please try again shortly.");
    case "EMBEDDING_DIMENSION_MISMATCH": return t("This embedding model's vectors don't match what StudyForge can store.");
    default: return t("The provider returned an error.");
  }
}
