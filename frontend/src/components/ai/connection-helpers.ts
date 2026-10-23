import { ApiError } from "@/lib/api";
import { describeProviderCode, MAX_EMBEDDING_DIMENSION, MIN_EMBEDDING_DIMENSION, type DimensionLimits, type DimensionSource, type EmbeddingChange, type ReindexView } from "@/lib/ai";
import { msg, type TFunction } from "@/lib/i18n/translate";

/** Pure helpers for the AI connection form (docs/AI_CONNECTION_SPEC.md). The server is the authority; these give instant feedback only. */

export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const KEY_RE = /^[\x21-\x7e]+$/;
export const KEY_MIN = 8;
export const KEY_MAX = 512;
export const MODEL_MAX = 200;
export const DEFAULT_DIMENSION_LIMITS: DimensionLimits = { min: MIN_EMBEDDING_DIMENSION, max: MAX_EMBEDDING_DIMENSION };

export const CHAT_EXAMPLE = "provider/model-name"; // a neutral shape, not a real model id
export const EMBEDDING_EXAMPLE = "openai/text-embedding-3-small";
export const DEFAULT_COST_NOTE = msg("Testing makes tiny requests with your key: one chat request, one more only if you set generation settings, and one embedding request. Free models cost nothing; paid models may charge a very small amount. Nothing is tested until you press a button.");

export type CheckName = "auth" | "chat" | "chatParams" | "embedding" | "dimension" | "database";
export type CheckResult = {
  ok: boolean | null;
  skipped?: boolean;
  code?: string;
  message?: string;
  latencyMs?: number;
  dimension?: number;
  /** Embedding check only: the model's own size, and the size that had to be requested to get `dimension` (null = nothing was requested). */
  nativeDimension?: number;
  requestDimensions?: number | null;
  /** Provider wire names of parameters that passed / were rejected. */
  verified?: string[];
  unsupported?: string[];
  /** Sanitised facts about a failed provider call (endpoint, HTTP status, short codes). Never bodies or keys. */
  diagnostics?: Record<string, string | number | boolean>;
};
export type Checks = Record<CheckName, CheckResult>;
export const CHECK_ORDER: CheckName[] = ["auth", "chat", "chatParams", "embedding", "dimension", "database"];

/** User-editable generation settings. Empty = "provider default" (the parameter is not sent at all). */
export type ParamKey = "temperature" | "topP" | "maxTokens" | "frequencyPenalty" | "presencePenalty" | "seed";
export type Params = Record<ParamKey, number | null>;
export const EMPTY_PARAMS: Params = { temperature: null, topP: null, maxTokens: null, frequencyPenalty: null, presencePenalty: null, seed: null };
export type ParamLimits = Record<ParamKey, { min: number; max: number }>;
export const DEFAULT_LIMITS: ParamLimits = {
  temperature: { min: 0, max: 2 }, topP: { min: 0, max: 1 }, maxTokens: { min: 1, max: 32768 },
  frequencyPenalty: { min: -2, max: 2 }, presencePenalty: { min: -2, max: 2 }, seed: { min: 0, max: 2147483647 },
};
/** Name each provider uses for the parameter in its published `supported_parameters`. */
export const PARAM_WIRE: Record<ParamKey, string> = {
  temperature: "temperature", topP: "top_p", maxTokens: "max_tokens", frequencyPenalty: "frequency_penalty", presencePenalty: "presence_penalty", seed: "seed",
};
export const PARAM_ORDER: ParamKey[] = ["temperature", "maxTokens", "topP", "frequencyPenalty", "presencePenalty", "seed"];
export const PARAM_INTEGER: Record<ParamKey, boolean> = { temperature: false, topP: false, maxTokens: true, frequencyPenalty: false, presencePenalty: false, seed: true };

/** Instant feedback for one settings field (the server re-checks everything). Blank is valid: it means "use the provider's default". */
export function validateParam(key: ParamKey, raw: string, limits: ParamLimits, t: TFunction): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) return t("Enter a number.");
  const n = Number(v);
  if (PARAM_INTEGER[key] && !Number.isInteger(n)) return t("Enter a whole number.");
  const { min, max } = limits[key];
  if (n < min || n > max) return t("Enter a value from {min} to {max}.", { min, max });
  return null;
}

export const paramsToInputs = (p: Params): Record<ParamKey, string> =>
  Object.fromEntries(PARAM_ORDER.map((k) => [k, p[k] === null ? "" : String(p[k])])) as Record<ParamKey, string>;

/** Blank -> null (clears the setting). Only call after `validateParam` passed for every field. */
export const inputsToParams = (v: Record<ParamKey, string>): Params =>
  Object.fromEntries(PARAM_ORDER.map((k) => [k, v[k].trim() === "" ? null : Number(v[k])])) as Params;

export const sameParams = (a: Params, b: Params) => PARAM_ORDER.every((k) => a[k] === b[k]);

/** One line of safe diagnostics for a failed check, e.g. "POST /embeddings · HTTP 400 · code 400 · Nvidia". */
export function diagnosticsLine(c: CheckResult, t: TFunction): string | null {
  const d = c.diagnostics;
  if (!d || c.ok !== false) return null;
  const parts: string[] = [];
  if (typeof d.endpoint === "string") parts.push(d.endpoint);
  if (typeof d.http_status === "number") parts.push(t("HTTP {status}", { status: d.http_status }));
  if (d.upstream_code !== undefined) parts.push(t("code {code}", { code: String(d.upstream_code) }));
  if (typeof d.upstream_provider === "string") parts.push(d.upstream_provider);
  if (d.wrapped_in_http_200 === true) parts.push(t("error inside an HTTP 200 reply"));
  if (d.failure === "timeout") parts.push(t("timed out"));
  if (d.failure === "connection") parts.push(t("connection failed"));
  return parts.length ? parts.join(" · ") : null;
}

export type Connection = {
  configured: boolean;
  provider: string | null;
  providerLabel: string | null;
  apiKey: { configured: boolean; masked: string | null; status: string | null };
  chatModelId: string | null;
  embeddingModelId: string | null;
  /** Size of the ACTIVE index (saved, measured). */
  embeddingDimension: number | null;
  /** Non-null: the model is asked for this size (shortened); null: its native size is used. */
  embeddingRequestDimensions: number | null;
  dimensionLimits: DimensionLimits;
  /** Deployment default (server env), used only for a configuration with no saved size. null = not set. */
  defaultEmbeddingDimension: number | null;
  /** A staged index being built, or one that failed. The active index serves searches meanwhile. */
  reindex: ReindexView | null;
  params: Params;
  paramLimits: ParamLimits;
  validatedAt: string | null;
  /** Chat and embedding were saved against different credentials (old settings UI): the form asks the user to save once more. */
  mixedProviders: boolean;
  documents: { ready: number; stale: number; processing: number };
  costNote: string;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Reads `GET /api/ai/connection` (wrapped or bare). Nothing secret can be in it; unknown fields are ignored. */
export function readConnection(raw: unknown): Connection | null {
  const root = isRec(raw) && isRec(raw.connection) ? raw.connection : raw;
  if (!isRec(root)) return null;
  const key = isRec(root.apiKey) ? root.apiKey : {};
  const docs = isRec(root.documents) ? root.documents : {};
  return {
    configured: root.configured === true,
    provider: str(root.provider),
    providerLabel: str(root.providerLabel),
    apiKey: { configured: key.configured === true, masked: str(key.masked), status: str(key.status) },
    chatModelId: str(root.chatModelId),
    embeddingModelId: str(root.embeddingModelId),
    embeddingDimension: typeof root.embeddingDimension === "number" ? root.embeddingDimension : null,
    embeddingRequestDimensions: typeof root.embeddingRequestDimensions === "number" ? root.embeddingRequestDimensions : null,
    dimensionLimits: readDimensionLimits(root.dimensionLimits),
    defaultEmbeddingDimension: int(root.defaultEmbeddingDimension) || null,
    reindex: readReindex(root.reindex),
    params: readParams(root.params),
    paramLimits: readLimits(root.paramLimits),
    validatedAt: str(root.validatedAt),
    mixedProviders: root.mixedProviders === true,
    documents: { ready: int(docs.ready), stale: int(docs.stale), processing: int(docs.processing) },
    costNote: DEFAULT_COST_NOTE, // our own catalog message; the server's English copy would never be translated
  };
}

function readDimensionLimits(raw: unknown): DimensionLimits {
  const r = isRec(raw) ? raw : {};
  const min = int(r.min) || DEFAULT_DIMENSION_LIMITS.min;
  const max = int(r.max) || DEFAULT_DIMENSION_LIMITS.max;
  return min <= max ? { min, max } : DEFAULT_DIMENSION_LIMITS;
}

/** Reads the staged-index state defensively; anything that isn't a BUILDING/FAILED build with a model and size is "no build". */
export function readReindex(raw: unknown): ReindexView | null {
  if (!isRec(raw)) return null;
  const status = raw.status === "BUILDING" || raw.status === "FAILED" ? raw.status : null;
  const id = str(raw.id);
  const modelId = str(raw.modelId);
  const dimension = int(raw.dimension);
  if (!status || !id || !modelId || !dimension) return null;
  const p = isRec(raw.progress) ? raw.progress : {};
  const total = int(p.total);
  return {
    id, status, provider: str(raw.provider) ?? "", modelId, dimension,
    progress: { total, done: Math.min(int(p.done), total) },
    errorCode: str(raw.errorCode), errorMessage: str(raw.errorMessage), createdAt: str(raw.createdAt),
  };
}

/** `connection.embeddingChange` of a successful save; anything unexpected reads as "unchanged" (no claim is made). */
export function readEmbeddingChange(raw: unknown): EmbeddingChange {
  const r = isRec(raw) && isRec(raw.embeddingChange) ? raw.embeddingChange : {};
  const status = r.status === "activated" || r.status === "reindexing" ? r.status : "unchanged";
  return { status, documents: int(r.documents) };
}

export type DimensionInfo = { measured: number | null; native: number | null; requested: number | null; source: DimensionSource | null };

/** The dimension facts of a `POST /api/ai/connection/test` reply (nulls when the server didn't say). */
export function readDimensionInfo(raw: unknown): DimensionInfo {
  const r = isRec(raw) ? raw : {};
  const source = r.dimensionSource === "request" || r.dimensionSource === "database" || r.dimensionSource === "environment" || r.dimensionSource === "model" ? r.dimensionSource : null;
  return { measured: int(r.measuredDimension) || null, native: int(r.nativeDimension) || null, requested: int(r.requestedDimension) || null, source };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
function readParams(raw: unknown): Params {
  if (!isRec(raw)) return EMPTY_PARAMS;
  return Object.fromEntries(PARAM_ORDER.map((k) => [k, num(raw[k])])) as Params;
}
function readLimits(raw: unknown): ParamLimits {
  if (!isRec(raw)) return DEFAULT_LIMITS;
  return Object.fromEntries(PARAM_ORDER.map((k) => {
    const r = isRec(raw[k]) ? raw[k] : {};
    return [k, { min: num(r.min) ?? DEFAULT_LIMITS[k].min, max: num(r.max) ?? DEFAULT_LIMITS[k].max }];
  })) as ParamLimits;
}
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : undefined);
function readDiagnostics(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRec(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = x;
  return Object.keys(out).length ? out : undefined;
}

function readCheck(raw: unknown): CheckResult {
  if (!isRec(raw)) return { ok: null, skipped: true };
  return {
    ok: typeof raw.ok === "boolean" ? raw.ok : null,
    ...(raw.skipped === true || raw.ok === null || raw.ok === undefined ? { skipped: true } : {}),
    ...(str(raw.code) ? { code: str(raw.code)! } : {}),
    ...(str(raw.message) ? { message: str(raw.message)! } : {}),
    ...(typeof raw.latency_ms === "number" ? { latencyMs: raw.latency_ms } : typeof raw.latencyMs === "number" ? { latencyMs: raw.latencyMs } : {}),
    ...(typeof raw.dimension === "number" ? { dimension: raw.dimension } : {}),
    ...(typeof raw.native_dimension === "number" ? { nativeDimension: raw.native_dimension } : typeof raw.nativeDimension === "number" ? { nativeDimension: raw.nativeDimension } : {}),
    ...(raw.request_dimensions === null || typeof raw.request_dimensions === "number" ? { requestDimensions: raw.request_dimensions as number | null } : {}),
    ...(strings(raw.verified) ? { verified: strings(raw.verified)! } : {}),
    ...(strings(raw.unsupported) ? { unsupported: strings(raw.unsupported)! } : {}),
    ...(readDiagnostics(raw.diagnostics) ? { diagnostics: readDiagnostics(raw.diagnostics)! } : {}),
  };
}

export function readChecks(raw: unknown): Checks | null {
  if (!isRec(raw)) return null;
  return Object.fromEntries(CHECK_ORDER.map((k) => [k, readCheck(raw[k])])) as Checks;
}

export type ModelIdMessages = { empty: string; format: string; long: string };

export function validateModelId(raw: string, t: TFunction): string | null {
  const v = raw.trim();
  if (!v) return t("Enter a model ID.");
  if (v.length > MODEL_MAX) return t("Model IDs can be up to {max} characters.", { max: MODEL_MAX });
  if (!MODEL_ID_RE.test(v)) return t("Model IDs contain letters, digits and . _ : / @ + - only.");
  return null;
}

export function validateApiKey(raw: string, hasSavedKey: boolean, t: TFunction): string | null {
  const v = raw.trim();
  if (!v) return hasSavedKey ? null : t("Enter your API key.");
  if (v.length < KEY_MIN) return t("That key looks too short.");
  if (v.length > KEY_MAX) return t("That key looks too long.");
  if (!KEY_RE.test(v)) return t("API keys contain no spaces or special characters.");
  return null;
}

/**
 * Instant feedback for the embedding dimension field. Blank is valid: it means "Automatic" (deployment default, else the model's own
 * size). The server re-checks the range and, above all, verifies with a live request that the model really returns this size.
 */
export function validateDimension(raw: string, limits: DimensionLimits, t: TFunction): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (!/^-?\d+(\.\d+)?$/.test(v)) return t("Enter a number.");
  const n = Number(v);
  if (!Number.isInteger(n)) return t("Enter a whole number.");
  if (n < limits.min || n > limits.max) return t("Enter a value from {min} to {max}.", { min: limits.min, max: limits.max });
  return null;
}

/**
 * What the dimension field sends (docs/EMBEDDING_SETTINGS_SPEC.md §2): a number when the user entered one, `null` when they cleared the
 * field ("Automatic"), and nothing at all when they never touched it, so the server keeps the saved size for an unchanged model.
 * Only call after `validateDimension` passed.
 */
export function dimensionPayload(raw: string, touched: boolean): { embeddingDimension?: number | null } {
  if (!touched) return {};
  const v = raw.trim();
  return { embeddingDimension: v === "" ? null : Number(v) };
}

/**
 * The text the dimension field shows. An untouched field mirrors what the server will do: the saved size while the embedding model is
 * the saved one, blank ("Automatic") for any other model, so the field never claims a size that won't be used.
 */
export function shownDimension(typed: string, touched: boolean, savedDimension: number | null, modelId: string, savedModelId: string | null): string {
  if (touched) return typed;
  return savedDimension !== null && savedModelId !== null && modelId.trim() === savedModelId ? String(savedDimension) : "";
}

/**
 * What size the server will try for this form state (the §2 table of docs/EMBEDDING_SETTINGS_SPEC.md), used to word a failed save when
 * the server sent no test details. Display only: the server decides.
 */
export function inferRequest(shown: string, touched: boolean, sameModel: boolean, savedDimension: number | null, defaultDimension: number | null): { requested: number | null; source: DimensionSource } {
  const v = shown.trim();
  if (touched && v !== "") return { requested: Number(v), source: "request" };
  if (!touched && sameModel && savedDimension !== null) return { requested: savedDimension, source: "database" };
  return defaultDimension !== null ? { requested: defaultDimension, source: "environment" } : { requested: null, source: "model" };
}

/** Display-only guess of which provider a typed key belongs to. The server derives the real provider; unknown keys default to OpenRouter. */
export function previewProvider(key: string): { id: string; label: string } | null {
  const k = key.trim();
  if (!k) return null;
  if (k.startsWith("sk-or-")) return { id: "openrouter", label: "OpenRouter" };
  if (k.startsWith("gsk_")) return { id: "groq", label: "Groq" };
  if (k.startsWith("sk-")) return { id: "openai", label: "OpenAI" };
  if (k.startsWith("mock-")) return { id: "mock", label: "Mock (testing only)" };
  return { id: "openrouter", label: "OpenRouter" };
}

/** The request body: a blank key is omitted so the saved key is kept; models are trimmed. */
export function buildBody(v: { apiKey: string; chatModelId: string; embeddingModelId: string; params?: Params; embeddingDimension?: number | null }): { apiKey?: string; chatModelId: string; embeddingModelId: string; params?: Params; embeddingDimension?: number | null } {
  const apiKey = v.apiKey.trim();
  return {
    ...(apiKey ? { apiKey } : {}), chatModelId: v.chatModelId.trim(), embeddingModelId: v.embeddingModelId.trim(), ...(v.params ? { params: v.params } : {}),
    // undefined = untouched (omitted); null = Automatic; a number = that size
    ...(v.embeddingDimension !== undefined ? { embeddingDimension: v.embeddingDimension } : {}),
  };
}

const DIMENSION_CODES = new Set(["EMBEDDING_DIMENSION_MISMATCH", "EMBEDDING_DIMENSION_UNSUPPORTED"]);

/** Explains a refused vector size truthfully: what was asked for (and where that came from), what the model did, what it can do. */
function dimensionFailure(c: CheckResult, t: TFunction, info: DimensionInfo | undefined): string {
  const requested = info?.requested ?? null;
  const returned = c.dimension ?? info?.measured ?? null;
  const native = c.nativeDimension ?? info?.native ?? null;
  const nativeNote = native ? ` ${t("Its native size is {n}.", { n: native })}` : "";
  const never = ` ${t("Vectors are never padded or truncated.")}`;
  const fromDefault = info?.source === "environment" && requested !== null;
  if (c.code === "EMBEDDING_DIMENSION_UNSUPPORTED") {
    if (fromDefault) return t("The deployment default ({requested}) is not supported by this model: the provider refused that size.", { requested }) + nativeNote + never;
    return (requested !== null ? t("The provider refused the vector size {requested} for this model.", { requested }) : t("The provider refused the requested vector size for this model.")) + nativeNote + never;
  }
  if (fromDefault) {
    return (returned ? t("The deployment default ({requested}) is not supported by this model: it returned {n}-dimensional vectors.", { requested, n: returned }) : t("The deployment default ({requested}) is not supported by this model.", { requested })) + nativeNote + never;
  }
  if (requested !== null && returned) return t("This model returned {n}-dimensional vectors when {requested} were requested, so it doesn't support that size.", { n: returned, requested }) + nativeNote + never;
  if (returned) return t("This model returned {n}-dimensional vectors, not the size you asked for.", { n: returned }) + nativeNote + never;
  return describeProviderCode(c.code, t);
}

/** What a passing vector-size check proves, in plain words. */
function dimensionOk(n: number, t: TFunction, info: DimensionInfo | undefined): string {
  const native = info?.native ?? null;
  if (native !== null && native !== n) return t("{n} dimensions. This model returns {native} natively; {n} was verified with a live request.", { n, native });
  if (native !== null) return t("{n} dimensions, this model's own size.", { n });
  return t("{n} dimensions, as configured", { n });
}

/** Text for one check row. Server messages are already safe; codes map to our own wording when the server sent none. */
export function checkMessage(name: CheckName, c: CheckResult, t: TFunction, info?: DimensionInfo): string {
  if (c.skipped || c.ok === null) return name === "chatParams" && c.message ? t("Nothing to test — no custom settings are set, so the provider's defaults are used.") : t("Skipped");
  if (c.ok) {
    if (name === "dimension" && c.dimension) return dimensionOk(c.dimension, t, info);
    if (name === "database" && c.dimension) return t("The database can store {n}-dimensional vectors", { n: c.dimension });
    if (name === "chatParams" && c.verified?.length) return t("Accepted: {list}", { list: c.verified.join(", ") });
    return t("Works");
  }
  if (name === "database") return c.message || describeProviderCode(c.code ?? "DB_VECTOR_UNAVAILABLE", t);
  if (c.code && DIMENSION_CODES.has(c.code)) return dimensionFailure(c, t, info);
  if (name === "chatParams" && c.code === "PARAMETER_UNSUPPORTED" && c.unsupported?.length) return t("This model doesn't accept: {list}. Clear those settings or choose another model.", { list: c.unsupported.join(", ") });
  return c.message || describeProviderCode(c.code, t);
}

export type SaveFeedback = { message: string; checks: Checks | null; fields: Partial<Record<"apiKey" | "chatModelId" | "embeddingModelId" | "embeddingDimension" | "params", string>> };

const FIELD_KEYS = ["apiKey", "chatModelId", "embeddingModelId", "embeddingDimension", "params"] as const;

/** Polling cadence for the connection while a staged index is being built or documents are processing. */
export const RECONNECT_POLL_MS = 3000;
/**
 * Refetch cadence of the connection query: only documents that are still processing. While a staged index is BUILDING the
 * <EmbeddingReindexPanel/> polls instead (one poller, never two), and nothing polls once it is done.
 */
export const connectionPollInterval = (c: Connection | undefined): number | false => (c && c.reindex?.status !== "BUILDING" && c.documents.processing > 0 ? RECONNECT_POLL_MS : false);

/** Maps a failed `PUT /api/ai/connection` to what the form shows. Never includes anything the server didn't mark safe. */
export function feedbackFromError(err: unknown, t: TFunction): SaveFeedback {
  if (!(err instanceof ApiError)) return { message: t("Something went wrong. Please try again."), checks: null, fields: {} };
  const checks = readChecks(err.details?.checks);
  const fields: SaveFeedback["fields"] = {};
  for (const k of FIELD_KEYS) if (typeof err.fields[k] === "string") fields[k] = err.fields[k];
  switch (err.code) {
    case "AI_CONFIG_INVALID":
      return { message: t("The provider didn't accept this configuration, so nothing was saved. Your previous settings are unchanged."), checks, fields };
    case "RATE_LIMITED":
      return { message: t("Too many attempts. Wait a minute, then try again."), checks: null, fields };
    case "UPSTREAM_UNAVAILABLE":
      if (err.details?.providerCode === "AI_SERVICE_OUTDATED") return { message: t("The AI service is out of date or needs a restart (rag_agent didn't recognise this request). Restart it and try again. Nothing was saved."), checks: null, fields };
      return { message: t("The AI service is unavailable right now. Nothing was saved. Please try again shortly."), checks: null, fields };
    case "VALIDATION":
      return { message: t("Please fix the highlighted fields."), checks: null, fields };
    case "PROVIDER_ERROR":
      return { message: describeProviderCode(typeof err.details?.providerCode === "string" ? err.details.providerCode : null, t), checks: null, fields };
    default:
      return { message: err.message || t("Something went wrong. Please try again."), checks, fields };
  }
}
