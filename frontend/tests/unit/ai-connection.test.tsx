import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AiConnectionForm } from "@/components/ai/connection-form";
import {
  buildBody, checkMessage, feedbackFromError, previewProvider, readChecks, readConnection, validateApiKey, validateModelId,
} from "@/components/ai/connection-helpers";
import { ApiError } from "@/lib/api";
import { EN } from "@/lib/format-locale";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
const t = EN.t;
const html = (el: React.ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, el));

const conn = (o: Record<string, unknown> = {}) =>
  readConnection({
    connection: {
      configured: true, provider: "openrouter", providerLabel: "OpenRouter", apiKey: { configured: true, masked: "••••abcd", status: "VALID" },
      chatModelId: "deepseek/deepseek-chat", embeddingModelId: "openai/text-embedding-3-small", embeddingDimension: 1536, expectedDimension: 1536,
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
    expect(readConnection({ connection: { configured: false } })!.expectedDimension).toBe(1536);
  });
  it("describes each check, including the measured dimension of a mismatching embedding model", () => {
    const checks = readChecks({
      auth: { ok: true, latency_ms: 120 },
      chat: { ok: false, code: "MODEL_NOT_FOUND", message: "The model wasn't found for your key." },
      embedding: { ok: false, code: "EMBEDDING_DIMENSION_MISMATCH", message: "x", dimension: 3072 },
    })!;
    expect(checkMessage("auth", checks.auth, t)).toBe("Works");
    expect(checkMessage("chat", checks.chat, t)).toBe("The model wasn't found for your key.");
    expect(checkMessage("embedding", checks.embedding, t)).toBe("This model produces 3,072-dimensional vectors; StudyForge stores 1,536.");
    expect(checkMessage("embedding", readChecks({ embedding: { ok: true, dimension: 1536 } })!.embedding, t)).toBe("Works — 1,536-dimensional vectors");
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
  it("renders exactly three text-like inputs, a password-type key with a show/hide button, and the Test and save action", () => {
    const out = html(createElement(AiConnectionForm, { initial: conn() }));
    const inputs = [...out.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(3);
    expect(inputs.filter((i) => /type="password"/.test(i))).toHaveLength(1);
    expect(out).toMatch(/aria-pressed="false"/);
    expect(out).toContain("Test and save");
    expect(out).not.toMatch(/<select|role="combobox"|type="number"/);
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
    expect(out).toContain("Saving makes two tiny paid requests");
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
