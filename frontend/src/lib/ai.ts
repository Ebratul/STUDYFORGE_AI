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

export const STATUS_LABEL: Record<CredentialStatus, string> = {
  UNTESTED: "Not tested yet",
  VALID: "Connected",
  INVALID: "Key rejected",
  ERROR: "Couldn't verify",
};

/** Safe, human explanations for the normalised error codes (never raw provider text). */
export function describeProviderCode(code: string | null | undefined): string {
  switch (code) {
    case "PROVIDER_AUTH_INVALID": return "The provider rejected this API key. Check that it's correct, active and has access.";
    case "PROVIDER_RATE_LIMITED": return "The provider is rate-limiting requests. Wait a moment and try again.";
    case "PROVIDER_TIMEOUT": return "The provider took too long to respond.";
    case "PROVIDER_UNAVAILABLE": return "The provider is unavailable right now.";
    case "MODEL_NOT_FOUND": return "That model wasn't found for your key.";
    case "CONTEXT_TOO_LONG": return "The request was too long for this model.";
    case "CAPABILITY_UNSUPPORTED": return "That model or provider doesn't support this feature.";
    case "CONTENT_FILTERED": return "The provider declined to answer this request.";
    case "QUOTA_EXCEEDED": return "Your provider account is out of quota or credit.";
    case "UPSTREAM_UNAVAILABLE": return "The AI service is unavailable right now. Please try again shortly.";
    default: return "The provider returned an error.";
  }
}

export const TASK_LABEL: Record<TaskId, { title: string; hint: string; available: boolean }> = {
  CHAT: { title: "Conversation", hint: "Used for chat. Falls back to your default model.", available: true },
  EMBEDDING: { title: "Embeddings (documents)", hint: "Used to index and search your documents. Required for document-only chat.", available: true },
  MCQ: { title: "MCQ generation", hint: "Used to write multiple-choice questions. Falls back to your default model.", available: true },
  CQ: { title: "CQ generation", hint: "Used to write CQs and model answers. Falls back to your default model.", available: true },
  ANALYSIS: { title: "Result analysis", hint: "Stored now; used when exam analysis ships.", available: false },
};
