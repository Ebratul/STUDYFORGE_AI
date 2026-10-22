import type { TopicStat } from "./stats.js";

export type StepType = "REVIEW_NOTES" | "REVISIT_QUESTIONS" | "PRACTICE_MCQ" | "PRACTICE_CQ" | "COMPARE_ATTEMPTS" | "ASK_ASSISTANT" | "READ_DOCUMENT";
export type Suggestion = { type: StepType; topic: string | null; label: string; href: string; reason: string };

export const MAX_SUGGESTIONS = 6;
const GENERAL = "General";

const q = (topic: string) => encodeURIComponent(topic);
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;

/**
 * Deterministic, data-driven suggestions (no AI): same inputs ⇒ same output. Only topics with enough answered questions are called weak
 * (the caller passes `weak` already filtered by the §1 rules). The generic "General" bucket has no topic filter to link to.
 */
export function buildSuggestions(weak: TopicStat[], compare: { examId: string; title: string }[]): Suggestion[] {
  const out: Suggestion[] = [];
  const topics = weak.slice(0, 2);
  for (const t of topics) {
    const reason = `${t.correct} of ${t.questions} correct (${pct(t.accuracyBp)})`;
    const tq = t.topic === GENERAL ? "" : `?topic=${q(t.topic)}`;
    out.push({ type: "REVIEW_NOTES", topic: t.topic, label: `Review your notes on ${t.topic}`, href: `/question-bank${tq}`, reason });
    out.push({ type: "PRACTICE_MCQ", topic: t.topic, label: `Practice MCQs on ${t.topic}`, href: t.topic === GENERAL ? "/mcq" : `/mcq?topic=${q(t.topic)}&grounding=GENERAL`, reason });
  }
  const first = weak[0];
  if (first) {
    out.push({ type: "PRACTICE_CQ", topic: first.topic, label: `Try creative questions on ${first.topic}`, href: first.topic === GENERAL ? "/cq" : `/cq?topic=${q(first.topic)}`, reason: `${first.topic} is your weakest topic so far` });
    out.push({ type: "ASK_ASSISTANT", topic: first.topic, label: "Ask the study assistant to explain what you missed", href: "/chat", reason: "Get explanations for the questions you got wrong" });
  }
  const c = compare[0];
  if (c) out.push({ type: "COMPARE_ATTEMPTS", topic: null, label: `Compare your attempts on ${c.title}`, href: `/exams/${c.examId}`, reason: "You have more than one result for this exam" });
  return out.slice(0, MAX_SUGGESTIONS);
}
