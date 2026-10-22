import type { AnalyzePlanRequest, AnalyzeResponse, AnalyzeResultRequest, RagAnalysisContent, RagPlanContent } from "../../src/clients/rag-agent.js";

/** Deterministic, GROUNDED stand-in for rag_agent's analysis output: it only quotes numbers and topics present in the context. */
export function defaultAnalyzeResult(req: AnalyzeResultRequest): AnalyzeResponse<RagAnalysisContent> {
  const c = req.context;
  const weak = c.topics.filter((t) => c.weak_topics.includes(t.topic));
  const strong = c.topics.filter((t) => c.strong_topics.includes(t.topic));
  return {
    result: {
      summary: `You answered ${c.exam.correct} of ${c.exam.question_count} questions correctly.`,
      strengths: strong.slice(0, 4).map((t) => ({ topic: t.topic, detail: `Solid work on ${t.topic}.` })),
      weaknesses: weak.slice(0, 4).map((t) => ({ topic: t.topic, detail: `${t.topic} needs another look.`, evidence: `${t.correct} of ${t.questions} correct` })),
      next_steps: [
        { type: "REVIEW_NOTES", topic: weak[0]?.topic ?? null, text: "Re-read the short notes for the questions you missed." },
        { type: "PRACTICE_MCQ", topic: weak[0]?.topic ?? null, text: "Try a short practice set." },
      ],
      caveats: c.history.data_level === "BASED_ON_HISTORY" ? [] : ["This is based on very little data, so treat it as an initial suggestion."],
    },
    usage: { prompt_tokens: 120, completion_tokens: 60, llm_calls: 1 },
    warnings: [],
  };
}

export function defaultAnalyzePlan(req: AnalyzePlanRequest): AnalyzeResponse<RagPlanContent> {
  const c = req.context;
  const weak = c.topics.filter((t) => c.weak_topics.includes(t.topic));
  return {
    result: {
      headline: weak.length ? `Focus on ${weak[0]!.topic} first.` : "Keep practising across your topics.",
      focus: weak.slice(0, 5).map((t) => ({ topic: t.topic, reason: `${t.correct} of ${t.questions} correct so far.` })),
      steps: [
        { type: "REVIEW_NOTES", topic: weak[0]?.topic ?? null, text: "Review your notes.", minutes: 20 },
        { type: "PRACTICE_MCQ", topic: weak[0]?.topic ?? null, text: "Do a focused practice set.", minutes: 15 },
      ],
      caveats: [],
    },
    usage: { prompt_tokens: 100, completion_tokens: 50, llm_calls: 1 },
    warnings: [],
  };
}
