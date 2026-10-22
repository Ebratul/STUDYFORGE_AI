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

export type ModelsResult = { provider: ProviderId; fetched_at: string; models: ModelInfo[] };

export type Credentials = { provider: ProviderId; api_key: string; model: string };

export type ChatRequest = {
  request_id: string;
  user_id: string;
  mode: "GENERAL" | "DOCUMENT_ONLY";
  chat: Credentials & { params: { temperature?: number | null; top_p?: number | null; max_output_tokens?: number | null } };
  embedding: Credentials | null;
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

export type IngestParams = {
  document_id: string;
  owner_id: string;
  filename: string;
  mime_type: string;
  processing_version: number;
  embedding: Credentials;
};

export type IngestResult =
  | {
      type: "result";
      status: "READY" | "NEEDS_OCR" | "FAILED";
      page_count?: number | null;
      text_length?: number | null;
      chunk_count?: number | null;
      embedding_model?: string | null;
      code?: string | null;
      message?: string | null;
    }
  | { type: "error"; code: string; message: string; retryable?: boolean; retry_after_seconds?: number | null };

export class RagAgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds: number | null = null,
    public readonly httpStatus = 502,
  ) {
    super(message);
    this.name = "RagAgentError";
  }
}

export interface RagAgentClient {
  providers(): Promise<ProviderCatalogEntry[]>;
  testProvider(provider: ProviderId, apiKey: string): Promise<TestResult>;
  listModels(provider: ProviderId, apiKey: string): Promise<ModelsResult>;
  ingest(params: IngestParams, file: Uint8Array, onProgress: (stage: string, progress: number) => void, signal?: AbortSignal): Promise<IngestResult>;
  chatStream(body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent>;
  ready(): Promise<boolean>;
}

type ErrorBody = { error?: { code?: string; message?: string; retryable?: boolean; retry_after_seconds?: number | null } };

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

  async ready() {
    try {
      const res = await fetch(`${this.base}/ready`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
