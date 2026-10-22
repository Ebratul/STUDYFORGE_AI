import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { Prisma, type AnalysisStatus } from "../../generated/prisma/client.js";
import { RagAgentError, type RagAnalysisContent } from "../../clients/rag-agent.js";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { markCredentialInvalid } from "../ai/credentials.js";
import { assertWithinQuota, recordUsage } from "../ai/usage.js";
import { dataLevel as levelOf, releasedResultCount, userTopicStats, type DataLevel } from "../analytics/stats.js";
import { FEEDBACK } from "../exams/grading.js";
import { isReleased } from "../exams/release.js";
import { enqueue, RetryableJobError, type JobRow } from "../jobs/queue.js";
import { buildResultContext } from "./context.js";
import { chatBlock, hasAnalysisModel, resolveAnalysisModel, TRANSIENT_CODES } from "./model.js";
import { analysisContentSchema, type AnalysisContent, type requestAnalysisSchema } from "./schemas.js";

export type AnalysisStatusView = AnalysisStatus | "NONE";
export const DISCLAIMER = "AI-generated from your verified results. It does not change your score.";

export type AnalysisView = {
  attemptId: string;
  status: AnalysisStatusView;
  deterministic: { band: string; label: string; message: string; percentBp: number };
  content: AnalysisContent | null;
  generatedAt: string | null;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  canRetry: boolean;
  dataLevel: DataLevel;
  disclaimer: typeof DISCLAIMER;
};

/** The caller's own finalized attempt with its result; foreign ids are 404; unsubmitted → 409; unreleased → 409 {released:false}. */
async function ownedReleasedResult(userId: string, attemptId: string) {
  const attempt = await db.examAttempt.findFirst({ where: { id: attemptId, userId }, select: { id: true, status: true, examVersionId: true } });
  if (!attempt) throw Errors.notFound();
  const result = await db.examResult.findUnique({ where: { attemptId } });
  if (attempt.status === "IN_PROGRESS" || !result) throw new AppError("CONFLICT", "This attempt hasn't been submitted yet.", { status: attempt.status });
  const v = await db.examVersion.findUniqueOrThrow({ where: { id: attempt.examVersionId }, select: { releaseMode: true, closesAt: true, releaseAt: true } });
  if (!isReleased(v, clockNow())) throw new AppError("CONFLICT", "Results for this exam haven't been released yet.", { released: false });
  return result;
}

async function currentLevel(userId: string): Promise<DataLevel> {
  const [topics, n] = await Promise.all([userTopicStats(userId), releasedResultCount(userId)]);
  return levelOf(n, topics);
}

function toView(attemptId: string, result: { band: string; percentBp: number }, row: Prisma.ExamAnalysisGetPayload<object> | null, level: DataLevel): AnalysisView {
  const f = FEEDBACK[result.band as keyof typeof FEEDBACK];
  const status: AnalysisStatusView = row?.status ?? "NONE";
  return {
    attemptId,
    status,
    deterministic: { band: result.band, label: f.label, message: f.message, percentBp: result.percentBp },
    content: status === "READY" ? ((row?.content as AnalysisContent | null) ?? null) : null,
    generatedAt: row?.generatedAt?.toISOString() ?? null,
    provider: row?.provider ? row.provider.toLowerCase() : null,
    model: row?.model ?? null,
    errorCode: status === "FAILED" || status === "NOT_CONFIGURED" ? (row?.errorCode ?? null) : null,
    canRetry: status === "FAILED" || status === "NOT_CONFIGURED" || status === "NONE",
    dataLevel: level,
    disclaimer: DISCLAIMER,
  };
}

export async function getAnalysisView(user: SessionUser, attemptId: string): Promise<AnalysisView> {
  const result = await ownedReleasedResult(user.id, attemptId);
  const row = await db.examAnalysis.findUnique({ where: { resultId: result.id } });
  return toView(attemptId, result, row, await currentLevel(user.id));
}

const jobOptions = () => ({ maxAttempts: getEnv().ANALYSIS_MAX_ATTEMPTS });

/** Re-queues the (single) analysis row for a result. Never creates a second row. */
async function queueAnalysis(resultId: string, userId: string): Promise<void> {
  await db.examAnalysis.upsert({
    where: { resultId },
    create: { resultId, userId, status: "PENDING" },
    update: { status: "PENDING", attempts: 0, errorCode: null },
  });
  await enqueue(db, { type: "exam.analysis", payload: { resultId }, dedupeKey: `exam-analysis:${resultId}`, ...jobOptions() });
}

export async function requestAnalysis(user: SessionUser, attemptId: string, body: z.infer<typeof requestAnalysisSchema>): Promise<AnalysisView> {
  const result = await ownedReleasedResult(user.id, attemptId);
  await enforceRateLimit({ key: `analysis-retry:${user.id}`, limit: getEnv().ANALYSIS_RETRY_PER_HOUR, windowSec: 3600 });
  const existing = await db.examAnalysis.findUnique({ where: { resultId: result.id } });
  const level = await currentLevel(user.id);
  const keep = existing && ((existing.status === "READY" && !body.regenerate) || existing.status === "PENDING");
  if (!keep) {
    if (!(await hasAnalysisModel(user.id))) {
      const row = await db.examAnalysis.upsert({
        where: { resultId: result.id },
        create: { resultId: result.id, userId: user.id, status: "NOT_CONFIGURED", errorCode: "NOT_CONFIGURED" },
        update: { status: "NOT_CONFIGURED", errorCode: "NOT_CONFIGURED", attempts: 0 },
      });
      return toView(attemptId, result, row, level);
    }
    await queueAnalysis(result.id, user.id);
    await recordAudit({ actorId: user.id, action: "analysis.requested", targetType: "attempt", targetId: attemptId, metadata: { regenerate: Boolean(body.regenerate) } });
  }
  const row = await db.examAnalysis.findUnique({ where: { resultId: result.id } });
  return toView(attemptId, result, row, level);
}

/**
 * Automatic path: called after a result is finalized (IMMEDIATE) or released (release job / sweeper). Creates the PENDING row and the job
 * only when the user has automatic feedback enabled AND a usable model. Never throws and never changes anything about the result.
 */
export async function scheduleAutoAnalysis(resultId: string): Promise<boolean> {
  try {
    const result = await db.examResult.findUnique({ where: { id: resultId }, select: { id: true, userId: true, examVersionId: true } });
    if (!result) return false;
    const [pref, v, existing] = await Promise.all([
      db.userPreference.findUnique({ where: { userId: result.userId }, select: { autoAiFeedback: true } }),
      db.examVersion.findUnique({ where: { id: result.examVersionId }, select: { releaseMode: true, closesAt: true, releaseAt: true } }),
      db.examAnalysis.findUnique({ where: { resultId }, select: { id: true } }),
    ]);
    if (existing || !v || !isReleased(v, clockNow())) return false;
    if (pref && !pref.autoAiFeedback) return false;
    if (!(await hasAnalysisModel(result.userId))) return false;
    try {
      await db.examAnalysis.create({ data: { resultId, userId: result.userId, status: "PENDING" } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false; // another path created it first
      throw err;
    }
    await enqueue(db, { type: "exam.analysis", payload: { resultId }, dedupeKey: `exam-analysis:${resultId}`, ...jobOptions() });
    return true;
  } catch (err) {
    logger.error("analysis.schedule_failed", { resultId, err });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Output verification (defence in depth on top of rag_agent's own checks)
// ---------------------------------------------------------------------------------------------------------------------
export function verifyAnalysis(raw: RagAnalysisContent, b: { topicNames: Set<string>; weak: Set<string>; strong: Set<string> }): AnalysisContent | null {
  const parsed = analysisContentSchema.safeParse({ summary: raw.summary, strengths: raw.strengths, weaknesses: raw.weaknesses, nextSteps: raw.nextSteps ?? raw.next_steps, caveats: raw.caveats });
  if (!parsed.success) return null;
  const c = parsed.data;
  if (c.strengths.some((s) => !b.strong.has(s.topic))) return null; // the model may only pick topics the data supports
  if (c.weaknesses.some((w) => !b.weak.has(w.topic))) return null;
  if (c.nextSteps.some((s) => s.topic !== null && !b.topicNames.has(s.topic))) return null;
  return c;
}

type FailureClass = { code: string; transient: boolean; message: string };
export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof RagAgentError) {
    const code = err.code === "GENERATION_FAILED" ? (err.reason ?? "INVALID_OUTPUT") : err.code;
    return { code, transient: TRANSIENT_CODES.has(err.code), message: err.message };
  }
  if (err instanceof AppError) return { code: err.code, transient: false, message: err.message };
  return { code: "INTERNAL", transient: false, message: "Unexpected error" };
}

async function settle(resultId: string, data: Prisma.ExamAnalysisUpdateManyMutationInput): Promise<void> {
  await db.examAnalysis.updateMany({ where: { resultId, status: "PENDING" }, data });
}

/** Job `exam.analysis` (PART5_SPEC §3.1). Idempotent: only a PENDING row is ever written; a READY row is left alone. */
export async function runAnalysisJob(rag: RagAgentClient, job: JobRow, signal?: AbortSignal): Promise<void> {
  const resultId = (job.payload as { resultId?: unknown } | null)?.resultId;
  if (typeof resultId !== "string" || !resultId) return; // malformed payload: nothing to do (and nothing to retry)
  const result = await db.examResult.findUnique({ where: { id: resultId }, select: { id: true, userId: true } });
  if (!result) return;
  let row = await db.examAnalysis.findUnique({ where: { resultId } });
  if (!row) row = await db.examAnalysis.create({ data: { resultId, userId: result.userId, status: "PENDING" } });
  if (row.status !== "PENDING") return; // already settled by an earlier run
  await db.examAnalysis.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });

  try {
    await assertWithinQuota({ id: result.userId });
    const model = await resolveAnalysisModel(result.userId);
    let bundle;
    try {
      bundle = await buildResultContext(resultId);
    } catch (err) {
      if (err instanceof AppError && err.details?.released === false) {
        await db.examAnalysis.deleteMany({ where: { resultId, status: "PENDING" } }); // nothing to analyse yet; the release path will schedule it
        return;
      }
      throw err;
    }
    let res;
    try {
      res = await rag.analyzeResult({ request_id: randomUUID(), chat: chatBlock(model), context: bundle.context }, signal);
    } catch (err) {
      if (err instanceof RagAgentError && err.code === "PROVIDER_AUTH_INVALID") await markCredentialInvalid(model.credentialId);
      throw err;
    }
    await recordUsage(result.userId, { provider: model.provider, model: model.modelId, task: "ANALYSIS", promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, requests: res.usage.llm_calls || 1 });
    const content = verifyAnalysis(res.result, bundle);
    if (!content) {
      await settle(resultId, { status: "FAILED", errorCode: "INVALID_OUTPUT", provider: model.provider, model: model.modelId });
      return;
    }
    await settle(resultId, {
      status: "READY", content: content as unknown as Prisma.InputJsonValue, provider: model.provider, model: model.modelId,
      promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, errorCode: null, generatedAt: clockNow(),
    });
  } catch (err) {
    const f = classifyFailure(err);
    if (f.code === "NOT_CONFIGURED") return void (await settle(resultId, { status: "NOT_CONFIGURED", errorCode: "NOT_CONFIGURED" }));
    if (f.transient && job.attempts < job.maxAttempts) {
      await db.examAnalysis.updateMany({ where: { resultId, status: "PENDING" }, data: { errorCode: f.code } });
      throw new RetryableJobError(f.code, err instanceof RagAgentError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : undefined);
    }
    if (f.code === "INTERNAL") logger.error("analysis.job_failed", { resultId, err });
    await settle(resultId, { status: "FAILED", errorCode: f.code });
  }
}
