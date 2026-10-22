import { randomUUID } from "node:crypto";
import { Prisma, type AnalysisStatus } from "../../generated/prisma/client.js";
import type { RagAgentClient, RagPlanContent } from "../../clients/rag-agent.js";
import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { markCredentialInvalid } from "../ai/credentials.js";
import { assertWithinQuota, recordUsage } from "../ai/usage.js";
import { planFingerprint, releasedSql, type DataLevel, type TopicStat } from "../analytics/stats.js";
import { enqueue, RetryableJobError, type JobRow } from "../jobs/queue.js";
import { buildPlanContext, loadPlanData, userLocale, type PlanData } from "./context.js";
import { chatBlock, hasAnalysisModel, resolveAnalysisModel } from "./model.js";
import { planContentSchema, type PlanContent, type StepType } from "./schemas.js";
import { classifyFailure } from "./service.js";
import { RagAgentError } from "../../clients/rag-agent.js";

export type Suggestion = { type: StepType; topic: string | null; label: string; reason: string; href: string | null; assistant: { kind: "REVISION_PLAN" } | null };
export type PlanView = {
  id: string;
  status: AnalysisStatus;
  label: "INITIAL_SUGGESTIONS" | "BASED_ON_HISTORY";
  content: PlanContent | null;
  basis: { results: number; topics: number; answered: number };
  generatedAt: string | null;
  errorCode: string | null;
  stale: boolean;
  canRetry: boolean;
};

export const INITIAL_CAVEAT = "These are initial suggestions based on limited data. A single exam can't show mastery or long-term progress, so treat them as a starting point.";
const enc = encodeURIComponent;
const bankHref = (topic: string) => (topic === "General" ? "/question-bank" : `/question-bank?topic=${enc(topic)}`);

/** Suggestions built by code from the verified numbers — always available, never AI. */
export async function deterministicSuggestions(userId: string, d: PlanData): Promise<Suggestion[]> {
  if (d.level === "NONE") return [];
  const out: Suggestion[] = [];
  for (const t of d.weak.slice(0, 5)) {
    const ratio = `${t.correct} of ${t.questions} correct`;
    out.push({ type: "REVIEW_NOTES", topic: t.topic, label: `Review your notes on ${t.topic}`, reason: `${ratio} so far.`, href: bankHref(t.topic), assistant: null });
    out.push({ type: "REVISIT_QUESTIONS", topic: t.topic, label: `Retry saved questions on ${t.topic}`, reason: `${ratio} so far.`, href: bankHref(t.topic), assistant: null });
    out.push({ type: "PRACTICE_MCQ", topic: t.topic, label: `Generate a focused practice set on ${t.topic}`, reason: `${ratio} so far.`, href: `/mcq?topic=${enc(t.topic)}&grounding=GENERAL`, assistant: null });
  }
  if (d.weak.length) out.push({ type: "ASK_ASSISTANT", topic: null, label: "Ask the study assistant for a revision plan", reason: "Uses your weak topics.", href: null, assistant: { kind: "REVISION_PLAN" } });
  const repeated = await db.$queryRaw<{ examId: string; title: string }[]>(Prisma.sql`
    SELECT v."examId", max(v."title") AS "title" FROM "ExamResult" r JOIN "ExamVersion" v ON v."id" = r."examVersionId"
    WHERE r."userId" = ${userId} AND ${releasedSql()} GROUP BY v."examId" HAVING count(*) >= 2 ORDER BY max(r."finalizedAt") DESC LIMIT 1`);
  if (repeated[0]) out.push({ type: "COMPARE_ATTEMPTS", topic: null, label: `Compare your attempts on “${repeated[0].title}”`, reason: "You've taken this exam more than once.", href: `/exams/${repeated[0].examId}`, assistant: null });
  return out.slice(0, 15);
}

const basisOf = (d: PlanData) => ({ results: d.resultCount, topics: d.topics.length, answered: d.topics.reduce((n, t) => n + t.questions, 0) });
const labelOf = (level: DataLevel): PlanView["label"] => (level === "BASED_ON_HISTORY" ? "BASED_ON_HISTORY" : "INITIAL_SUGGESTIONS");
const fingerprintOf = (d: PlanData, locale: string) => planFingerprint(d.topics, d.percents, locale);

function planView(row: Prisma.StudyPlanGetPayload<object>, level: DataLevel, currentFingerprint: string): PlanView {
  const basis = (row.basis as PlanView["basis"] | null) ?? { results: 0, topics: 0, answered: 0 };
  return {
    id: row.id,
    status: row.status,
    label: labelOf(level),
    content: row.status === "READY" ? ((row.content as PlanContent | null) ?? null) : null,
    basis,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    errorCode: row.status === "FAILED" || row.status === "NOT_CONFIGURED" ? row.errorCode : null,
    stale: row.fingerprint !== currentFingerprint,
    canRetry: row.status === "FAILED" || row.status === "NOT_CONFIGURED",
  };
}

export async function getPlanState(user: SessionUser) {
  const [d, locale] = await Promise.all([loadPlanData(user.id), userLocale(user.id)]);
  const fingerprint = fingerprintOf(d, locale);
  const [latest, suggestions] = await Promise.all([db.studyPlan.findFirst({ where: { userId: user.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }), deterministicSuggestions(user.id, d)]);
  const plan = latest ? planView(latest, d.level, fingerprint) : null;
  const strip = (t: TopicStat) => ({ topic: t.topic, questions: t.questions, correct: t.correct, incorrect: t.incorrect, unanswered: t.unanswered, accuracyBp: t.accuracyBp });
  return {
    dataLevel: d.level,
    label: labelOf(d.level),
    resultCount: d.resultCount,
    weakTopics: d.weak.map(strip),
    strongTopics: d.strong.map(strip),
    notEnoughData: d.notEnough.map(strip),
    suggestions,
    emptyState: d.level === "NONE" ? "Complete an exam and wait for its results to be released: your plan is built from your real results." : null,
    plan,
    canGenerate: d.level !== "NONE" && (!plan || plan.stale || plan.canRetry),
  };
}

export async function requestPlan(user: SessionUser) {
  const d = await loadPlanData(user.id);
  if (d.level === "NONE") throw new AppError("CONFLICT", "You need at least one released exam result to build a plan.", { dataLevel: "NONE" });
  await enforceRateLimit({ key: `plan-request:${user.id}`, limit: getEnv().ANALYSIS_RETRY_PER_HOUR, windowSec: 3600 });
  const locale = await userLocale(user.id);
  const fingerprint = fingerprintOf(d, locale);
  const existing = await db.studyPlan.findUnique({ where: { userId_fingerprint: { userId: user.id, fingerprint } } });
  const configured = await hasAnalysisModel(user.id);
  let row = existing;
  if (!existing) {
    row = await db.studyPlan.create({ data: { userId: user.id, fingerprint, status: configured ? "PENDING" : "NOT_CONFIGURED", errorCode: configured ? null : "NOT_CONFIGURED", basis: basisOf(d) } });
    await pruneOldPlans(user.id);
  } else if (existing.status === "FAILED" || existing.status === "NOT_CONFIGURED") {
    row = await db.studyPlan.update({ where: { id: existing.id }, data: { status: configured ? "PENDING" : "NOT_CONFIGURED", errorCode: configured ? null : "NOT_CONFIGURED", attempts: 0 } });
  }
  if (row && row.status === "PENDING") await enqueue(db, { type: "study-plan", payload: { planId: row.id }, dedupeKey: `study-plan:${row.id}`, maxAttempts: getEnv().ANALYSIS_MAX_ATTEMPTS });
  await recordAudit({ actorId: user.id, action: "analysis.requested", targetType: "study-plan", targetId: row!.id });
  return planView(row!, d.level, fingerprint);
}

async function pruneOldPlans(userId: string): Promise<void> {
  const keep = getEnv().STUDY_PLAN_MAX_PER_USER;
  const old = await db.studyPlan.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: keep, select: { id: true } });
  if (old.length) await db.studyPlan.deleteMany({ where: { id: { in: old.map((p) => p.id) }, userId } });
}

export function verifyPlan(raw: RagPlanContent, d: PlanData): PlanContent | null {
  const parsed = planContentSchema.safeParse({ headline: raw.headline, focus: raw.focus, steps: raw.steps.map((s) => ({ ...s, minutes: s.minutes ?? null })), caveats: raw.caveats });
  if (!parsed.success) return null;
  const names = new Set(d.topics.map((t) => t.topic));
  const c = parsed.data;
  if (c.focus.some((f) => !names.has(f.topic))) return null;
  if (c.steps.some((s) => s.topic !== null && !names.has(s.topic))) return null;
  // The "initial suggestions" caveat is a code-owned guarantee, not something the model may omit.
  if (d.level !== "BASED_ON_HISTORY" && !c.caveats.includes(INITIAL_CAVEAT)) c.caveats = [INITIAL_CAVEAT, ...c.caveats].slice(0, 4);
  return c;
}

/** Job `study-plan` (mirrors exam.analysis: bounded retries, NOT_CONFIGURED/quota are final, idempotent on a PENDING row only). */
export async function runPlanJob(rag: RagAgentClient, job: JobRow, signal?: AbortSignal): Promise<void> {
  const planId = (job.payload as { planId?: unknown } | null)?.planId;
  if (typeof planId !== "string" || !planId) return; // malformed payload: nothing to do (and nothing to retry)
  const row = await db.studyPlan.findUnique({ where: { id: planId } });
  if (!row || row.status !== "PENDING") return;
  await db.studyPlan.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
  const settle = (data: Prisma.StudyPlanUpdateManyMutationInput) => db.studyPlan.updateMany({ where: { id: planId, status: "PENDING" }, data });
  try {
    await assertWithinQuota({ id: row.userId });
    const model = await resolveAnalysisModel(row.userId);
    const d = await loadPlanData(row.userId);
    if (d.level === "NONE") return void (await settle({ status: "FAILED", errorCode: "NO_DATA" }));
    let res;
    try {
      res = await rag.analyzePlan({ request_id: randomUUID(), chat: chatBlock(model), context: buildPlanContext(d, await userLocale(row.userId)) }, signal);
    } catch (err) {
      if (err instanceof RagAgentError && err.code === "PROVIDER_AUTH_INVALID") await markCredentialInvalid(model.credentialId);
      throw err;
    }
    await recordUsage(row.userId, { provider: model.provider, model: model.modelId, task: "ANALYSIS", promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, requests: res.usage.llm_calls || 1 });
    const content = verifyPlan(res.result, d);
    if (!content) return void (await settle({ status: "FAILED", errorCode: "INVALID_OUTPUT", provider: model.provider, model: model.modelId }));
    await settle({
      status: "READY", content: content as unknown as Prisma.InputJsonValue, provider: model.provider, model: model.modelId,
      promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, errorCode: null, generatedAt: clockNow(),
    });
  } catch (err) {
    const f = classifyFailure(err);
    if (f.code === "NOT_CONFIGURED") return void (await settle({ status: "NOT_CONFIGURED", errorCode: "NOT_CONFIGURED" }));
    if (f.transient && job.attempts < job.maxAttempts) {
      await db.studyPlan.updateMany({ where: { id: planId, status: "PENDING" }, data: { errorCode: f.code } });
      throw new RetryableJobError(f.code, err instanceof RagAgentError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : undefined);
    }
    if (f.code === "INTERNAL") logger.error("plan.job_failed", { planId, err });
    await settle({ status: "FAILED", errorCode: f.code });
  }
}
