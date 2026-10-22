import { z } from "zod";
import { cleanText } from "../questions/text.js";

export const STEP_TYPES = ["REVIEW_NOTES", "REVISIT_QUESTIONS", "PRACTICE_MCQ", "PRACTICE_CQ", "COMPARE_ATTEMPTS", "ASK_ASSISTANT", "READ_DOCUMENT"] as const;
export type StepType = (typeof STEP_TYPES)[number];

const text = (max: number) => z.string().transform(cleanText).pipe(z.string().min(1).max(max));
const topic = z.string().transform(cleanText).pipe(z.string().min(1).max(60));
const nullableTopic = topic.nullable();

/** Backend re-validation of what rag_agent returned (PART5_SPEC §3.1). Strict: unknown keys are errors. */
export const analysisContentSchema = z.strictObject({
  summary: text(600),
  strengths: z.array(z.strictObject({ topic, detail: text(300) })).max(4),
  weaknesses: z.array(z.strictObject({ topic, detail: text(300), evidence: text(200) })).max(4),
  nextSteps: z.array(z.strictObject({ type: z.enum(STEP_TYPES), topic: nullableTopic, text: text(300) })).min(1).max(5),
  caveats: z.array(text(250)).max(3),
});
export type AnalysisContent = z.infer<typeof analysisContentSchema>;

export const planContentSchema = z.strictObject({
  headline: text(200),
  focus: z.array(z.strictObject({ topic, reason: text(300) })).max(5),
  steps: z.array(z.strictObject({ type: z.enum(STEP_TYPES), topic: nullableTopic, text: text(300), minutes: z.number().int().min(1).max(240).nullable() })).min(1).max(5),
  caveats: z.array(text(250)).max(4),
});
export type PlanContent = z.infer<typeof planContentSchema>;

export const requestAnalysisSchema = z.strictObject({ regenerate: z.boolean().optional() });

const id = z.string().min(1).max(64);
export const sessionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("EXPLAIN_INCORRECT"), attemptId: id, questionId: id }),
  z.strictObject({ kind: z.literal("TOPIC_SUMMARY"), topic: z.string().transform(cleanText).pipe(z.string().min(1).max(60)), documentIds: z.array(id).min(1).max(50) }),
  z.strictObject({ kind: z.literal("REVISION_PLAN") }),
  z.strictObject({ kind: z.literal("PRACTICE_QUESTIONS"), topic: z.string().transform(cleanText).pipe(z.string().min(1).max(60)) }),
  z.strictObject({ kind: z.literal("RELATED_CQ"), topic: z.string().transform(cleanText).pipe(z.string().min(1).max(60)) }),
]);
export type SessionInput = z.infer<typeof sessionSchema>;
