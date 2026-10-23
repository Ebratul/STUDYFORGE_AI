import { getEnv } from "../config/env.js";
import { redactString } from "../lib/redact.js";

/**
 * Client for the internal rag_agent service (see rag_agent/CONTRACT.md).
 * - Authenticates with a shared bearer token; the service is not reachable from browsers.
 * - API keys travel only in request bodies and are never put into error messages or logs.
 */

export type ProviderId = "openai" | "openrouter" | "groq" | "mock";

export type ProviderCatalogEntry = {
  id: ProviderId;
  name: string;
  docs_url?: string;
  key_hint?: string;
  capabilities: { chat: boolean; embeddings: boolean; streaming: boolean; structured_output: string };
  embedding_dimensions_note?: string;
};

export type TestResult =
  | { ok: true; latency_ms: number; models_count: number }
  | { ok: false; code: string; message: string; retryable?: boolean };

export type ModelInfo = {
  id: string;
  name?: string;
  context_length?: number | null;
  capabilities: { chat: boolean; embeddings: boolean; streaming: boolean; structured_output: string; tools: string };
  capability_source: "api" | "catalogue" | "unverified";
  embedding_dimensions?: string;
};

/** One step of the connection validation (AI_CONNECTION_SPEC §1). `ok: null` + `skipped` = not run because an earlier step failed. */
export type ValidationCheck = {
  ok: boolean | null;
  skipped?: boolean;
  code?: string;
  message?: string;
  latency_ms?: number;
  /** embedding: the verified vector length; native_dimension = what the model returns without a `dimensions` parameter; request_dimensions = the verified `dimensions` value (absent = none needed). */
  dimension?: number;
  native_dimension?: number;
  request_dimensions?: number;
  /** chat_params: parameters verified / rejected (provider wire names). */
  verified?: string[];
  unsupported?: string[];
  /** Sanitised facts about a failing upstream call (endpoint, HTTP status, short allow-listed codes). Never bodies or keys. */
  diagnostics?: Record<string, string | number | boolean>;
};
/** `embedding_dimension` is the REQUESTED size (omitted = the model's native size); the verified size comes back in the result. */
export type ValidateConfigRequest = { provider: ProviderId; api_key: string; chat_model: string; embedding_model: string; embedding_dimension?: number; chat_params?: WireParams };
export type ValidateConfigResult = {
  ok: boolean;
  provider: ProviderId;
  embedding_dimension: number | null;
  checks: { auth: ValidationCheck; chat: ValidationCheck; chat_params: ValidationCheck; embedding: ValidationCheck };
};

export type PublicModel = { id: string; name: string; context_length: number | null; free: boolean; supported_parameters: string[] | null };
export type PublicModelsResult = { provider: ProviderId; kind: "chat" | "embedding"; available: boolean; fetched_at: string; models: PublicModel[] };

export type ModelsResult = { provider: ProviderId; fetched_at: string; models: ModelInfo[] };

/** Generation parameters on the wire; a key is present only when the user set it (nothing else is ever sent). */
export type WireParams = { temperature?: number | null; top_p?: number | null; max_output_tokens?: number | null; frequency_penalty?: number | null; presence_penalty?: number | null; seed?: number | null };

export type Credentials = { provider: ProviderId; api_key: string; model: string };
/** Embedding credentials always name the vector length; `request_dimensions` (= dimension) is present only when the model must be asked for it. */
export type EmbeddingCredentials = Credentials & { dimension: number; request_dimensions?: number };

export type ChatRequest = {
  request_id: string;
  user_id: string;
  mode: "GENERAL" | "DOCUMENT_ONLY";
  chat: Credentials & { params: WireParams };
  embedding: EmbeddingCredentials | null;
  messages: { role: "user" | "assistant"; content: string }[];
  document_ids: string[];
  use_documents: boolean;
  retrieval?: { top_k: number; min_similarity: number; max_context_chars: number };
};

export type RagCitation = {
  ordinal: number;
  document_id: string;
  document_name: string;
  chunk_id: string | null;
  page: number | null;
  section: string | null;
  quote: string;
  quote_verified: boolean;
};

export type ChatEvent =
  | { event: "meta"; data: { request_id?: string; mode: string; provider: string; model: string; documents_considered: number; retrieval: string } }
  | { event: "status"; data: { stage: string } }
  | { event: "delta"; data: { text: string } }
  | { event: "citations"; data: { citations: RagCitation[] } }
  | {
      event: "final";
      data: {
        content: string;
        fallback: boolean;
        insufficient_evidence: boolean;
        finish_reason?: string | null;
        usage?: { prompt_tokens: number | null; completion_tokens: number | null };
      };
    }
  | { event: "error"; data: { code: string; message: string; retryable?: boolean; retry_after_seconds?: number | null } };

// --- Part 3: question generation (rag_agent/CONTRACT.md §9, docs/PART3_SPEC.md §7) ---

export type GenerateKind = "mcq" | "cq";

export type GenerateRequest = {
  request_id: string;
  user_id: string;
  chat: Credentials & { params: WireParams };
  embedding: EmbeddingCredentials | null;
  context_tokens: number | null;
  grounding: "SOURCE_ONLY" | "SOURCE_PREFERRED" | "GENERAL";
  sources: { topic: string | null; pasted_text: string | null; document_ids: string[] };
  spec: Record<string, unknown>;
  avoid: string[];
  cross_check: boolean;
  limits: { batch_size: number; max_llm_calls: number; max_context_chars: number; timeout_seconds: number; max_regen_per_batch: number };
};

export type RagSource = {
  document_id: string | null;
  document_name: string;
  chunk_id?: string | null;
  page: number | null;
  section: string | null;
  quote: string;
  quote_verified: boolean;
};
export type RagAnswer = { text: string; basis: string; sources?: RagSource[] };
export type RagQuestion = {
  id: string;
  kind: "MCQ" | "CQ";
  language: string;
  stem: string;
  stimulus: string | null;
  options: { id: string; text: string }[];
  correct_option_id: string | null;
  parts: { id: string; label: string | null; level: string | null; prompt: string; marks: number; answer: RagAnswer | null }[];
  answer: RagAnswer | null;
  explanation: string | null;
  short_note: string | null;
  difficulty: string;
  subject: string | null;
  topic: string | null;
  tags: string[];
  marks: number;
  negative_marks: number;
  sources: RagSource[];
  source_support: string;
  review_reasons: string[];
};
export type GenerateResult = {
  questions: RagQuestion[];
  rejected: number;
  warnings: { code: string; message: string }[];
  usage: { prompt_tokens: number | null; completion_tokens: number | null; llm_calls: number };
  sources_used?: { document_id: string | null; document_name: string }[];
};
export type GenerateEvent =
  | { event: "meta"; data: { request_id?: string; provider?: string; model?: string; kind?: string } }
  | { event: "status"; data: { stage: string; batch?: number; batches?: number } }
  | { event: "result"; data: GenerateResult }
  | { event: "error"; data: { code: string; message: string; retryable?: boolean; retry_after_seconds?: number | null; reason?: string } };

// --- Part 5: AI feedback and study plans (rag_agent/CONTRACT.md §10, docs/PART5_SPEC.md §3 and §6) ---

export type AnalyzeStepType = "REVIEW_NOTES" | "REVISIT_QUESTIONS" | "PRACTICE_MCQ" | "PRACTICE_CQ" | "COMPARE_ATTEMPTS" | "ASK_ASSISTANT" | "READ_DOCUMENT";
export type AnalyzeChat = Credentials & { params: WireParams };
export type AnalyzeTopic = { topic: string; questions: number; correct: number; incorrect: number; unanswered: number; accuracy_bp: number };

export type AnalyzeResultContext = {
  language: "en" | "bn";
  exam: { title: string; question_count: number; percent_bp: number; band: string; correct: number; incorrect: number; unanswered: number };
  topics: AnalyzeTopic[];
  weak_topics: string[];
  strong_topics: string[];
  incorrect_items: { topic: string; stem: string; selected_text: string | null; correct_text: string | null; explanation: string | null; note: string | null }[];
  history: {
    data_level: "INITIAL" | "BASED_ON_HISTORY";
    results_total: number;
    previous_same_exam: { percent_bp: number }[];
    topic_history: { topic: string; answered: number; accuracy_bp: number }[];
  };
};
export type AnalyzePlanContext = {
  language: "en" | "bn";
  data_level: "INITIAL" | "BASED_ON_HISTORY";
  results: { percent_bp: number }[];
  topics: AnalyzeTopic[];
  weak_topics: string[];
  strong_topics: string[];
};
export type AnalyzeResultRequest = { request_id: string; chat: AnalyzeChat; context: AnalyzeResultContext };
export type AnalyzePlanRequest = { request_id: string; chat: AnalyzeChat; context: AnalyzePlanContext };

/** Model output as returned by rag_agent (already code-verified there; the backend verifies it again). */
export type RagAnalysisContent = {
  summary: string;
  strengths: { topic: string; detail: string }[];
  weaknesses: { topic: string; detail: string; evidence: string }[];
  next_steps?: { type: string; topic: string | null; text: string }[];
  nextSteps?: { type: string; topic: string | null; text: string }[];
  caveats: string[];
};
export type RagPlanContent = {
  headline: string;
  focus: { topic: string; reason: string }[];
  steps: { type: string; topic: string | null; text: string; minutes?: number | null }[];
  caveats: string[];
};
export type AnalyzeResponse<T> = { result: T; usage: { prompt_tokens: number | null; completion_tokens: number | null; llm_calls: number }; warnings?: { code: string; message: string }[] };

export type IngestParams = {
  document_id: string;
  owner_id: string;
  filename: string;
  mime_type: string;
  processing_version: number;
  embedding: EmbeddingCredentials;
};

/** `unknown` = a legacy chunk set whose provider was never recorded. */
export type ReindexIdentity = { provider: ProviderId | "unknown"; model: string; dimension: number };
export type ReindexParams = {
  document_id: string;
  owner_id: string;
  processing_version: number;
  source: ReindexIdentity;
  target: EmbeddingCredentials;
};
/** STALE = the document changed (or its source chunks are gone) while embedding; nothing was written. */
export type ReindexResult = { type: "result"; status: "READY" | "STALE"; chunk_count: number; embedding_dimension: number | null };

/** `(document_id, chunk_id)` pairs of one embedding identity: exactly the vectors a retried job must remove from the vector store. */
export type SupersededVectors = { identity: ReindexIdentity; chunks: [string, string][] }[];

export type IngestResult =
  | {
      type: "result";
      status: "READY" | "NEEDS_OCR" | "FAILED";
      page_count?: number | null;
      text_length?: number | null;
      chunk_count?: number | null;
      embedding_model?: string | null;
      /** Verified length of the vectors that were stored (AI_CONNECTION_SPEC §1). */
      embedding_dimension?: number | null;
      code?: string | null;
      message?: string | null;
      /** dual / pinecone only: the previous version's vectors (their PostgreSQL rows are already gone). Absent in pgvector mode. */
      superseded?: SupersededVectors;
      /** More than rag_agent reports per ingest were superseded; the rest are stale-version vectors the reconcile tool removes. */
      superseded_truncated?: boolean;
    }
  | { type: "error"; code: string; message: string; retryable?: boolean; retry_after_seconds?: number | null };

/** Body of POST /v1/vectors/delete. Idempotent; in pgvector mode rag_agent answers `noop`. */
export type VectorDeleteRequest =
  | { scope: "document"; owner_id: string; document_id: string }
  | { scope: "user"; owner_id: string; document_ids: string[] }
  | { scope: "chunks"; owner_id: string; identity: ReindexIdentity; chunks: [string, string][] };
export type VectorDeleteResult = { status: "ok" | "noop"; mode: string; deleted: number };
/** What rag_agent is configured with (no hosts, names or keys). `dimensions` = the vector sizes the remote index holds, null in pgvector mode. */
export type VectorStatus = { mode: "pgvector" | "dual" | "pinecone"; dimensions: number[] | null };

export class RagAgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds: number | null = null,
    public readonly httpStatus = 502,
    /** Machine reason from rag_agent (e.g. GENERATION_FAILED → INVALID_OUTPUT | UNGROUNDED_OUTPUT). */
    public readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "RagAgentError";
  }
}

export interface RagAgentClient {
  providers(): Promise<ProviderCatalogEntry[]>;
  testProvider(provider: ProviderId, apiKey: string): Promise<TestResult>;
  listModels(provider: ProviderId, apiKey: string): Promise<ModelsResult>;
  /** Auth + one tiny chat call + one tiny embedding call with the given key and model ids; nothing is stored. */
  validateConfig(body: ValidateConfigRequest, signal?: AbortSignal): Promise<ValidateConfigResult>;
  /** Keyless suggestions from the provider's public model listing (cached by rag_agent). */
  publicModels(provider: ProviderId, kind: "chat" | "embedding"): Promise<PublicModelsResult>;
  ingest(params: IngestParams, file: Uint8Array, onProgress: (stage: string, progress: number) => void, signal?: AbortSignal): Promise<IngestResult>;
  /** Re-embeds one document's existing chunk texts under a new identity into a staged chunk set (the active set is never modified). */
  reindex(params: ReindexParams, signal?: AbortSignal): Promise<ReindexResult>;
  /** Removes vectors from the remote vector store (a no-op in pgvector mode, where deleting the rows deletes the vectors). */
  deleteVectors(body: VectorDeleteRequest, signal?: AbortSignal): Promise<VectorDeleteResult>;
  vectorStatus(signal?: AbortSignal): Promise<VectorStatus>;
  chatStream(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
  generateStream(kind: GenerateKind, body: GenerateRequest, signal?: AbortSignal): AsyncGenerator<GenerateEvent>;
  analyzeResult(body: AnalyzeResultRequest, signal?: AbortSignal): Promise<AnalyzeResponse<RagAnalysisContent>>;
  analyzePlan(body: AnalyzePlanRequest, signal?: AbortSignal): Promise<AnalyzeResponse<RagPlanContent>>;
  ready(): Promise<boolean>;
}

type ErrorBody = { error?: { code?: string; message?: string; retryable?: boolean; retry_after_seconds?: number | null; reason?: string | null } };

async function toError(res: Response): Promise<RagAgentError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    /* non-JSON upstream error */
  }
  const e = body.error;
  if (res.status === 401) return new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service rejected this server's credentials.", false, null, 503);
  return new RagAgentError(
    e?.code ?? "PROVIDER_ERROR",
    redactString(e?.message ?? "The AI provider returned an error."),
    Boolean(e?.retryable),
    e?.retry_after_seconds ?? null,
    res.status,
    e?.reason ?? null,
  );
}

function unavailable(): RagAgentError {
  return new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service is unavailable right now. Please try again shortly.", true, null, 503);
}

async function* lines(stream: ReadableStream<Uint8Array>, delimiter: RegExp): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = delimiter.exec(buf))) {
        yield buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        delimiter.lastIndex = 0;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield buf;
  } finally {
    reader.releaseLock();
  }
}

export function parseSseBlock(block: string): ChatEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) } as ChatEvent;
  } catch {
    return null;
  }
}

export class HttpRagAgentClient implements RagAgentClient {
  private base = getEnv().RAG_AGENT_URL.replace(/\/$/, "");
  private token = getEnv().RAG_AGENT_TOKEN;
  private timeout = getEnv().RAG_AGENT_TIMEOUT_MS;

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async json<T>(path: string, init: RequestInit & { timeoutMs?: number }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? this.timeout) });
    } catch {
      throw unavailable();
    }
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }

  async providers() {
    return (await this.json<{ providers: ProviderCatalogEntry[] }>("/v1/providers", { headers: this.headers(), timeoutMs: 10_000 })).providers;
  }

  testProvider(provider: ProviderId, apiKey: string) {
    return this.json<TestResult>("/v1/providers/test", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ provider, api_key: apiKey }),
      timeoutMs: 25_000,
    });
  }

  listModels(provider: ProviderId, apiKey: string) {
    return this.json<ModelsResult>("/v1/providers/models", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ provider, api_key: apiKey }),
      timeoutMs: 30_000,
    });
  }

  publicModels(provider: ProviderId, kind: "chat" | "embedding") {
    return this.json<PublicModelsResult>(`/v1/providers/${encodeURIComponent(provider)}/public-models?kind=${kind}`, { headers: this.headers(), timeoutMs: 20_000 });
  }

  validateConfig(body: ValidateConfigRequest, signal?: AbortSignal) {
    return this.json<ValidateConfigResult>("/v1/providers/validate", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      timeoutMs: 75_000, // three checks, each bounded to 20 s by rag_agent
      ...(signal ? { signal } : {}),
    });
  }

  reindex(params: ReindexParams, signal?: AbortSignal) {
    return this.json<ReindexResult>("/v1/reindex", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(params),
      timeoutMs: this.timeout * 3, // a long document is embedded in many batches
      ...(signal ? { signal } : {}),
    });
  }

  deleteVectors(body: VectorDeleteRequest, signal?: AbortSignal) {
    return this.json<VectorDeleteResult>("/v1/vectors/delete", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      timeoutMs: 60_000, // a large document is removed in several remote calls
      ...(signal ? { signal } : {}),
    });
  }

  vectorStatus(signal?: AbortSignal) {
    return this.json<VectorStatus>("/v1/vectors/status", { headers: this.headers(), timeoutMs: 10_000, ...(signal ? { signal } : {}) });
  }

  async ingest(params: IngestParams, file: Uint8Array, onProgress: (stage: string, progress: number) => void, signal?: AbortSignal): Promise<IngestResult> {
    const form = new FormData();
    form.set("meta", JSON.stringify(params));
    form.set("file", new Blob([file as unknown as ArrayBuffer]), params.filename);
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/ingest`, { method: "POST", headers: this.headers(), body: form, signal: signal ?? AbortSignal.timeout(this.timeout * 3) });
    } catch {
      throw unavailable();
    }
    if (!res.ok || !res.body) throw await toError(res);
    let last: IngestResult | undefined;
    for await (const line of lines(res.body, /\r?\n/)) {
      if (!line.trim()) continue;
      let msg: { type: string; stage?: string; progress?: number } & Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "progress" && msg.stage && typeof msg.progress === "number") onProgress(msg.stage, msg.progress);
      else if (msg.type === "result" || msg.type === "error") last = msg as unknown as IngestResult;
    }
    if (!last) throw new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service ended the response early.", true, null, 503);
    return last;
  }

  async *chatStream(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/chat/stream`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json", accept: "text/event-stream", "x-request-id": body.request_id }),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw unavailable();
    }
    if (!res.ok || !res.body) throw await toError(res);
    for await (const block of lines(res.body, /\r?\n\r?\n/)) {
      const ev = parseSseBlock(block);
      if (ev) yield ev;
    }
  }

  async *generateStream(kind: GenerateKind, body: GenerateRequest, signal?: AbortSignal): AsyncGenerator<GenerateEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/generate/${kind}`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json", accept: "text/event-stream", "x-request-id": body.request_id }),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw unavailable();
    }
    if (!res.ok || !res.body) throw await toError(res);
    for await (const block of lines(res.body, /\r?\n\r?\n/)) {
      const ev = parseSseBlock(block) as unknown as GenerateEvent | null;
      if (ev) yield ev;
    }
  }

  analyzeResult(body: AnalyzeResultRequest, signal?: AbortSignal) {
    return this.json<AnalyzeResponse<RagAnalysisContent>>("/v1/analyze/result", {
      method: "POST", headers: this.headers({ "content-type": "application/json", "x-request-id": body.request_id }), body: JSON.stringify(body), signal, timeoutMs: 90_000,
    });
  }

  analyzePlan(body: AnalyzePlanRequest, signal?: AbortSignal) {
    return this.json<AnalyzeResponse<RagPlanContent>>("/v1/analyze/plan", {
      method: "POST", headers: this.headers({ "content-type": "application/json", "x-request-id": body.request_id }), body: JSON.stringify(body), signal, timeoutMs: 90_000,
    });
  }

  async ready() {
    try {
      const res = await fetch(`${this.base}/ready`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
