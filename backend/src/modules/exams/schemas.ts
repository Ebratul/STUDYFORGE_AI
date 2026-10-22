import { z } from "zod";
import { getEnv } from "../../config/env.js";
import { cleanText } from "../questions/text.js";
import { EXAM_FIELDS } from "./limits.js";

export const EXAM_MODES = ["INDIVIDUAL", "GROUP"] as const;
export const REVIEW_POLICIES = ["NONE", "CORRECTNESS", "FULL"] as const;
export const RELEASE_MODES = ["IMMEDIATE", "AFTER_CLOSE", "AT_TIME"] as const;
export const LATE_STARTS = ["CAP_AT_CLOSE", "FULL_TIME_ONLY"] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

const reqStr = (max: number, what: string) =>
  z
    .string({ error: `Enter ${what}.` })
    .transform(cleanText)
    .pipe(z.string().min(1, `Enter ${what}.`).max(max, `Use at most ${max} characters.`));
const optStr = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null ? null : cleanText(v) || null))
    .pipe(z.string().max(max, `Use at most ${max} characters.`).nullable());

const id = z.string().min(1).max(64);
const marks = z
  .number({ error: "Enter a number." })
  .finite()
  .min(EXAM_FIELDS.marksMin, `Marks must be at least ${EXAM_FIELDS.marksMin}.`)
  .max(EXAM_FIELDS.marksMax, `Use at most ${EXAM_FIELDS.marksMax}.`)
  .transform(round2);
const isoDate = z.iso.datetime({ offset: true, error: "Enter a valid date and time." }).transform((s) => new Date(s).toISOString());
const optDate = isoDate.nullish().transform((v) => v ?? null);
const fraction = z
  .number({ error: "Enter a number." })
  .min(0, "Use a value between 0 and 1.")
  .max(1, "Use a value between 0 and 1.")
  .refine((f) => Math.abs(f * 10_000 - Math.round(f * 10_000)) < 1e-6, "Use at most 4 decimals.");

export const createExamSchema = z.strictObject({
  title: reqStr(EXAM_FIELDS.title, "a title"),
  description: optStr(EXAM_FIELDS.description),
  mode: z.enum(EXAM_MODES),
  groupId: id.optional(),
});

/** The editable exam configuration (PART4_SPEC §3). Limits come from the environment at parse time. */
export function examDraftSchema() {
  const env = getEnv();
  return z
    .strictObject({
      title: reqStr(EXAM_FIELDS.title, "a title"),
      description: optStr(EXAM_FIELDS.description),
      questionIds: z
        .array(id)
        .max(env.EXAM_MAX_QUESTIONS, `An exam can have up to ${env.EXAM_MAX_QUESTIONS} questions.`)
        .default([]),
      marks: z.strictObject({ perQuestion: marks.default(1), overrides: z.record(id, marks).default({}) }).default({ perQuestion: 1, overrides: {} }),
      negativeMarking: z.strictObject({ fraction: fraction.default(0) }).default({ fraction: 0 }),
      durationMinutes: z
        .number({ error: "Enter the duration in minutes." })
        .int("Use whole minutes.")
        .min(1, "The duration must be at least 1 minute.")
        .max(env.EXAM_MAX_DURATION_MINUTES, `The duration can be at most ${env.EXAM_MAX_DURATION_MINUTES} minutes.`)
        .default(30),
      attemptLimit: z.number().int().min(1, "Allow at least 1 attempt.").max(env.EXAM_MAX_ATTEMPT_LIMIT, `Allow at most ${env.EXAM_MAX_ATTEMPT_LIMIT} attempts.`).default(1),
      window: z.strictObject({ opensAt: optDate, closesAt: optDate }).default({ opensAt: null, closesAt: null }),
      lateStart: z.enum(LATE_STARTS).default("CAP_AT_CLOSE"),
      lateJoinGroup: z.boolean().default(true),
      shuffleQuestions: z.boolean().default(false),
      shuffleOptions: z.boolean().default(false),
      reviewPolicy: z.enum(REVIEW_POLICIES).default("FULL"),
      release: z.strictObject({ mode: z.enum(RELEASE_MODES).default("IMMEDIATE"), at: optDate }).default({ mode: "IMMEDIATE", at: null }),
      leaderboardVisible: z.boolean().default(true),
      reminderMinutes: z.number().int().min(1).max(EXAM_FIELDS.reminderMinutesMax).nullish().transform((v) => v ?? null),
    })
    .superRefine((d, ctx) => {
      const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
      const { opensAt, closesAt } = d.window;
      if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) add(["window", "closesAt"], "The closing time must be after the opening time.");
      if (d.release.mode !== "AT_TIME" && d.release.at) add(["release", "at"], "A release time is only used with “At a set time”.");
      if (new Set(d.questionIds).size !== d.questionIds.length) add(["questionIds"], "A question can only be added once.");
      for (const qid of Object.keys(d.marks.overrides)) if (!d.questionIds.includes(qid)) add(["marks", "overrides", qid], "Marks can only be set for selected questions.");
    });
}
export type ExamDraft = z.infer<ReturnType<typeof examDraftSchema>>;

const answerItem = z.strictObject({
  questionId: id,
  optionId: id.nullable(),
  marked: z.boolean().optional(),
  seq: z.number().int().min(0).max(2_000_000_000),
});
export type AnswerItem = z.infer<typeof answerItem>;

/** Clients send option identifiers only: any score/correct/percentage field is rejected by the strict schema. */
export const saveAnswersSchema = z.strictObject({ answers: z.array(answerItem).min(1, "Send at least one answer.").max(50, "Send at most 50 answers at a time.") });
export const submitSchema = z.strictObject({ answers: z.array(answerItem).max(50).optional() });

export const listExamsSchema = z.object({
  scope: z.enum(["mine", "available", "history"]).default("mine"),
  status: z.enum(["DRAFT", "PUBLISHED", "CANCELLED"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const listAttemptsSchema = z.object({
  status: z.enum(["IN_PROGRESS", "SUBMITTED", "TIMED_OUT"]).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
