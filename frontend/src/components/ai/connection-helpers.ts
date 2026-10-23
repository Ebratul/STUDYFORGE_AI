import { ApiError } from "@/lib/api";
import { describeProviderCode } from "@/lib/ai";
import { msg, type TFunction } from "@/lib/i18n/translate";

/** Pure helpers for the AI connection form (docs/AI_CONNECTION_SPEC.md). The server is the authority; these give instant feedback only. */

export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const KEY_RE = /^[\x21-\x7e]+$/;
export const KEY_MIN = 8;
export const KEY_MAX = 512;
export const MODEL_MAX = 200;
export const DEFAULT_EXPECTED_DIMENSION = 1536;

export const CHAT_EXAMPLE = "provider/model-name"; // a neutral shape, not a real model id
export const EMBEDDING_EXAMPLE = "openai/text-embedding-3-small";
export const DEFAULT_COST_NOTE = msg("Saving makes two tiny paid requests (one chat, one embedding) with your key, so your provider may charge a very small amount.");

export type CheckName = "auth" | "chat" | "embedding";
export type CheckResult = { ok: boolean | null; skipped?: boolean; code?: string; message?: string; latencyMs?: number; dimension?: number };
export type Checks = Record<CheckName, CheckResult>;
export const CHECK_ORDER: CheckName[] = ["auth", "chat", "embedding"];

export type Connection = {
  configured: boolean;
  provider: string | null;
  providerLabel: string | null;
  apiKey: { configured: boolean; masked: string | null; status: string | null };
  chatModelId: string | null;
  embeddingModelId: string | null;
  embeddingDimension: number | null;
  expectedDimension: number;
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
    expectedDimension: int(root.expectedDimension) || DEFAULT_EXPECTED_DIMENSION,
    validatedAt: str(root.validatedAt),
    mixedProviders: root.mixedProviders === true,
    documents: { ready: int(docs.ready), stale: int(docs.stale), processing: int(docs.processing) },
    costNote: DEFAULT_COST_NOTE, // our own catalog message; the server's English copy would never be translated
  };
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
  };
}

export function readChecks(raw: unknown): Checks | null {
  if (!isRec(raw)) return null;
  return { auth: readCheck(raw.auth), chat: readCheck(raw.chat), embedding: readCheck(raw.embedding) };
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
export function buildBody(v: { apiKey: string; chatModelId: string; embeddingModelId: string }): { apiKey?: string; chatModelId: string; embeddingModelId: string } {
  const apiKey = v.apiKey.trim();
  return { ...(apiKey ? { apiKey } : {}), chatModelId: v.chatModelId.trim(), embeddingModelId: v.embeddingModelId.trim() };
}

/** Text for one check row. Server messages are already safe; codes map to our own wording when the server sent none. */
export function checkMessage(name: CheckName, c: CheckResult, t: TFunction, expectedDimension = DEFAULT_EXPECTED_DIMENSION): string {
  if (c.skipped || c.ok === null) return t("Skipped");
  if (c.ok) return name === "embedding" && c.dimension ? t("Works — {n}-dimensional vectors", { n: c.dimension }) : t("Works");
  if (c.code === "EMBEDDING_DIMENSION_MISMATCH") {
    return c.dimension ? t("This model produces {n}-dimensional vectors; StudyForge stores {expected}.", { n: c.dimension, expected: expectedDimension }) : t("This model's vectors don't match the {expected} dimensions StudyForge stores.", { expected: expectedDimension });
  }
  return c.message || describeProviderCode(c.code, t);
}

export type SaveFeedback = { message: string; checks: Checks | null; fields: Partial<Record<"apiKey" | "chatModelId" | "embeddingModelId", string>> };

const FIELD_KEYS = ["apiKey", "chatModelId", "embeddingModelId"] as const;

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
      return { message: t("The AI service is unavailable right now. Nothing was saved. Please try again shortly."), checks: null, fields };
    case "VALIDATION":
      return { message: t("Please fix the highlighted fields."), checks: null, fields };
    case "PROVIDER_ERROR":
      return { message: describeProviderCode(typeof err.details?.providerCode === "string" ? err.details.providerCode : null, t), checks: null, fields };
    default:
      return { message: err.message || t("Something went wrong. Please try again."), checks, fields };
  }
}
