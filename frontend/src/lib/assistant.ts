/** Handoff of an assistant prompt to the chat screen (docs/PART5_SPEC.md §5). The prompt is sent exactly once by the chat view. */

export type AssistantKind = "EXPLAIN_INCORRECT" | "TOPIC_SUMMARY" | "REVISION_PLAN" | "PRACTICE_QUESTIONS" | "RELATED_CQ";
export type AssistantSession = { conversationId: string | null; prompt: string | null; href: string | null };

type Rec = Record<string, unknown>;
export function readSession(raw: unknown): AssistantSession {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Rec;
  return {
    conversationId: typeof r.conversationId === "string" ? r.conversationId : null,
    prompt: typeof r.prompt === "string" ? r.prompt : null,
    href: typeof r.href === "string" && r.href.startsWith("/") && !r.href.startsWith("//") ? r.href : null,
  };
}

const KEY = (conversationId: string) => `sf-assistant-prompt:${conversationId}`;

/** Stores the prompt for one conversation (tab-scoped). Safe if storage is unavailable. */
export function stashPrompt(conversationId: string, prompt: string): boolean {
  try {
    window.sessionStorage.setItem(KEY(conversationId), prompt);
    return true;
  } catch {
    return false;
  }
}

/** Reads and REMOVES the prompt, so it can only ever be sent once. */
export function takePrompt(conversationId: string): string | null {
  try {
    const key = KEY(conversationId);
    const v = window.sessionStorage.getItem(key);
    if (v !== null) window.sessionStorage.removeItem(key);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}
