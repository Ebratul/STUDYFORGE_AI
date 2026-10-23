import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiConnectionForm } from "@/components/ai/connection-form";
import {
  buildBody, checkMessage, connectionPollInterval, DEFAULT_DIMENSION_LIMITS, DEFAULT_LIMITS, diagnosticsLine, dimensionPayload, EMPTY_PARAMS, feedbackFromError, inferRequest, inputsToParams, paramsToInputs, previewProvider, readChecks, readConnection,
  readDimensionInfo, readEmbeddingChange, readReindex, shownDimension, validateApiKey, validateDimension, validateModelId, validateParam, type DimensionInfo,
} from "@/components/ai/connection-helpers";
import { EmbeddingReindexPanel, keepPollingReindex, postReindexAction, reindexPercent } from "@/components/ai/embedding-reindex-panel";
import { startPolling } from "@/lib/poll";
import { ApiError } from "@/lib/api";
import { describeProviderCode } from "@/lib/ai";
import { EN } from "@/lib/format-locale";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
const t = EN.t;
const html = (el: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));

const conn = (o: Record<string, unknown> = {}) =>
  readConnection({
    connection: {
      configured: true, provider: "openrouter", providerLabel: "OpenRouter", apiKey: { configured: true, masked: "••••abcd", status: "VALID" },
      chatModelId: "deepseek/deepseek-chat", embeddingModelId: "openai/text-embedding-3-small", embeddingDimension: 1536, embeddingRequestDimensions: null, dimensionLimits: { min: 8, max: 4096 }, defaultEmbeddingDimension: null, reindex: null,
      validatedAt: "2026-10-24T10:00:00Z", documents: { ready: 3, stale: 0, processing: 0 }, costNote: "Saving makes two tiny paid requests (one chat, one embedding) with your key.", ...o,
    },
  })!;

describe("model id and key validation (instant feedback; the server is authoritative)", () => {
  it("accepts typical provider model ids", () => {
    for (const id of ["deepseek/deepseek-chat", "openai/text-embedding-3-small", "meta-llama/llama-3.3-70b-instruct:free", "gpt-4o-mini", "a"]) expect(validateModelId(id, t)).toBeNull();
  });
  it("rejects empty, malformed and over-long ids and trims whitespace first", () => {
    expect(validateModelId("   ", t)).toMatch(/Enter a model ID/);
    expect(validateModelId("bad id", t)).toMatch(/letters, digits/);
    expect(validateModelId("/leading-slash", t)).toMatch(/letters, digits/);
    expect(validateModelId("x".repeat(201), t)).toMatch(/200 characters/);
    expect(validateModelId("  openai/text-embedding-3-small  ", t)).toBeNull();
  });
  it("requires a key only when none is saved, and never accepts spaces or control characters", () => {
    expect(validateApiKey("", false, t)).toMatch(/Enter your API key/);
    expect(validateApiKey("   ", true, t)).toBeNull(); // blank keeps the saved key
    expect(validateApiKey("short", true, t)).toMatch(/too short/);
    expect(validateApiKey("sk-or-v1-abc def-123456", false, t)).toMatch(/no spaces/);
    expect(validateApiKey("sk-or-v1-" + "a".repeat(600), false, t)).toMatch(/too long/);
    expect(validateApiKey("sk-or-v1-abcdef123456", false, t)).toBeNull();
  });
});

describe("request body: a blank key is never sent", () => {
  it("omits the key when blank, trims everything else", () => {
    expect(buildBody({ apiKey: "  ", chatModelId: " a/b ", embeddingModelId: " c/d " })).toEqual({ chatModelId: "a/b", embeddingModelId: "c/d" });
    expect(buildBody({ apiKey: " sk-or-v1-xyz12345 ", chatModelId: "a", embeddingModelId: "b" })).toEqual({ apiKey: "sk-or-v1-xyz12345", chatModelId: "a", embeddingModelId: "b" });
    expect(Object.keys(buildBody({ apiKey: "", chatModelId: "a", embeddingModelId: "b" }))).not.toContain("apiKey");
  });
});

describe("provider preview (display only)", () => {
  it("guesses from the key prefix and defaults to OpenRouter", () => {
    expect(previewProvider("sk-or-v1-abc")?.label).toBe("OpenRouter");
    expect(previewProvider("gsk_abc")?.label).toBe("Groq");
    expect(previewProvider("AIzaSyExample0123456789")).toEqual({ id: "gemini", label: "Gemini" });
    expect(previewProvider("aizaLowercase")?.label).toBe("OpenRouter"); // case matters: Google keys start with "AIza"
    expect(previewProvider("sk-proj-abc")?.label).toBe("OpenAI");
    expect(previewProvider("whatever-key")?.label).toBe("OpenRouter");
    expect(previewProvider("   ")).toBeNull();
  });
});

describe("reading the connection and the checks", () => {
  it("reads the masked connection and never exposes anything but the mask", () => {
    const c = conn();
    expect(c.apiKey).toEqual({ configured: true, masked: "••••abcd", status: "VALID" });
    expect(JSON.stringify(c)).not.toMatch(/ciphertext|authTag|sk-/);
    expect(readConnection(null)).toBeNull();
    const bare = readConnection({ connection: { configured: false } })!;
    expect(bare.dimensionLimits).toEqual(DEFAULT_DIMENSION_LIMITS);
    expect(bare).toMatchObject({ embeddingRequestDimensions: null, defaultEmbeddingDimension: null, reindex: null });
  });
  it("describes each check, including the measured dimension of a mismatching embedding model", () => {
    const checks = readChecks({
      auth: { ok: true, latency_ms: 120 },
      chat: { ok: false, code: "MODEL_NOT_FOUND", message: "The model wasn't found for your key." },
      embedding: { ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", message: "x", dimension: 3072 },
    })!;
    expect(checkMessage("auth", checks.auth, t)).toBe("Works");
    expect(checkMessage("chat", checks.chat, t)).toBe("The model wasn't found for your key.");
    expect(checkMessage("embedding", checks.embedding, t)).toBe("This model returned 3,072-dimensional vectors, not the size you asked for. Vectors are never padded or truncated.");
    expect(checkMessage("embedding", readChecks({ embedding: { ok: true } })!.embedding, t)).toBe("Works");
    expect(checkMessage("dimension", readChecks({ dimension: { ok: true, dimension: 1536 } })!.dimension, t)).toBe("1,536 dimensions, as configured");
    expect(checkMessage("database", readChecks({ database: { ok: true, dimension: 1536 } })!.database, t)).toBe("The database can store 1,536-dimensional vectors");
    expect(checkMessage("chat", readChecks({ auth: { ok: false } })!.chat, t)).toBe("Skipped"); // missing check = not run
  });
});

describe("error mapping", () => {
  const err = (status: number, code: string, details: Record<string, unknown> = {}, fields: Record<string, string> = {}) => new ApiError(status, code, "server text", fields, details);
  it("AI_CONFIG_INVALID keeps the per-check results and says nothing was saved", () => {
    const f = feedbackFromError(err(422, "AI_CONFIG_INVALID", { checks: { auth: { ok: true }, chat: { ok: false, code: "MODEL_NOT_FOUND" }, embedding: { ok: null, skipped: true } } }, { chatModelId: "Not found for your key" }), t);
    expect(f.message).toMatch(/nothing was saved/);
    expect(f.message).toMatch(/previous settings are unchanged/);
    expect(f.checks?.chat.ok).toBe(false);
    expect(f.checks?.embedding.skipped).toBe(true);
    expect(f.fields.chatModelId).toBe("Not found for your key");
  });
  it("maps rate limits, outages and validation to calm messages and never shows raw network text", () => {
    expect(feedbackFromError(err(429, "RATE_LIMITED"), t).message).toMatch(/Too many attempts/);
    expect(feedbackFromError(err(503, "UPSTREAM_UNAVAILABLE"), t).message).toMatch(/Nothing was saved/);
    expect(feedbackFromError(err(422, "VALIDATION", {}, { apiKey: "Enter your API key." }), t).fields.apiKey).toBe("Enter your API key.");
    expect(feedbackFromError(new Error("ECONNRESET sk-leak"), t).message).not.toContain("sk-leak");
  });
});

describe("the form", () => {
  it("renders three text-like inputs (key, chat model, embedding model), the optional embedding size, six optional numeric settings, and the Test actions", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn() }));
    const inputs = [...out.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    const numeric = inputs.filter((i) => /type="number"/.test(i));
    expect(inputs.filter((i) => !/type="number"/.test(i))).toHaveLength(3);
    expect(inputs.filter((i) => /type="password"/.test(i))).toHaveLength(1);
    expect(numeric.map((i) => /name="(\w+)"/.exec(i)![1]).sort()).toEqual(["embeddingDimension", "frequencyPenalty", "maxTokens", "presencePenalty", "seed", "temperature", "topP"]);
    expect(numeric.filter((i) => !/name="embeddingDimension"/.test(i)).every((i) => /placeholder="Provider default"/.test(i))).toBe(true); // empty = the setting is not sent
    expect(out).toMatch(/aria-pressed="false"/);
    expect(out).toContain("Test and save");
    expect(out).toContain("Test configuration");
    expect(out).toContain("Browse chat models");
    expect(out).not.toMatch(/<select|role="combobox"/);
    expect(out).not.toMatch(/name="(provider|baseUrl|dimension)"/i);
  });
  it("never pre-fills the key: shows the masked 'Key configured' hint and leaves the key input empty", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn() }));
    const key = out.match(/<input\b[^>]*name="apiKey"[^>]*>/)![0];
    expect(key).toMatch(/value=""/);
    expect(out).toContain("Key configured ••••abcd — leave blank to keep it.");
    expect(out).not.toContain("sk-or-");
  });
  it("shows the model ids, measured dimension, the provider line and the cost note", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn() }));
    expect(out).toContain("deepseek/deepseek-chat");
    expect(out).toContain("1536 dimensions (measured)".replace("1536", "1,536"));
    expect(out).toContain("Provider: OpenRouter (detected from your key)");
    expect(out).toContain("Testing makes tiny requests with your key");
  });
  it("shows the re-embed banner only when documents are stale", () => {
    expect(html(createElement(AiConnectionForm, { initial: conn() }))).not.toContain("reembed-banner");
    const out = html(createElement(AiConnectionForm, { initial: conn({ documents: { ready: 1, stale: 2, processing: 0 } }) }));
    expect(out).toContain("reembed-banner");
    expect(out).toContain("2 documents need re-embedding");
    expect(out).toContain("Re-embed 2 documents");
  });
  it("an unconfigured connection asks for the key and has no saved-key hint", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn({ configured: false, apiKey: { configured: false, masked: null, status: null }, chatModelId: null, embeddingModelId: null, providerLabel: null, provider: null, embeddingDimension: null, validatedAt: null }) }));
    expect(out).toContain("Stored encrypted on the server");
    expect(out).toContain("Nothing is connected yet");
    expect(out).toContain('placeholder="provider/model-name"');
    expect(out).not.toContain('placeholder="deepseek');
  });
});

describe("generation settings helpers (Increment 1)", () => {
  const limits = DEFAULT_LIMITS;
  it("treats blank as 'provider default' and range-checks everything else", () => {
    expect(validateParam("temperature", "", limits, t)).toBeNull();
    expect(validateParam("temperature", "  ", limits, t)).toBeNull();
    expect(validateParam("temperature", "0", limits, t)).toBeNull();
    expect(validateParam("temperature", "2", limits, t)).toBeNull();
    expect(validateParam("temperature", "2.01", limits, t)).toBe("Enter a value from 0 to 2.");
    expect(validateParam("topP", "-0.1", limits, t)).toBe("Enter a value from 0 to 1.");
    expect(validateParam("frequencyPenalty", "-2", limits, t)).toBeNull();
    expect(validateParam("presencePenalty", "2.5", limits, t)).toBe("Enter a value from -2 to 2.");
    expect(validateParam("maxTokens", "0", limits, t)).toBe("Enter a value from 1 to 32,768.");
    expect(validateParam("maxTokens", "100.5", limits, t)).toBe("Enter a whole number.");
    expect(validateParam("seed", "1.5", limits, t)).toBe("Enter a whole number.");
    expect(validateParam("seed", "-1", limits, t)).toBe("Enter a value from 0 to 2,147,483,647.");
  });
  it("rejects things that are not plain decimal numbers", () => {
    for (const bad of ["abc", "1e3", "0x10", "1,5", "NaN", "Infinity", "--1", "1.", ".5", "1 2"]) expect(validateParam("temperature", bad, limits, t), bad).toBe("Enter a number.");
  });
  it("converts between the inputs and the request: blank clears (null), numbers are numbers", () => {
    const inputs = paramsToInputs({ ...EMPTY_PARAMS, temperature: 0.3, seed: 7 });
    expect(inputs).toMatchObject({ temperature: "0.3", seed: "7", topP: "" });
    expect(inputsToParams({ ...inputs, topP: "0.9" })).toEqual({ ...EMPTY_PARAMS, temperature: 0.3, seed: 7, topP: 0.9 });
    expect(buildBody({ apiKey: "", chatModelId: " m ", embeddingModelId: "e", params: EMPTY_PARAMS })).toEqual({ chatModelId: "m", embeddingModelId: "e", params: EMPTY_PARAMS });
  });
  it("reads saved settings and ranges defensively", () => {
    const c = readConnection({ connection: { params: { temperature: 0.5, seed: "x", topP: Number.NaN }, paramLimits: { temperature: { min: 0, max: 1 } } } })!;
    expect(c.params).toEqual({ ...EMPTY_PARAMS, temperature: 0.5 });
    expect(c.paramLimits.temperature).toEqual({ min: 0, max: 1 });
    expect(c.paramLimits.seed).toEqual(DEFAULT_LIMITS.seed);
  });
  it("describes a refused setting by name, and passed ones by what was accepted", () => {
    const checks = readChecks({ chatParams: { ok: false, code: "PARAMETER_UNSUPPORTED", unsupported: ["frequency_penalty", "presence_penalty"], message: "x" } })!;
    expect(checkMessage("chatParams", checks.chatParams, t)).toBe("This model doesn't accept: frequency_penalty, presence_penalty. Clear those settings or choose another model.");
    expect(checkMessage("chatParams", readChecks({ chatParams: { ok: true, verified: ["seed", "temperature"] } })!.chatParams, t)).toBe("Accepted: seed, temperature");
    expect(checkMessage("chatParams", readChecks({ chatParams: { ok: null, skipped: true, message: "n/a" } })!.chatParams, t)).toMatch(/^Nothing to test/);
  });
  it("shows the dimension failure with the no-padding rule, and database failures with the server's explanation", () => {
    const c = readChecks({ dimension: { ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", dimension: 2048 }, database: { ok: false, code: "DB_DIMENSION_MISMATCH", message: "The database stores 1536-dimensional vectors; this model returns 2048." } })!;
    expect(checkMessage("dimension", c.dimension, t, { measured: 2048, native: 1536, requested: 1536, source: "request" })).toBe("This model returned 2,048-dimensional vectors when 1,536 were requested, so it doesn't support that size. Its native size is 1,536. Vectors are never padded or truncated.");
    expect(checkMessage("database", c.database, t)).toMatch(/1536-dimensional/);
  });
  it("builds one safe diagnostics line and nothing when there is none", () => {
    const c = readChecks({ embedding: { ok: false, code: "PROVIDER_ERROR", diagnostics: { endpoint: "POST /embeddings", http_status: 400, upstream_code: "400", upstream_provider: "Nvidia", wrapped_in_http_200: true, secret: { nested: "ignored" } } } })!;
    expect(diagnosticsLine(c.embedding, t)).toBe("POST /embeddings · HTTP 400 · code 400 · Nvidia · error inside an HTTP 200 reply");
    expect(JSON.stringify(c.embedding)).not.toContain("nested");
    expect(diagnosticsLine(readChecks({ embedding: { ok: true } })!.embedding, t)).toBeNull();
    expect(diagnosticsLine(readChecks({ embedding: { ok: false } })!.embedding, t)).toBeNull();
  });
  it("tells the user to restart rag_agent instead of blaming the provider", () => {
    const outdated = new ApiError(503, "UPSTREAM_UNAVAILABLE", "x", {}, { providerCode: "AI_SERVICE_OUTDATED" });
    expect(feedbackFromError(outdated, t).message).toMatch(/needs a restart.*Nothing was saved/);
    for (const code of ["VALIDATION", "NOT_FOUND", "INTERNAL"]) expect(describeProviderCode(code, t), code).toMatch(/needs a restart/);
    expect(describeProviderCode("PROVIDER_RATE_LIMITED", t)).toMatch(/rate-limiting/); // real provider codes are unchanged
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Embedding dimensions (docs/EMBEDDING_SETTINGS_SPEC.md)
// ---------------------------------------------------------------------------------------------------------------------------------

const LIM = DEFAULT_DIMENSION_LIMITS;
const reindex = (o: Record<string, unknown> = {}) => ({ id: "r1", status: "BUILDING", provider: "openrouter", modelId: "acme/embed-1024", dimension: 1024, progress: { total: 8, done: 3 }, errorCode: null, errorMessage: null, createdAt: "2026-10-26T09:00:00Z", ...o });

describe("embedding dimension field: validation (instant feedback; the server verifies the real output)", () => {
  it("treats blank and whitespace as Automatic", () => {
    expect(validateDimension("", LIM, t)).toBeNull();
    expect(validateDimension("   ", LIM, t)).toBeNull();
  });
  it("accepts whole numbers inside the server's limits, trimming spaces", () => {
    for (const ok of ["8", "512", " 1024 ", "1536", "4096"]) expect(validateDimension(ok, LIM, t), ok).toBeNull();
  });
  it("rejects zero, negatives and anything outside the limits with the range in the message", () => {
    expect(validateDimension("0", LIM, t)).toBe("Enter a value from 8 to 4,096.");
    expect(validateDimension("7", LIM, t)).toBe("Enter a value from 8 to 4,096.");
    expect(validateDimension("-512", LIM, t)).toBe("Enter a value from 8 to 4,096.");
    expect(validateDimension("4097", LIM, t)).toBe("Enter a value from 8 to 4,096.");
    expect(validateDimension("100", { min: 128, max: 256 }, t)).toBe("Enter a value from 128 to 256."); // limits come from the API
  });
  it("rejects non-integers and non-numbers", () => {
    expect(validateDimension("512.5", LIM, t)).toBe("Enter a whole number.");
    for (const bad of ["abc", "1e3", "0x10", "1,024", "NaN", "Infinity", "--1", "1.", ".5", "1 2"]) expect(validateDimension(bad, LIM, t), bad).toBe("Enter a number.");
  });
});

describe("embedding dimension field: what is sent (number / null / omitted)", () => {
  it("omits the field when the user never touched it, so the server keeps the saved size for an unchanged model", () => {
    expect(dimensionPayload("1536", false)).toEqual({});
    expect(buildBody({ apiKey: "", chatModelId: "a", embeddingModelId: "b", ...dimensionPayload("", false) })).not.toHaveProperty("embeddingDimension");
  });
  it("sends a number once the user entered one", () => {
    expect(dimensionPayload("512", true)).toEqual({ embeddingDimension: 512 });
    expect(dimensionPayload(" 1024 ", true)).toEqual({ embeddingDimension: 1024 });
  });
  it("sends null when the user cleared the field: an explicit 'Automatic'", () => {
    expect(dimensionPayload("", true)).toEqual({ embeddingDimension: null });
    expect(dimensionPayload("  ", true)).toEqual({ embeddingDimension: null });
    const body = buildBody({ apiKey: "", chatModelId: "a", embeddingModelId: "b", ...dimensionPayload("", true) });
    expect(body).toHaveProperty("embeddingDimension", null);
    expect(JSON.parse(JSON.stringify(body))).toHaveProperty("embeddingDimension", null);
  });
  it("buildBody passes through exactly what it is given: undefined is omitted, null and numbers are kept", () => {
    expect(buildBody({ apiKey: "", chatModelId: "a", embeddingModelId: "b", embeddingDimension: undefined })).not.toHaveProperty("embeddingDimension");
    expect(buildBody({ apiKey: "", chatModelId: "a", embeddingModelId: "b", embeddingDimension: 0 })).toHaveProperty("embeddingDimension", 0);
  });
  it("an untouched field mirrors the saved size only while the embedding model is the saved one", () => {
    expect(shownDimension("", false, 512, "acme/embed", "acme/embed")).toBe("512");
    expect(shownDimension("", false, 512, " acme/embed ", "acme/embed")).toBe("512");
    expect(shownDimension("", false, 512, "other/embed", "acme/embed")).toBe(""); // different model: the server picks Automatic, so the field says so
    expect(shownDimension("", false, null, "acme/embed", null)).toBe("");
    expect(shownDimension("256", true, 512, "other/embed", "acme/embed")).toBe("256"); // typed values always win
    expect(shownDimension("", true, 512, "acme/embed", "acme/embed")).toBe(""); // cleared = Automatic
  });
  it("infers what the server will try (display only), following the precedence table", () => {
    expect(inferRequest("512", true, false, 1536, 2048)).toEqual({ requested: 512, source: "request" });
    expect(inferRequest("1536", false, true, 1536, 2048)).toEqual({ requested: 1536, source: "database" });
    expect(inferRequest("", true, true, 1536, 2048)).toEqual({ requested: 2048, source: "environment" });
    expect(inferRequest("", false, false, 1536, 2048)).toEqual({ requested: 2048, source: "environment" });
    expect(inferRequest("", true, true, 1536, null)).toEqual({ requested: null, source: "model" });
  });
});

describe("embedding dimension: reading the API", () => {
  it("reads the new connection fields and falls back to the app's limits", () => {
    const c = conn({ embeddingDimension: 512, embeddingRequestDimensions: 512, dimensionLimits: { min: 16, max: 2048 }, defaultEmbeddingDimension: 1024, reindex: reindex() });
    expect(c).toMatchObject({ embeddingDimension: 512, embeddingRequestDimensions: 512, dimensionLimits: { min: 16, max: 2048 }, defaultEmbeddingDimension: 1024 });
    expect(c.reindex).toMatchObject({ id: "r1", status: "BUILDING", modelId: "acme/embed-1024", dimension: 1024, progress: { total: 8, done: 3 } });
    expect(conn({ dimensionLimits: { min: 99, max: 3 } }).dimensionLimits).toEqual(DEFAULT_DIMENSION_LIMITS); // inverted range is ignored
    expect(conn({ defaultEmbeddingDimension: "x" }).defaultEmbeddingDimension).toBeNull();
  });
  it("reads a staged build defensively: unknown states, missing fields and impossible progress are not shown as a build", () => {
    expect(readReindex(null)).toBeNull();
    expect(readReindex(reindex({ status: "ACTIVATED" }))).toBeNull();
    expect(readReindex(reindex({ modelId: "" }))).toBeNull();
    expect(readReindex(reindex({ progress: { total: 4, done: 9 } }))!.progress).toEqual({ total: 4, done: 4 });
    expect(readReindex(reindex({ status: "FAILED", errorCode: "MODEL_NOT_FOUND", errorMessage: "Model gone." }))).toMatchObject({ status: "FAILED", errorCode: "MODEL_NOT_FOUND", errorMessage: "Model gone." });
  });
  it("reads the embedding change of a save; anything unexpected is 'unchanged'", () => {
    expect(readEmbeddingChange({ embeddingChange: { status: "reindexing", documents: 5 } })).toEqual({ status: "reindexing", documents: 5 });
    expect(readEmbeddingChange({ embeddingChange: { status: "activated", documents: 0 } }).status).toBe("activated");
    expect(readEmbeddingChange({ embeddingChange: { status: "weird" } })).toEqual({ status: "unchanged", documents: 0 });
    expect(readEmbeddingChange({ reembedRequired: true })).toEqual({ status: "unchanged", documents: 0 }); // the removed field is ignored
    expect(readEmbeddingChange(null)).toEqual({ status: "unchanged", documents: 0 });
  });
  it("reads the test reply's dimension facts", () => {
    expect(readDimensionInfo({ measuredDimension: 512, nativeDimension: 1024, requestedDimension: 512, dimensionSource: "request" })).toEqual({ measured: 512, native: 1024, requested: 512, source: "request" });
    expect(readDimensionInfo({ dimensionSource: "bogus" })).toEqual({ measured: null, native: null, requested: null, source: null });
    expect(readDimensionInfo(undefined).measured).toBeNull();
  });
  it("keeps the dimension facts the embedding check itself carries", () => {
    const c = readChecks({ embedding: { ok: true, dimension: 512, native_dimension: 1024, request_dimensions: 512 }, auth: { ok: true } })!;
    expect(c.embedding).toMatchObject({ dimension: 512, nativeDimension: 1024, requestDimensions: 512 });
  });
  it("maps field errors for the dimension field", () => {
    const f = feedbackFromError(new ApiError(422, "AI_CONFIG_INVALID", "x", { embeddingDimension: "This model can't produce 2048.", embeddingModelId: "Model not found" }, { checks: {} }), t);
    expect(f.fields).toEqual({ embeddingDimension: "This model can't produce 2048.", embeddingModelId: "Model not found" });
    const v = feedbackFromError(new ApiError(422, "VALIDATION", "x", { embeddingDimension: "Enter a whole number between 8 and 4096." }), t);
    expect(v.fields.embeddingDimension).toBe("Enter a whole number between 8 and 4096.");
  });
});

describe("embedding dimension: what each check outcome says", () => {
  const info = (o: Partial<DimensionInfo> = {}): DimensionInfo => ({ measured: null, native: null, requested: null, source: null, ...o });
  const chk = (raw: Record<string, unknown>, name: "dimension" | "embedding" | "database" = "dimension") => readChecks({ [name]: raw })![name];

  it("a shortened size verified with a live request says so and names the native size", () => {
    expect(checkMessage("dimension", chk({ ok: true, dimension: 512 }), t, info({ native: 1024, requested: 512, source: "request" }))).toBe("512 dimensions. This model returns 1,024 natively; 512 was verified with a live request.");
  });
  it("the native size is reported as such", () => {
    expect(checkMessage("dimension", chk({ ok: true, dimension: 1536 }), t, info({ native: 1536, source: "model" }))).toBe("1,536 dimensions, this model's own size.");
    expect(checkMessage("dimension", chk({ ok: true, dimension: 1536 }), t)).toBe("1,536 dimensions, as configured"); // no facts: no claim
  });
  it("a model that returned another size than requested is described without padding or truncating", () => {
    const m = checkMessage("dimension", chk({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", dimension: 768 }), t, info({ measured: 768, native: 768, requested: 1024, source: "request" }));
    expect(m).toBe("This model returned 768-dimensional vectors when 1,024 were requested, so it doesn't support that size. Its native size is 768. Vectors are never padded or truncated.");
  });
  it("a deployment default the model can't produce names the default and the native size", () => {
    const m = checkMessage("dimension", chk({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", dimension: 1536 }), t, info({ measured: 1536, native: 1536, requested: 2048, source: "environment" }));
    expect(m).toBe("The deployment default (2,048) is not supported by this model: it returned 1,536-dimensional vectors. Its native size is 1,536. Vectors are never padded or truncated.");
  });
  it("a provider that refuses the size says so (user-typed and default)", () => {
    const typed = checkMessage("embedding", chk({ ok: false, code: "EMBEDDING_DIMENSION_UNSUPPORTED" }, "embedding"), t, info({ native: 1536, requested: 256, source: "request" }));
    expect(typed).toBe("The provider refused the vector size 256 for this model. Its native size is 1,536. Vectors are never padded or truncated.");
    const def = checkMessage("dimension", chk({ ok: false, code: "EMBEDDING_DIMENSION_UNSUPPORTED" }), t, info({ requested: 2048, source: "environment" }));
    expect(def).toMatch(/^The deployment default \(2,048\) is not supported by this model: the provider refused that size\./);
    expect(checkMessage("embedding", chk({ ok: false, code: "EMBEDDING_DIMENSION_UNSUPPORTED" }, "embedding"), t)).toMatch(/^The provider refused the requested vector size/);
  });
  it("database storage problems use the server's explanation, or our own text for the code", () => {
    expect(checkMessage("database", chk({ ok: false, code: "DB_DIMENSION_MISMATCH", message: "The database stores 1536-dimensional vectors; this model returns 2048." }, "database"), t)).toMatch(/1536-dimensional/);
    expect(checkMessage("database", chk({ ok: false, code: "DB_VECTOR_UNAVAILABLE" }, "database"), t)).toMatch(/pgvector/);
    expect(describeProviderCode("DB_DIMENSION_MISMATCH", t)).toMatch(/schema/);
    expect(describeProviderCode("EMBEDDING_DIMENSION_UNSUPPORTED", t)).toMatch(/doesn't accept/);
    expect(describeProviderCode("EMBEDDING_DIMENSION_OUT_OF_RANGE", t)).toMatch(/range/);
  });
  it("never mentions the old fixed 1536 requirement", () => {
    const all = [
      checkMessage("dimension", chk({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", dimension: 3072 }), t),
      checkMessage("embedding", chk({ ok: false, code: "EMBEDDING_DIMENSION_MISMATCH" }, "embedding"), t),
      describeProviderCode("EMBEDDING_DIMENSION_MISMATCH", t),
    ].join(" ");
    expect(all).not.toMatch(/1,?536|StudyForge (stores|is configured)/);
  });
});

describe("the form with the embedding dimension field", () => {
  const field = (out: string) => out.match(/<input\b[^>]*name="embeddingDimension"[^>]*>/)![0];
  it("sits right after the embedding model field, is optional and blank means Automatic", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn({ embeddingDimension: null, embeddingModelId: null }) }));
    expect(out.indexOf('name="embeddingModelId"')).toBeGreaterThan(-1);
    expect(out.indexOf('name="embeddingDimension"')).toBeGreaterThan(out.indexOf('name="embeddingModelId"'));
    expect(out.indexOf('name="embeddingDimension"')).toBeLessThan(out.indexOf('name="temperature"'));
    const f = field(out);
    expect(f).toMatch(/type="number"/);
    expect(f).toMatch(/placeholder="Automatic"/);
    expect(f).toMatch(/min="8"/);
    expect(f).toMatch(/max="4096"/);
    expect(f).toMatch(/value=""/);
    expect(out).toContain("Embedding dimensions");
  });
  it("shows the saved active size in the field and explains that nothing is padded or truncated", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn({ embeddingDimension: 512, embeddingRequestDimensions: 512 }) }));
    expect(field(out)).toMatch(/value="512"/);
    expect(out).toContain("never padded or truncated");
    expect(out).toContain("Shorter sizes only work well with models trained for them");
    expect(out).toContain("Not every model supports every size");
  });
  it("uses the limits from the API", () => {
    const f = field(html(createElement(AiConnectionForm, { initial: conn({ dimensionLimits: { min: 64, max: 2048 } }) })));
    expect(f).toMatch(/min="64"/);
    expect(f).toMatch(/max="2048"/);
  });
  it("explains Automatic with the deployment default when there is one, otherwise with the model's own size", () => {
    expect(html(createElement(AiConnectionForm, { initial: conn({ defaultEmbeddingDimension: 2048 }) }))).toContain("this server&#x27;s default of 2,048 dimensions is tried, and a size you saved earlier always replaces that default");
    const none = html(createElement(AiConnectionForm, { initial: conn() }));
    expect(none).toContain("the model&#x27;s own vector size is used, and a size you saved earlier is kept");
    expect(none).not.toContain("server&#x27;s default");
  });
  it("the saved state shows the active size, 'shortened to N' for a shortened model, and that the saved size replaces the server default", () => {
    const plain = html(createElement(AiConnectionForm, { initial: conn() }));
    expect(plain).toContain("1,536 dimensions (measured)");
    expect(plain).not.toContain("shortened to");
    const short = html(createElement(AiConnectionForm, { initial: conn({ embeddingDimension: 512, embeddingRequestDimensions: 512, defaultEmbeddingDimension: 2048 }) }));
    expect(short).toContain("512 dimensions (measured)");
    expect(short).toContain("shortened to 512");
    expect(short).toContain("Saved in your settings; this replaces the server default of 2,048.");
  });
  it("no longer carries the fixed 1536 wording", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn({ embeddingDimension: 512 }) }));
    expect(out).not.toMatch(/must produce|StudyForge stores/);
  });
  it("shows the staged build panel (and the stale banner is independent of it)", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn({ reindex: reindex(), documents: { ready: 8, stale: 0, processing: 0 } }) }));
    expect(out).toContain('data-testid="reindex-panel"');
    expect(out).toContain("Building your new search index");
    expect(out).not.toContain("reembed-banner");
    expect(html(createElement(AiConnectionForm, { initial: conn() }))).not.toContain("reindex-panel");
  });
});

describe("EmbeddingReindexPanel", () => {
  const panel = (o: Record<string, unknown> = {}) => html(createElement(EmbeddingReindexPanel, { reindex: readReindex(reindex(o))! }));

  it("BUILDING: shows target, accessible progress values, a status line and a Cancel button, and explains the old index stays active", () => {
    const out = panel();
    expect(out).toContain('data-state="building"');
    expect(out).toContain("acme/embed-1024 · 1,024 dimensions");
    expect(out).toMatch(/role="progressbar"/);
    expect(out).toMatch(/aria-valuenow="37"/); // floor(3/8*100)
    expect(out).toMatch(/aria-valuemax="100"/);
    expect(out).toMatch(/aria-valuetext="3 of 8 documents"/);
    expect(out).toMatch(/aria-label="Building the new search index"/);
    expect(out).toMatch(/aria-live="polite"/);
    expect(out).toContain("3 of 8 documents");
    expect(out).toContain("Your current index stays active and searchable until the new one is complete and verified");
    expect(out).toContain('data-testid="reindex-cancel"');
    expect(out).not.toContain("reindex-retry");
  });
  it("BUILDING: progress is 0 with no documents and 100 when complete, never out of range", () => {
    expect(reindexPercent(0, 0)).toBe(0);
    expect(reindexPercent(8, 8)).toBe(100);
    expect(reindexPercent(9, 8)).toBe(100);
    expect(reindexPercent(-1, 8)).toBe(0);
    expect(panel({ progress: { total: 0, done: 0 } })).toMatch(/aria-valuenow="0"/);
  });
  it("FAILED: shows the safe message, that nothing changed, and Try again + Dismiss; no progress bar", () => {
    const out = panel({ status: "FAILED", errorCode: "MODEL_NOT_FOUND", errorMessage: "The embedding model was not found for your key." });
    expect(out).toContain('data-state="failed"');
    expect(out).toContain("The new search index could not be built");
    expect(out).toContain("The embedding model was not found for your key.");
    expect(out).toContain("your current index is still active");
    expect(out).toContain('data-testid="reindex-retry"');
    expect(out).toContain('data-testid="reindex-cancel"');
    expect(out).toContain("Dismiss");
    expect(out).toMatch(/role="alert"/);
    expect(out).not.toContain("progressbar");
  });
  it("FAILED without a server message falls back to our own wording for the code", () => {
    expect(panel({ status: "FAILED", errorCode: "EMBEDDING_DIMENSION_MISMATCH", errorMessage: null })).toContain("returned vectors of a different size");
  });
});

describe("reindex actions and polling", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("cancel and retry POST to the right same-origin endpoints", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connection: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await postReindexAction("cancel");
    await postReindexAction("retry");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual(["POST /api/ai/embedding-reindex/cancel", "POST /api/ai/embedding-reindex/retry"]);
    expect(calls.every(([, i]) => i.credentials === "same-origin")).toBe(true);
  });
  it("an action error surfaces as an ApiError with the server's code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "CONFLICT", message: "Nothing to cancel." } }), { status: 409, headers: { "content-type": "application/json" } })));
    await expect(postReindexAction("retry")).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("the connection query polls only for processing documents, never while the panel is polling a build", () => {
    expect(connectionPollInterval(conn())).toBe(false);
    expect(connectionPollInterval(conn({ documents: { ready: 1, stale: 0, processing: 2 } }))).toBe(3000);
    expect(connectionPollInterval(conn({ reindex: reindex(), documents: { ready: 1, stale: 0, processing: 2 } }))).toBe(false);
    expect(connectionPollInterval(conn({ reindex: reindex({ status: "FAILED" }), documents: { ready: 1, stale: 0, processing: 2 } }))).toBe(3000);
    expect(connectionPollInterval(undefined)).toBe(false);
  });
  it("keeps polling only while the build runs (or the state is unknown)", () => {
    expect(keepPollingReindex(conn({ reindex: reindex() }))).toBe(true);
    expect(keepPollingReindex(null)).toBe(true);
    expect(keepPollingReindex(conn())).toBe(false); // finished and switched over
    expect(keepPollingReindex(conn({ reindex: reindex({ status: "FAILED" }) }))).toBe(false);
  });

  it("polls every 3 s without overlapping requests, and stops after the build is no longer BUILDING", async () => {
    vi.useFakeTimers();
    const states = [conn({ reindex: reindex() }), conn({ reindex: reindex({ progress: { total: 8, done: 6 } }) }), conn()];
    let i = 0;
    const seen: unknown[] = [];
    const load = vi.fn(async () => states[Math.min(i++, states.length - 1)]!);
    startPolling({ load, onData: (c) => seen.push(c.reindex?.progress.done ?? "done"), keepGoing: keepPollingReindex, intervalMs: 3000 });
    expect(load).not.toHaveBeenCalled(); // nothing immediately: the page just fetched
    await vi.advanceTimersByTimeAsync(2999);
    expect(load).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(seen).toEqual([3, 6, "done"]);
    await vi.advanceTimersByTimeAsync(60_000); // finished: no further requests
    expect(load).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("never starts a request while the previous one is still running", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const load = vi.fn(() => new Promise<ReturnType<typeof conn>>((res) => { release = () => res(conn({ reindex: reindex() })); }));
    startPolling({ load, onData: () => undefined, keepGoing: keepPollingReindex, intervalMs: 3000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(1); // still waiting on the first one
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("stop() cancels the pending timer, so an unmounted panel is never called back", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => conn({ reindex: reindex() }));
    const onData = vi.fn();
    const stop = startPolling({ load, onData, keepGoing: keepPollingReindex });
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
  });
  it("a response that arrives after stop() is ignored", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const onData = vi.fn();
    const stop = startPolling({ load: () => new Promise<ReturnType<typeof conn>>((res) => { release = () => res(conn({ reindex: reindex() })); }), onData, keepGoing: keepPollingReindex, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onData).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("skips requests while the tab is hidden (the timer keeps ticking, nothing is fetched)", async () => {
    vi.useFakeTimers();
    let visible = false;
    const load = vi.fn(async () => conn({ reindex: reindex() }));
    const stop = startPolling({ load, onData: () => undefined, keepGoing: keepPollingReindex, intervalMs: 1000, visible: () => visible });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).not.toHaveBeenCalled();
    visible = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });
  it("backs off after failures instead of hammering the server, and recovers", async () => {
    vi.useFakeTimers();
    let fail = true;
    const load = vi.fn(async () => { if (fail) throw new Error("network"); return conn({ reindex: reindex() }); });
    const stop = startPolling({ load, onData: () => undefined, keepGoing: keepPollingReindex, intervalMs: 1000, maxBackoffMs: 8000 });
    await vi.advanceTimersByTimeAsync(1000); // 1st attempt
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); // next after 2 s
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999); // then 4 s
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(3);
    fail = false;
    await vi.advanceTimersByTimeAsync(8000); // capped at 8 s
    expect(load).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000); // success: back to the normal cadence
    expect(load).toHaveBeenCalledTimes(5);
    stop();
  });
});
