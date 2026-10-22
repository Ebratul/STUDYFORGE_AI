import type { Derived } from "./content.js";
import { normalizedFromContent } from "./content.js";
import { versionedHash, type NormalizedQuestion } from "./schemas.js";
import { cleanText } from "./text.js";
import type { AnswerObj, QuestionDraft } from "./types.js";

/**
 * Decides provenance, evidence and answer basis for content the user submits.
 * Clients can edit text; they cannot assert that something was verified. Everything here comes from the stored generation run
 * (the `draft`) or is a fixed value for user-authored content.
 */
export function deriveProvenance(n: NormalizedQuestion, draft: QuestionDraft | undefined): Derived {
  const answerFor = (text: string | null, dp: AnswerObj | null | undefined): AnswerObj | null => {
    const t = text ? cleanText(text) : "";
    if (t) {
      if (dp && cleanText(dp.text) === t) return { text: t, basis: dp.basis, sources: dp.sources };
      return { text: t, basis: "USER_PROVIDED", sources: [] };
    }
    // Keep the explicit "the sources did not support an answer" record so the state is never silently lost.
    if (dp && dp.basis === "INSUFFICIENT_EVIDENCE") return { text: "", basis: "INSUFFICIENT_EVIDENCE", sources: [] };
    return null;
  };

  if (!draft) {
    return {
      origin: "USER_AUTHORED",
      sourceSupport: "NONE",
      reviewReasons: [],
      sources: [],
      modifiedByUser: false,
      partAnswers: n.parts.map((p) => answerFor(p.answerText, null)),
      answer: answerFor(n.answerText, null),
    };
  }

  const byId = new Map(draft.parts.map((p) => [p.id, p]));
  const partAnswers = n.parts.map((p, i) => answerFor(p.answerText, (p.clientId ? byId.get(p.clientId) : undefined)?.answer ?? draft.parts[i]?.answer));
  return {
    origin: "AI_GENERATED",
    sourceSupport: draft.sourceSupport,
    reviewReasons: [...draft.reviewReasons],
    sources: draft.sources,
    modifiedByUser: versionedHash(n) !== versionedHash(normalizedFromContent(draft)),
    partAnswers,
    answer: answerFor(n.answerText, draft.answer),
  };
}
