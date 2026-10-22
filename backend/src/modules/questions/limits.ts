import { getEnv } from "../../config/env.js";

/** Field limits (constants) and run/bank limits (env). The frontend reads both from GET /api/questions/limits. */
export const FIELD = {
  stem: 2000,
  option: 500,
  optionsMin: 2,
  optionsMax: 6,
  explanation: 2000,
  shortNote: 600,
  stimulus: 3000,
  partPrompt: 1000,
  answer: 4000,
  partsMax: 6,
  topic: 120,
  subject: 120,
  tag: 40,
  tagsMax: 10,
  quote: 1000,
  title: 120,
  description: 500,
  marksMax: 100,
  avoidMax: 60,
  avoidChars: 300,
} as const;

export function questionLimits() {
  const e = getEnv();
  // Keys are the camel-cased environment variable names (see docs/PART3_SPEC.md §2).
  return {
    mcqMaxQuestionsPerRun: e.MCQ_MAX_QUESTIONS_PER_RUN,
    cqMaxQuestionsPerRun: e.CQ_MAX_QUESTIONS_PER_RUN,
    genTopicMaxChars: e.GEN_TOPIC_MAX_CHARS,
    genTextMaxChars: e.GEN_TEXT_MAX_CHARS,
    genMaxDocuments: e.GEN_MAX_DOCUMENTS,
    genMaxContextChars: e.GEN_MAX_CONTEXT_CHARS,
    genBatchSizeMcq: e.GEN_BATCH_SIZE_MCQ,
    genBatchSizeCq: e.GEN_BATCH_SIZE_CQ,
    genMaxLlmCalls: e.GEN_MAX_LLM_CALLS,
    genMaxOutputTokens: e.GEN_MAX_OUTPUT_TOKENS,
    genTimeoutMs: e.GEN_TIMEOUT_MS,
    genRatePerMinute: e.GEN_RATE_PER_MINUTE,
    questionMaxPerUser: e.QUESTION_MAX_PER_USER,
    collectionMaxPerUser: e.COLLECTION_MAX_PER_USER,
    collectionMaxQuestions: e.COLLECTION_MAX_QUESTIONS,
    saveBatchMax: e.SAVE_BATCH_MAX,
    runRetentionDays: e.RUN_RETENTION_DAYS,
    exportMaxQuestions: 500,
    bulkMaxIds: 200,
  } as const;
}
