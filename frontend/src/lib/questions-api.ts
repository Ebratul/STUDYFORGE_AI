import { ApiError, parseError } from "@/lib/api";
import { describeProviderCode } from "@/lib/ai";
import type { ExportRequest } from "@/lib/questions-export";

export type GenerationErrorInfo = { code: string; message: string; retryable: boolean; retryAfter: number | null; details: Record<string, unknown>; fields: Record<string, string> };

export const toGenerationError = (e: ApiError): GenerationErrorInfo => ({
  code: e.code, message: e.message, retryable: !["NOT_CONFIGURED", "VALIDATION", "QUOTA_EXCEEDED"].includes(e.code), retryAfter: typeof e.details.retryAfterSec === "number" ? e.details.retryAfterSec : null, details: e.details, fields: e.fields,
});

/** Plain-language explanation of a generation failure. Never shows raw provider text. */
export function describeGenerationError(e: GenerationErrorInfo, ctx: { grounding?: string } = {}): { title: string; message: string; settingsCta?: boolean } {
  switch (e.code) {
    case "NOT_CONFIGURED": return { title: "Set up an AI model first", message: e.message || "Add an API key and choose a model in Settings → AI providers.", settingsCta: true };
    case "QUOTA_EXCEEDED": return { title: "Daily AI limit reached", message: e.message };
    case "RATE_LIMITED": return { title: "Slow down a little", message: e.retryAfter ? `Too many generation requests. Try again in about ${e.retryAfter} seconds.` : "Too many generation requests. Wait a moment and try again." };
    case "CONFLICT": return { title: "Another generation is running", message: e.message || "Wait for your current generation to finish, or try again in a few minutes." };
    case "VALIDATION": return { title: "Check your settings", message: e.message };
    case "GENERATION_FAILED": {
      const reason = String(e.details.reason ?? "");
      if (reason === "INSUFFICIENT_SOURCES") return { title: "Not enough in your sources", message: "Your text or documents don't contain enough on this topic to write questions that can be backed by a quote. Try a broader topic, add more material, or choose “Source preferred”." };
      if (reason === "NO_VALID_QUESTIONS" && ctx.grounding === "SOURCE_ONLY")
        return { title: "Your sources couldn't back any of the questions", message: "With “Source only”, every question and answer must be supported by a quote from your text or documents, and none of the generated ones were. Nothing was invented or kept. Add more relevant material, try a broader topic, or switch to “Source preferred” (unsupported parts are then clearly labelled)." };
      if (reason === "NO_VALID_QUESTIONS") return { title: "No valid questions were produced", message: "The model's output failed validation after several attempts, so nothing was kept. Try again, use fewer questions, or pick a different model." };
      if (reason === "INVALID_OUTPUT") return { title: "The model's reply couldn't be read", message: "The model didn't return well-formed questions. Try again or choose a model that supports structured output." };
      return { title: "Generation failed", message: e.message };
    }
    case "NETWORK": return { title: "Connection problem", message: e.message };
    case "UPSTREAM_UNAVAILABLE": return { title: "The AI service is unavailable", message: "Please try again shortly." };
    default:
      if (e.code.startsWith("PROVIDER_") || ["MODEL_NOT_FOUND", "CONTEXT_TOO_LONG", "CAPABILITY_UNSUPPORTED", "CONTENT_FILTERED", "STRUCTURED_OUTPUT_FAILED"].includes(e.code)) return { title: "The AI provider reported a problem", message: describeProviderCode(e.code) };
      return { title: "Something went wrong", message: e.message };
  }
}

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try { return decodeURIComponent(star[1] ?? ""); } catch { /* fall through */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1] ?? fallback;
}

/** Asks the server to render the export and hands the file to the browser. The server validates everything it renders. */
export async function downloadExport(req: ExportRequest): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "NETWORK", "Couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) throw await parseError(res);
  const blob = await res.blob();
  const name = filenameFrom(res, `questions.${req.format}`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
