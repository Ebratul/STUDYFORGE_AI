import type {
  AnalyzePlanRequest, AnalyzeResponse, AnalyzeResultRequest, ChatEvent, ChatRequest, GenerateEvent, ValidateConfigRequest, ValidateConfigResult, GenerateKind, GenerateRequest, IngestParams, IngestResult, ModelsResult, ProviderCatalogEntry, ProviderId, RagAgentClient, RagAnalysisContent, RagPlanContent, TestResult,
} from "../../src/clients/rag-agent.js";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { defaultAnalyzePlan, defaultAnalyzeResult } from "./fake-analysis.js";
import { defaultGenerateScript } from "./fake-generation.js";

export const CATALOG: ProviderCatalogEntry[] = [
  { id: "openai", name: "OpenAI", capabilities: { chat: true, embeddings: true, streaming: true, structured_output: "model-dependent" } },
  { id: "openrouter", name: "OpenRouter", capabilities: { chat: true, embeddings: true, streaming: true, structured_output: "model-dependent" } },
  { id: "groq", name: "Groq", capabilities: { chat: true, embeddings: false, streaming: true, structured_output: "model-dependent" } },
  { id: "mock", name: "Mock (testing only)", capabilities: { chat: true, embeddings: true, streaming: true, structured_output: "yes" } },
];

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
      return { ok: false, provider: req.provider, embedding_dimension: null, checks: { auth: { ok: false, code: "PROVIDER_AUTH_INVALID", message: "The AI provider rejected the API key. Check that the key is valid and has access." }, chat: skipped, embedding: skipped } };
    }
    const chat = req.chat_model.startsWith("bad-chat") ? { ok: false, code: "MODEL_NOT_FOUND", message: "The selected model was not found or is not available for this key." } : { ok: true, latency_ms: 20 };
    const wide = req.embedding_model.startsWith("wide-embed");
    const embedding = req.embedding_model.startsWith("bad-embed")
      ? { ok: false, code: "MODEL_NOT_FOUND", message: "The selected model was not found or is not available for this key." }
      : wide
        ? { ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", message: "This model produces 3072-dimensional vectors; StudyForge stores 1536.", dimension: 3072 }
        : { ok: true, latency_ms: 30, dimension: 1536 };
    return { ok: chat.ok && embedding.ok, provider: req.provider, embedding_dimension: wide ? 3072 : embedding.ok ? 1536 : null, checks: { auth: { ok: true, latency_ms: 10 }, chat, embedding } };
  };
  generateCalls: { kind: GenerateKind; body: GenerateRequest }[] = [];
  ingestCalls: { params: IngestParams; bytes: number }[] = [];
  modelCalls = 0;

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
    return { type: "result", status: "READY", page_count: 2, text_length: 1000, chunk_count: 3, embedding_model: "mock-embed", code: null, message: null };
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
  async validateConfig(body: ValidateConfigRequest): Promise<ValidateConfigResult> {
    this.validateCalls.push(body);
    if (this.validateError) throw this.validateError;
    return this.validateScript(body);
  }
  async ingest(params: IngestParams, file: Uint8Array, onProgress: (s: string, p: number) => void) {
    this.ingestCalls.push({ params, bytes: file.byteLength });
    return this.ingestScript(params, onProgress);
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
