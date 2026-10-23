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

/** Embedding dimension settings (docs/EMBEDDING_SETTINGS_SPEC.md §1, §6). The application caps; the server enforces them again. */
export const MIN_EMBEDDING_DIMENSION = 8;
export const MAX_EMBEDDING_DIMENSION = 4096;
export type DimensionLimits = { min: number; max: number };
/** Where the vector size of a tested configuration came from: typed by the user, saved earlier, the deployment default, or the model itself. */
export type DimensionSource = "request" | "database" | "environment" | "model";
/** A staged index that is being built (BUILDING) or could not be built (FAILED). The previous index stays active in both cases. */
export type ReindexView = {
  id: string;
  status: "BUILDING" | "FAILED";
  provider: string;
  modelId: string;
  dimension: number;
  progress: { total: number; done: number };
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string | null;
};
export type EmbeddingChangeStatus = "unchanged" | "activated" | "reindexing";
export type EmbeddingChange = { status: EmbeddingChangeStatus; documents: number };

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
    case "EMBEDDING_DIMENSION_MISMATCH": return t("This embedding model returned vectors of a different size than the one you asked for. Vectors are never padded or truncated.");
    case "EMBEDDING_DIMENSION_UNSUPPORTED": return t("The provider doesn't accept the vector size you asked for with this embedding model.");
    case "EMBEDDING_DIMENSION_OUT_OF_RANGE": return t("That vector size is outside the supported range.");
    case "DB_VECTOR_UNAVAILABLE": return t("The database can't store embeddings: the pgvector extension or the embedding column is missing.");
    case "DB_DIMENSION_MISMATCH": return t("The database can't store vectors of this size without a change to its schema.");
    case "PARAMETER_UNSUPPORTED": return t("This model doesn't accept one of the generation settings you chose.");
    // Not provider codes: rag_agent itself rejected the request, which means it isn't running the code this app expects.
    case "VALIDATION":
    case "NOT_FOUND":
    case "INTERNAL":
    case "AI_SERVICE_OUTDATED": return t("The AI service is out of date or needs a restart (rag_agent didn't recognise this request). Restart it and try again.");
    default: return t("The provider returned an error.");
  }
}
