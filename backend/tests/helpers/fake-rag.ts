import type {
  AnalyzePlanRequest, AnalyzeResponse, AnalyzeResultRequest, ChatEvent, ChatRequest, GenerateEvent, ValidateConfigRequest, ValidateConfigResult, GenerateKind, GenerateRequest, IngestParams, IngestResult, ModelsResult, ProviderCatalogEntry, ProviderId, PublicModelsResult, RagAgentClient, RagAnalysisContent, RagPlanContent, TestResult,
} from "../../src/clients/rag-agent.js";
import type { ReindexParams, ReindexResult, ValidationCheck, VectorDeleteRequest, VectorDeleteResult, VectorStatus } from "../../src/clients/rag-agent.js";
import { getEnv } from "../../src/config/env.js";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { db } from "../../src/lib/db.js";
import { defaultAnalyzePlan, defaultAnalyzeResult } from "./fake-analysis.js";
import { defaultGenerateScript } from "./fake-generation.js";

export const CATALOG: ProviderCatalogEntry[] = [
  { id: "openai", name: "OpenAI", capabilities: { chat: true, embeddings: true, streaming: true, structured_output: "model-dependent" } },
  { id: "openrouter", name: "OpenRouter", capabilities: { chat: true, embeddings: true, streaming: true, structured_output: "model-dependent" } },
  { id: "groq", name: "Groq", capabilities: { chat: true, embeddings: false, streaming: true, structured_output: "model-dependent" } },
  { id: "mock", name: "Mock (testing only)", capabilities: { chat: true, embeddings: true, streaming: true, structured_output: "yes" } },
];

/** The vector size a fake embedding model returns when asked for nothing: `…-<N>` ends in its size, `wide-embed*` is 3072, the rest 1536. */
export function nativeDimension(model: string): number {
  if (model.startsWith("wide-embed")) return 3072;
  const m = /-(\d{2,4})$/.exec(model);
  return m ? Number(m[1]) : 1536;
}

/**
 * What the real service would report for the embedding model (docs/EMBEDDING_SETTINGS_SPEC.md §3):
 *  - `bad-embed*`    unknown model
 *  - `flex-embed*`   Matryoshka-style: honours a smaller `dimensions`
 *  - `strict-embed*` provider rejects the `dimensions` parameter
 *  - anything else   ignores `dimensions` and returns its native size
 */
export function embeddingCheck(model: string, requested?: number): ValidationCheck {
  if (model.startsWith("bad-embed")) return { ok: false, code: "MODEL_NOT_FOUND", message: "The selected model was not found or is not available for this key." };
  const native = nativeDimension(model);
  if (requested === undefined || requested === native) return { ok: true, latency_ms: 30, dimension: native, native_dimension: native };
  if (model.startsWith("flex-embed") && requested < native) return { ok: true, latency_ms: 40, dimension: requested, native_dimension: native, request_dimensions: requested };
  if (model.startsWith("strict-embed")) return { ok: false, code: "EMBEDDING_DIMENSION_UNSUPPORTED", message: "The provider rejected the requested size.", native_dimension: native };
  return { ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", message: "The model returned another size.", dimension: native, native_dimension: native };
}

/** Like rag_agent's /v1/reindex: copies the document's active chunk texts into the target identity (one-hot vectors of the target length). */
export async function defaultReindex(p: ReindexParams): Promise<ReindexResult> {
  const vec = `[${Array.from({ length: p.target.dimension }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  await db.$executeRaw`DELETE FROM "DocumentChunk" WHERE "documentId" = ${p.document_id} AND "processingVersion" = ${p.processing_version}
    AND "embeddingProvider" = ${p.target.provider} AND "embeddingModel" = ${p.target.model} AND "embeddingDimension" = ${p.target.dimension}`;
  const n = await db.$executeRaw`
    INSERT INTO "DocumentChunk" ("id","documentId","ownerId","chunkIndex","processingVersion","page","section","content","tokenCount","embeddingProvider","embeddingModel","metadata","embedding")
    SELECT gen_random_uuid()::text, "documentId", "ownerId", "chunkIndex", "processingVersion", "page", "section", "content", "tokenCount", ${p.target.provider}, ${p.target.model}, "metadata", ${vec}::vector
    FROM "DocumentChunk"
    WHERE "documentId" = ${p.document_id} AND "ownerId" = ${p.owner_id} AND "processingVersion" = ${p.processing_version}
      AND "embeddingProvider" = ${p.source.provider} AND "embeddingModel" = ${p.source.model} AND "embeddingDimension" = ${p.source.dimension}`;
  return n === 0 ? { type: "result", status: "STALE", chunk_count: 0, embedding_dimension: null } : { type: "result", status: "READY", chunk_count: n, embedding_dimension: p.target.dimension };
}

/** Scriptable stand-in for the rag_agent service. Records every call so tests can assert what was (not) sent. */
export class FakeRag implements RagAgentClient {
  testCalls: { provider: ProviderId; apiKey: string }[] = [];
  chatCalls: ChatRequest[] = [];
  /** Every connection validation the backend asked for (so tests can assert the exact model ids and key hand-off). */
  validateCalls: ValidateConfigRequest[] = [];
  validateError: Error | null = null;
  /** Default: auth ok for `validKeys`; chat model `bad-chat*` → MODEL_NOT_FOUND; embedding `bad-embed*` → MODEL_NOT_FOUND, `wide-embed*` → 3072-d mismatch. */
  validateScript: (req: ValidateConfigRequest) => ValidateConfigResult = (req) => {
    const skipped = { ok: null, skipped: true } as const;
    if (!this.validKeys.has(req.api_key)) {
      return { ok: false, provider: req.provider, embedding_dimension: null, checks: { auth: { ok: false, code: "PROVIDER_AUTH_INVALID", message: "The AI provider rejected the API key. Check that the key is valid and has access." }, chat: skipped, chat_params: skipped, embedding: skipped } };
    }
    const chat = req.chat_model.startsWith("bad-chat") ? { ok: false, code: "MODEL_NOT_FOUND", message: "The selected model was not found or is not available for this key." } : { ok: true, latency_ms: 20 };
    // Models named `limited-chat*` list no penalty parameters (like many real free models); the rest accept every parameter.
    const wanted = Object.keys(req.chat_params ?? {}).filter((k) => req.chat_params![k as keyof typeof req.chat_params] != null);
    const unsupported = req.chat_model.startsWith("limited-chat") ? wanted.filter((k) => k === "frequency_penalty" || k === "presence_penalty") : [];
    const chat_params = !chat.ok
      ? skipped
      : wanted.length === 0
        ? { ok: null, skipped: true, message: "No custom parameters are set, so the provider's defaults are used." }
        : unsupported.length
          ? { ok: false, code: "PARAMETER_UNSUPPORTED", message: `The provider's model listing does not include support for: ${unsupported.join(", ")}. Clear those settings or choose another model.`, unsupported }
          : { ok: true, latency_ms: 25, verified: wanted.map((k) => (k === "max_output_tokens" ? "max_tokens" : k)).sort() };
    const embedding = embeddingCheck(req.embedding_model, req.embedding_dimension);
    return { ok: chat.ok && embedding.ok === true && chat_params.ok !== false, provider: req.provider, embedding_dimension: embedding.ok ? embedding.dimension! : null, checks: { auth: { ok: true, latency_ms: 10 }, chat, chat_params, embedding } };
  };
  publicModelCalls: { provider: ProviderId; kind: string }[] = [];
  publicModelsScript: (provider: ProviderId, kind: "chat" | "embedding") => PublicModelsResult = (provider, kind) => ({
    provider, kind, available: provider === "openrouter" || provider === "mock", fetched_at: new Date().toISOString(),
    models: provider !== "openrouter" && provider !== "mock"
      ? []
      : kind === "chat"
      ? [
          { id: "acme/free-chat:free", name: "Acme Free Chat", context_length: 32768, free: true, supported_parameters: ["max_tokens", "seed", "temperature", "top_p"] },
          { id: "acme/paid-chat", name: "Acme Paid Chat", context_length: 128000, free: false, supported_parameters: ["frequency_penalty", "max_tokens", "presence_penalty", "seed", "temperature", "top_p"] },
          { id: "acme/unknown-chat", name: "Acme Unknown", context_length: null, free: false, supported_parameters: null },
        ]
      : [{ id: "acme/embed-small", name: "Acme Embed", context_length: 8192, free: true, supported_parameters: null }],
  });
  generateCalls: { kind: GenerateKind; body: GenerateRequest }[] = [];
  ingestCalls: { params: IngestParams; bytes: number }[] = [];
  reindexCalls: ReindexParams[] = [];
  /** Default writes the staged chunk set into the database exactly like rag_agent does; tests override it to fail or to sabotage the result. */
  reindexScript: (p: ReindexParams, signal?: AbortSignal) => Promise<ReindexResult> = defaultReindex;
  modelCalls = 0;
  /** Every /v1/vectors/delete the backend asked for. The default answers like rag_agent: `noop` in pgvector mode, `ok` otherwise. */
  deleteVectorCalls: VectorDeleteRequest[] = [];
  deleteVectorsScript: (req: VectorDeleteRequest, signal?: AbortSignal) => Promise<VectorDeleteResult> = async () => {
    const mode = getEnv().VECTOR_STORE;
    return { status: mode === "pgvector" ? "noop" : "ok", mode, deleted: 0 };
  };
  /** What rag_agent would report about its vector store: the same mode as this process, and (remote modes) one 1536-d index. */
  vectorStatusScript: () => Promise<VectorStatus> = async () => {
    const mode = getEnv().VECTOR_STORE;
    return { mode, dimensions: mode === "pgvector" ? null : [1536] };
  };

  validKeys = new Set(["mock-valid-key"]);
  chatScript: (req: ChatRequest, signal?: AbortSignal) => AsyncGenerator<ChatEvent> = async function* (req) {
    yield { event: "meta", data: { mode: req.mode, provider: req.chat.provider, model: req.chat.model, documents_considered: req.document_ids.length, retrieval: "skipped" } };
    yield { event: "delta", data: { text: "Hello " } };
    yield { event: "delta", data: { text: "world" } };
    yield { event: "final", data: { content: "Hello world", fallback: false, insufficient_evidence: false, finish_reason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5 } } };
  };
  ingestScript: (params: IngestParams, onProgress: (s: string, p: number) => void) => Promise<IngestResult> = async (_p, onProgress) => {
    onProgress("extract", 15);
    onProgress("embed", 70);
    return { type: "result", status: "READY", page_count: 2, text_length: 1000, chunk_count: 3, embedding_model: "mock-embed", embedding_dimension: 1536, code: null, message: null };
  };
  available = true;

  async providers() {
    if (!this.available) throw new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service is unavailable right now.", true, null, 503);
    return CATALOG;
  }
  async testProvider(provider: ProviderId, apiKey: string): Promise<TestResult> {
    this.testCalls.push({ provider, apiKey });
    return this.validKeys.has(apiKey) ? { ok: true, latency_ms: 12, models_count: 2 } : { ok: false, code: "PROVIDER_AUTH_INVALID", message: "The provider rejected this API key.", retryable: false };
  }
  async listModels(provider: ProviderId): Promise<ModelsResult> {
    this.modelCalls++;
    return {
      provider,
      fetched_at: new Date().toISOString(),
      models: [
        { id: "mock-chat", capabilities: { chat: true, embeddings: false, streaming: true, structured_output: "yes", tools: "unknown" }, capability_source: "catalogue" },
        { id: "mock-embed", capabilities: { chat: false, embeddings: true, streaming: false, structured_output: "no", tools: "no" }, capability_source: "catalogue" },
      ],
    };
  }
  async publicModels(provider: ProviderId, kind: "chat" | "embedding") {
    this.publicModelCalls.push({ provider, kind });
    return this.publicModelsScript(provider, kind);
  }
  async validateConfig(body: ValidateConfigRequest): Promise<ValidateConfigResult> {
    this.validateCalls.push(body);
    if (this.validateError) throw this.validateError;
    return this.validateScript(body);
  }
  async ingest(params: IngestParams, file: Uint8Array, onProgress: (s: string, p: number) => void) {
    this.ingestCalls.push({ params, bytes: file.byteLength });
    return this.ingestScript(params, onProgress);
  }
  async reindex(params: ReindexParams, signal?: AbortSignal) {
    this.reindexCalls.push(params);
    return this.reindexScript(params, signal);
  }
  async deleteVectors(body: VectorDeleteRequest, signal?: AbortSignal) {
    this.deleteVectorCalls.push(body);
    return this.deleteVectorsScript(body, signal);
  }
  vectorStatusCalls = 0;
  async vectorStatus() {
    this.vectorStatusCalls++;
    return this.vectorStatusScript();
  }
  chatStream(body: ChatRequest, signal?: AbortSignal) {
    this.chatCalls.push(body);
    return this.chatScript(body, signal);
  }
  /** Default script: a deterministic result built from the request (see tests/helpers/fake-generation.ts). */
  generateScript: (kind: GenerateKind, req: GenerateRequest, signal?: AbortSignal) => AsyncGenerator<GenerateEvent> = defaultGenerateScript;
  generateStream(kind: GenerateKind, body: GenerateRequest, signal?: AbortSignal) {
    this.generateCalls.push({ kind, body });
    return this.generateScript(kind, body, signal);
  }
  analyzeCalls: AnalyzeResultRequest[] = [];
  analyzePlanCalls: AnalyzePlanRequest[] = [];
  /** Scripts may return a response or throw (e.g. a RagAgentError) to simulate provider failures. */
  analyzeResultScript: (req: AnalyzeResultRequest, signal?: AbortSignal) => Promise<AnalyzeResponse<RagAnalysisContent>> = async (req) => defaultAnalyzeResult(req);
  analyzePlanScript: (req: AnalyzePlanRequest, signal?: AbortSignal) => Promise<AnalyzeResponse<RagPlanContent>> = async (req) => defaultAnalyzePlan(req);
  async analyzeResult(body: AnalyzeResultRequest, signal?: AbortSignal) {
    this.analyzeCalls.push(body);
    return this.analyzeResultScript(body, signal);
  }
  async analyzePlan(body: AnalyzePlanRequest, signal?: AbortSignal) {
    this.analyzePlanCalls.push(body);
    return this.analyzePlanScript(body, signal);
  }
  async ready() {
    return this.available;
  }
}
