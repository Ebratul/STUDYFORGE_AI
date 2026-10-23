import { randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AiProvider, Prisma } from "../../generated/prisma/client.js";
import { RagAgentError, type GenerateEvent, type GenerateRequest, type GenerateResult, type RagAnswer, type RagQuestion, type RagSource, type RagAgentClient } from "../../clients/rag-agent.js";
import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { parseWith } from "../../http/body.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { recordProviderEvent } from "../../lib/metrics.js";
import { recordAudit } from "../../lib/audit.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { getDecryptedKey, markCredentialInvalid } from "../ai/credentials.js";
import { getModels } from "../ai/models.js";
import { EXPECTED_DIMENSION, guidanceFor, isCompatible, STALE_DOCUMENTS_MESSAGE } from "../ai/embedding-identity.js";
import { resolveModel } from "../ai/preferences.js";
import { fromWire, toWire } from "../ai/providers.js";
import { assertWithinQuota, recordUsage } from "../ai/usage.js";
import { buildContent } from "./content.js";
import { FIELD } from "./limits.js";
import {
  cqSettingsSchema, isNearDuplicate, mcqSettingsSchema, normalizeInput, questionInputSchema, regenerateSchema, resolvePartMarks, stimulusFor,
  type CqSettings, type McqSettings,
} from "./schemas.js";
import { cleanText } from "./text.js";
import type { AnswerObj, QuestionDraft, RunKind, RunStatus, RunView, SourceRef } from "./types.js";

type Settings = McqSettings | CqSettings;
type RegenerateBody = z.infer<typeof regenerateSchema>;

export type SseEvent = { event: string; data: unknown };
const STALE_RUN_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------------
// Failures from rag_agent / the provider, normalised
// ---------------------------------------------------------------------------------------------------------------------
class GenFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false, public readonly retryAfter: number | null = null, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

function failureFrom(err: unknown): GenFailure {
  if (err instanceof GenFailure) return err;
  if (err instanceof RagAgentError) return new GenFailure(err.code, err.message, err.retryable, err.retryAfterSeconds);
  logger.error("generation.failed", { err });
  return new GenFailure("INTERNAL", "Something went wrong while generating questions.", true);
}

function toAppError(f: GenFailure): AppError {
  if (f.code === "PROVIDER_RATE_LIMITED") return new AppError("RATE_LIMITED", f.message, { retryAfterSec: f.retryAfter ?? 5 });
  if (f.code === "GENERATION_FAILED") return new AppError("GENERATION_FAILED", f.message, f.details);
  if (f.code === "UPSTREAM_UNAVAILABLE") return new AppError("UPSTREAM_UNAVAILABLE", f.message);
  return new AppError("PROVIDER_ERROR", f.message, { providerCode: f.code, retryable: f.retryable });
}

const parseSettings = (kind: RunKind, raw: unknown): Settings => (kind === "MCQ" ? parseWith(mcqSettingsSchema(), raw) : parseWith(cqSettingsSchema(), raw));

// ---------------------------------------------------------------------------------------------------------------------
// Context: model, credentials, documents, embedding
// ---------------------------------------------------------------------------------------------------------------------
type Ctx = {
  kind: RunKind;
  settings: Settings;
  provider: AiProvider;
  modelId: string;
  key: string;
  credentialId: string;
  params: { temperature: number | null; topP: number | null; maxTokens: number | null };
  embedding: { provider: AiProvider; model: string; key: string } | null;
  contextTokens: number | null;
  docs: { id: string; name: string }[];
};

async function resolveContext(rag: RagAgentClient, user: SessionUser, kind: RunKind, settings: Settings, fixed?: { provider: AiProvider; modelId: string }): Promise<Ctx> {
  const fields: Record<string, string> = {};

  // Model: an explicit per-run choice, else the task preference, else the default. Never another provider.
  let provider: AiProvider;
  let modelId: string;
  let params = { temperature: null as number | null, topP: null as number | null, maxTokens: null as number | null };
  if (fixed) ({ provider, modelId } = fixed);
  else if (settings.model) {
    provider = fromWire(settings.model.provider);
    modelId = settings.model.modelId;
    const pref = await resolveModel(user.id, kind);
    if (pref && pref.provider === provider && pref.modelId === modelId) params = pref.params;
  } else {
    const pref = await resolveModel(user.id, kind);
    if (!pref) throw new AppError("NOT_CONFIGURED", `Choose a default model in Settings → AI connection before generating ${kind === "MCQ" ? "MCQs" : "CQs"}.`);
    ({ provider, modelId, params } = pref);
  }
  const chat = await getDecryptedKey(user.id, provider); // NOT_CONFIGURED if no key for exactly this provider

  const documentIds = settings.documentIds;
  let docs: Ctx["docs"] = [];
  let embedding: Ctx["embedding"] = null;
  if (documentIds.length) {
    const rows = await db.document.findMany({ where: { id: { in: documentIds }, ownerId: user.id }, select: { id: true, name: true, status: true, embeddingProvider: true, embeddingModel: true, embeddingDimension: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const problems: string[] = [];
    for (const id of documentIds) {
      const d = byId.get(id);
      if (!d) problems.push("One of the selected documents wasn't found.");
      else if (d.status !== "READY") problems.push(`“${d.name}” isn't ready to use yet (${d.status.toLowerCase().replace("_", " ")}).`);
    }
    if (problems.length) fields.documentIds = [...new Set(problems)].join(" ");
    else docs = documentIds.map((id) => ({ id, name: byId.get(id)!.name }));
    if (!problems.length && settings.topic) {
      // Topic + documents = retrieval, which needs the embedding model the documents were indexed with.
      const emb = await resolveModel(user.id, "EMBEDDING");
      if (!emb) throw new AppError("NOT_CONFIGURED", "Choose an embedding model in Settings → AI connection to find the topic in your documents, or clear the topic to cover the whole document.");
      const identity = { provider: emb.provider, model: emb.modelId, dimension: emb.embeddingDimension ?? EXPECTED_DIMENSION };
      if (rows.some((r) => !isCompatible(r, identity))) fields.documentIds = STALE_DOCUMENTS_MESSAGE;
      else embedding = { provider: emb.provider, model: emb.modelId, key: (await getDecryptedKey(user.id, emb.provider)).key };
    }
  }
  if (Object.keys(fields).length) throw new AppError("VALIDATION", "Some sources can't be used.", { fields });

  // Context window of the chosen model, when the provider reports it (cached model list; failure just means "unknown").
  const contextTokens = await getModels(rag, user, provider, false)
    .then((models) => models.models.find((m) => m.id === modelId)?.context_length ?? null)
    .catch(() => null);
  return { kind, settings, provider, modelId, key: chat.key, credentialId: chat.credentialId, params, embedding, contextTokens, docs };
}

function specFor(kind: RunKind, s: Settings, over?: { count?: number; difficulty?: string }): Record<string, unknown> {
  if (kind === "MCQ") {
    const m = s as McqSettings;
    return {
      count: over?.count ?? m.count, difficulty: over?.difficulty ?? m.difficulty, language: m.language, option_count: m.optionCount,
      include_explanations: m.includeExplanations, include_short_notes: m.includeShortNotes, marks: m.marks, negative_marks: m.negativeMarks, subject: m.subject ?? null,
    };
  }
  const c = s as CqSettings;
  return {
    count: over?.count ?? c.count, mode: c.mode, structure: c.structure, part_marks: resolvePartMarks(c) ?? null, total_marks: c.totalMarks, stimulus: stimulusFor(c),
    difficulty: over?.difficulty ?? c.difficulty, language: c.language, subject: c.subject ?? null,
  };
}

function buildRequest(ctx: Ctx, userId: string, over?: { count?: number; difficulty?: string; avoid?: string[] }): GenerateRequest {
  const env = getEnv();
  const s = ctx.settings;
  const cap = env.GEN_MAX_OUTPUT_TOKENS;
  return {
    request_id: randomUUID(),
    user_id: userId,
    chat: {
      provider: toWire(ctx.provider), api_key: ctx.key, model: ctx.modelId,
      params: { temperature: ctx.params.temperature, top_p: ctx.params.topP, max_output_tokens: Math.min(ctx.params.maxTokens ?? cap, cap) },
    },
    embedding: ctx.embedding ? { provider: toWire(ctx.embedding.provider), api_key: ctx.embedding.key, model: ctx.embedding.model } : null,
    context_tokens: ctx.contextTokens,
    grounding: s.grounding,
    sources: { topic: s.topic ?? null, pasted_text: s.pastedText ?? null, document_ids: ctx.docs.map((d) => d.id) },
    spec: specFor(ctx.kind, s, over),
    avoid: (over?.avoid ?? []).slice(0, FIELD.avoidMax).map((a) => a.slice(0, FIELD.avoidChars)),
    cross_check: ctx.kind === "MCQ" ? (s as McqSettings).crossCheck : false,
    limits: {
      batch_size: ctx.kind === "MCQ" ? env.GEN_BATCH_SIZE_MCQ : env.GEN_BATCH_SIZE_CQ,
      max_llm_calls: env.GEN_MAX_LLM_CALLS,
      max_context_chars: env.GEN_MAX_CONTEXT_CHARS,
      timeout_seconds: Math.max(5, Math.floor(env.GEN_TIMEOUT_MS / 1000)),
      max_regen_per_batch: 2,
    },
  };
}

/** Streams statuses and returns the terminal result; throws GenFailure otherwise. Applies the whole-run timeout. */
async function* execute(rag: RagAgentClient, ctx: Ctx, req: GenerateRequest, signal: AbortSignal): AsyncGenerator<SseEvent, GenerateResult> {
  const timeout = AbortSignal.timeout(getEnv().GEN_TIMEOUT_MS);
  const merged = AbortSignal.any([signal, timeout]);
  let result: GenerateResult | null = null;
  try {
    for await (const ev of rag.generateStream(ctx.kind.toLowerCase() as "mcq" | "cq", req, merged) as AsyncGenerator<GenerateEvent>) {
      if (ev.event === "status") yield { event: "status", data: ev.data };
      else if (ev.event === "result") result = ev.data;
      else if (ev.event === "error") {
        const reason = ev.data.reason;
        throw new GenFailure(ev.data.code, guidanceFor(ev.data.code, ev.data.message), Boolean(ev.data.retryable), ev.data.retry_after_seconds ?? null, reason ? { reason } : {});
      }
    }
  } catch (err) {
    if (timeout.aborted && !signal.aborted) throw new GenFailure("PROVIDER_TIMEOUT", "Generating took too long and was stopped. Try fewer questions or a faster model.", true);
    throw err;
  }
  if (!result) throw new GenFailure("UPSTREAM_UNAVAILABLE", "The AI service ended the response early.", true);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Result validation: the backend does not trust rag_agent output either (defence in depth)
// ---------------------------------------------------------------------------------------------------------------------
type Accept = { ctx: Ctx; authorized: Set<string>; hasPaste: boolean };

function cleanSources(list: RagSource[] | undefined, a: Accept): SourceRef[] {
  const out: SourceRef[] = [];
  for (const s of list ?? []) {
    const fromDoc = s.document_id ? a.authorized.has(s.document_id) : false;
    const fromPaste = !s.document_id && a.hasPaste;
    if (!fromDoc && !fromPaste) continue; // a source pointing at something this request was never allowed to use is dropped
    out.push({ documentName: cleanText(s.document_name).slice(0, 200) || "Document", documentId: fromDoc ? s.document_id : null, page: s.page, section: s.section ? cleanText(s.section).slice(0, 200) : null, quote: cleanText(s.quote).slice(0, FIELD.quote), quoteVerified: Boolean(s.quote_verified) });
  }
  return out;
}

function acceptAnswer(ans: RagAnswer | null | undefined, a: Accept, withAnswers: boolean): AnswerObj | null {
  if (!ans || !withAnswers) return null;
  const sources = cleanSources(ans.sources, a);
  const verified = sources.some((s) => s.quoteVerified);
  const text = cleanText(ans.text ?? "");
  const only = a.ctx.settings.grounding === "SOURCE_ONLY";
  let basis = ["SOURCE_SUPPORTED", "GENERAL_REASONING", "INSUFFICIENT_EVIDENCE"].includes(ans.basis) ? (ans.basis as AnswerObj["basis"]) : "GENERAL_REASONING";
  if (basis === "SOURCE_SUPPORTED" && !verified) basis = only ? "INSUFFICIENT_EVIDENCE" : "GENERAL_REASONING";
  if (basis === "GENERAL_REASONING" && only) basis = "INSUFFICIENT_EVIDENCE";
  if (basis === "INSUFFICIENT_EVIDENCE") return { text: "", basis, sources: [] }; // never invent text for an unsupported answer
  return { text: text.slice(0, FIELD.answer), basis, sources: basis === "SOURCE_SUPPORTED" ? sources : [] };
}

function acceptQuestion(q: RagQuestion, a: Accept): QuestionDraft | null {
  const s = a.ctx.settings;
  const withAnswers = a.ctx.kind === "MCQ" || (s as CqSettings).mode === "WITH_ANSWERS";
  const parsed = questionInputSchema.safeParse({
    kind: q.kind, language: q.language, stem: q.stem, stimulus: q.stimulus, difficulty: q.difficulty, subject: q.subject, topic: q.topic, tags: q.tags,
    options: q.options.map((o) => ({ id: o.id, text: o.text })), correctOptionId: q.correct_option_id,
    parts: q.parts.map((p) => ({ id: p.id, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks })),
    explanation: q.explanation, shortNote: q.short_note, marks: q.marks, negativeMarks: q.negative_marks,
  });
  if (!parsed.success || parsed.data.kind !== a.ctx.kind) return null;
  const n = normalizeInput(parsed.data);

  const sources = cleanSources(q.sources, a);
  const verified = sources.some((x) => x.quoteVerified);
  const partAnswers = q.parts.map((p) => acceptAnswer(p.answer, a, withAnswers));
  const answer = n.parts.length ? null : acceptAnswer(q.answer, a, withAnswers);
  const supportedAnswers = [...partAnswers, answer].filter((x): x is AnswerObj => !!x);
  const grounded = a.ctx.kind === "MCQ" ? verified : verified || supportedAnswers.some((x) => x.basis === "SOURCE_SUPPORTED");
  if (s.grounding === "SOURCE_ONLY" && !grounded) return null; // policy enforced here as well, not only in rag_agent

  const id = /^g_[A-Za-z0-9]{6,40}$/.test(q.id) ? q.id : `g_${randomBytes(8).toString("hex")}`;
  const reviewReasons = [...new Set(q.review_reasons.filter((r): r is string => typeof r === "string" && /^[A-Z_]{3,40}$/.test(r)))];
  const content = buildContent(
    n,
    { origin: "AI_GENERATED", sourceSupport: verified || supportedAnswers.some((x) => x.basis === "SOURCE_SUPPORTED") ? "SOURCE_QUOTED" : "MODEL_ONLY", reviewReasons, sources, modifiedByUser: false, partAnswers, answer },
    { options: q.options.map((o) => o.id), parts: q.parts.map((p) => p.id) },
  );
  return { id, ...content };
}

function acceptResult(ctx: Ctx, result: GenerateResult, limit: number): { drafts: QuestionDraft[]; rejected: number } {
  const accept: Accept = { ctx, authorized: new Set(ctx.docs.map((d) => d.id)), hasPaste: Boolean(ctx.settings.pastedText) };
  const drafts: QuestionDraft[] = [];
  let rejected = result.rejected;
  const norm: ReturnType<typeof normalizeInput>[] = [];
  for (const q of result.questions) {
    if (drafts.length >= limit) break;
    const d = acceptQuestion(q, accept);
    if (!d) { rejected++; continue; }
    const input = questionInputSchema.parse({
      kind: d.kind, language: d.language, stem: d.stem, stimulus: d.stimulus, difficulty: d.difficulty, tags: d.tags, options: d.options, correctOptionId: d.correctOptionId,
      parts: d.parts.map((p) => ({ id: p.id, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks })), explanation: d.explanation, shortNote: d.shortNote, marks: d.marks, negativeMarks: d.negativeMarks,
    });
    const n = normalizeInput(input);
    if (norm.some((x) => isNearDuplicate(x, n))) { rejected++; continue; }
    norm.push(n);
    drafts.push(d);
  }
  return { drafts, rejected };
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------------
type RunRow = Prisma.GenerationRunGetPayload<object>;
type StoredResult = { questions: QuestionDraft[]; rejectedCount: number; warnings: { code: string; message: string }[]; sources: RunView["sources"] };

function publicSettings(settings: unknown): RunView["settings"] {
  const { pastedText: _omit, ...rest } = settings as Record<string, unknown>;
  void _omit;
  return rest as RunView["settings"];
}

export function toRunView(r: RunRow): RunView {
  const res = (r.result ?? null) as StoredResult | null;
  return {
    id: r.id, kind: r.kind, status: r.status as RunStatus, settings: publicSettings(r.settings), provider: toWire(r.provider), model: r.model,
    questions: res?.questions ?? [], rejectedCount: res?.rejectedCount ?? 0, warnings: res?.warnings ?? [],
    usage: { promptTokens: r.promptTokens, completionTokens: r.completionTokens, llmCalls: r.llmCalls },
    sources: res?.sources ?? { topic: (r.settings as { topic?: string }).topic ?? null, pastedTextChars: ((r.settings as { pastedText?: string }).pastedText ?? "").length, documents: [] },
    errorCode: r.errorCode, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, expiresAt: r.expiresAt.toISOString(),
  };
}

export async function purgeExpiredRuns(userId: string): Promise<void> {
  await db.generationRun.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
}

async function ownedRun(userId: string, id: string): Promise<RunRow> {
  const run = await db.generationRun.findFirst({ where: { id, userId, expiresAt: { gt: new Date() } } });
  if (!run) throw Errors.notFound();
  return run;
}

export async function listRuns(user: SessionUser, q: { kind?: RunKind | undefined; limit: number }) {
  await purgeExpiredRuns(user.id);
  const rows = await db.generationRun.findMany({ where: { userId: user.id, status: "SUCCEEDED", ...(q.kind ? { kind: q.kind } : {}) }, orderBy: { createdAt: "desc" }, take: q.limit });
  return {
    items: rows.map((r) => {
      const res = r.result as StoredResult | null;
      return { id: r.id, kind: r.kind, status: r.status as RunStatus, provider: toWire(r.provider), model: r.model, createdAt: r.createdAt.toISOString(), questionCount: res?.questions.length ?? 0, topic: (r.settings as { topic?: string }).topic ?? null };
    }),
  };
}

export async function getRun(user: SessionUser, id: string): Promise<RunView> {
  return toRunView(await ownedRun(user.id, id));
}

export async function deleteRun(user: SessionUser, id: string): Promise<void> {
  const { count } = await db.generationRun.deleteMany({ where: { id, userId: user.id } });
  if (!count) throw Errors.notFound();
}

// ---------------------------------------------------------------------------------------------------------------------
// Start a run (everything that can fail *before* streaming happens here, so the client gets a normal JSON error)
// ---------------------------------------------------------------------------------------------------------------------
export type PreparedRun = { runId: string; events(signal: AbortSignal): AsyncGenerator<SseEvent> };

export async function prepareGeneration(rag: RagAgentClient, user: SessionUser, kind: RunKind, raw: unknown): Promise<PreparedRun> {
  const env = getEnv();
  const settings = parseSettings(kind, raw);
  await enforceRateLimit({ key: `gen:${user.id}`, limit: env.GEN_RATE_PER_MINUTE, windowSec: 60 });
  await assertWithinQuota(user);
  await purgeExpiredRuns(user.id);

  const running = await db.generationRun.findMany({ where: { userId: user.id, status: "RUNNING" }, select: { id: true, createdAt: true } });
  if (running.some((r) => Date.now() - r.createdAt.getTime() < STALE_RUN_MS)) throw new AppError("CONFLICT", "Questions are already being generated. Wait for that to finish or stop it first.");
  if (running.length) await db.generationRun.updateMany({ where: { id: { in: running.map((r) => r.id) } }, data: { status: "INTERRUPTED", finishedAt: new Date() } });

  const ctx = await resolveContext(rag, user, kind, settings);
  const run = await db.generationRun.create({
    data: {
      userId: user.id, kind, status: "RUNNING", settings: { ...settings, ...(kind === "CQ" ? { resolvedPartMarks: resolvePartMarks(settings as CqSettings) ?? null } : {}) } as unknown as Prisma.InputJsonValue,
      provider: ctx.provider, model: ctx.modelId, expiresAt: new Date(Date.now() + env.RUN_RETENTION_DAYS * 86_400_000),
    },
  });

  async function* events(signal: AbortSignal): AsyncGenerator<SseEvent> {
    yield { event: "run", data: { runId: run.id } };
    const req = buildRequest(ctx, user.id);
    let finished: GenerateResult | null = null;
    let failure: GenFailure | null = null;
    try {
      const it = execute(rag, ctx, req, signal);
      for (;;) {
        const step = await it.next();
        if (step.done) { finished = step.value; break; }
        yield step.value;
      }
    } catch (err) {
      failure = signal.aborted ? new GenFailure("INTERRUPTED", "Generation was stopped.") : failureFrom(err);
    }

    try {
      if (finished) {
        recordProviderEvent(toWire(ctx.provider), kind.toLowerCase(), true);
        const { drafts, rejected } = acceptResult(ctx, finished, settings.count);
        const warnings = [...finished.warnings];
        if (rejected > 0) warnings.push({ code: "SOME_REJECTED", message: `${rejected} generated question${rejected === 1 ? " was" : "s were"} rejected by validation.` });
        if (drafts.length && drafts.length < settings.count && !warnings.some((w) => w.code === "FEWER_THAN_REQUESTED")) warnings.push({ code: "FEWER_THAN_REQUESTED", message: `Only ${drafts.length} of ${settings.count} questions passed validation.` });
        await recordUsage(user.id, { provider: ctx.provider, model: ctx.modelId, task: kind, promptTokens: finished.usage.prompt_tokens, completionTokens: finished.usage.completion_tokens, requests: finished.usage.llm_calls || 1 });
        if (!drafts.length) {
          failure = new GenFailure("GENERATION_FAILED", "The model's output didn't pass validation, so nothing was kept. Try again, use a different model, or adjust the settings.", false, null, { reason: "NO_VALID_QUESTIONS" });
        } else {
          const stored: StoredResult = {
            questions: drafts, rejectedCount: rejected, warnings,
            sources: { topic: settings.topic ?? null, pastedTextChars: settings.pastedText?.length ?? 0, documents: ctx.docs },
          };
          const row = await db.generationRun.update({
            where: { id: run.id },
            data: { status: "SUCCEEDED", result: stored as unknown as Prisma.InputJsonValue, llmCalls: finished.usage.llm_calls, promptTokens: finished.usage.prompt_tokens, completionTokens: finished.usage.completion_tokens, finishedAt: new Date() },
          });
          await recordAudit({ actorId: user.id, action: "generation.completed", targetType: "generation", targetId: run.id, metadata: { kind, count: drafts.length } });
          yield { event: "result", data: { run: toRunView(row) } };
          return;
        }
      }
      if (failure) {
        if (!signal.aborted && failure.code !== "GENERATION_FAILED") recordProviderEvent(toWire(ctx.provider), kind.toLowerCase(), false, failure.code);
        if (failure.code === "PROVIDER_AUTH_INVALID") await markCredentialInvalid(ctx.credentialId);
        await db.generationRun.update({ where: { id: run.id }, data: { status: signal.aborted ? "INTERRUPTED" : "FAILED", errorCode: failure.code === "GENERATION_FAILED" ? String(failure.details.reason ?? failure.code) : failure.code, finishedAt: new Date() } });
        if (signal.aborted) return;
        yield { event: "error", data: { code: failure.code, message: failure.message, retryable: failure.retryable, retryAfter: failure.retryAfter, details: failure.details } };
      }
    } catch (err) {
      logger.error("generation.persist_failed", { err });
      yield { event: "error", data: { code: "INTERNAL", message: "Something went wrong while saving the generated questions.", retryable: true } };
    }
  }
  return { runId: run.id, events };
}

// ---------------------------------------------------------------------------------------------------------------------
// Regenerate one question of a run (JSON, not streamed)
// ---------------------------------------------------------------------------------------------------------------------
export async function regenerateQuestion(rag: RagAgentClient, user: SessionUser, runId: string, body: RegenerateBody, signal: AbortSignal): Promise<{ question: QuestionDraft }> {
  const env = getEnv();
  const run = await ownedRun(user.id, runId);
  if (run.status !== "SUCCEEDED" || !run.result) throw new AppError("CONFLICT", "That generation has no questions to regenerate.");
  const stored = run.result as unknown as StoredResult;
  const index = stored.questions.findIndex((q) => q.id === body.questionId);
  if (index === -1) throw new AppError("VALIDATION", "That question isn't part of this generation.", { fields: { questionId: "Unknown question." } });
  const old = stored.questions[index]!;

  await enforceRateLimit({ key: `gen:${user.id}`, limit: env.GEN_RATE_PER_MINUTE, windowSec: 60 });
  await assertWithinQuota(user);

  const parsedSettings = parseSettings(run.kind, { ...(run.settings as object), documentIds: await stillUsableDocs(user.id, (run.settings as { documentIds?: string[] }).documentIds ?? []) });
  const ctx = await resolveContext(rag, user, run.kind, parsedSettings, { provider: run.provider, modelId: run.model }); // the run's own model: no silent switch
  const avoid = [...(body.avoid ?? []), ...stored.questions.filter((q) => q.id !== old.id).map((q) => q.stem)];
  const req = buildRequest(ctx, user.id, { count: 1, difficulty: old.difficulty, avoid });

  let result: GenerateResult;
  try {
    const it = execute(rag, ctx, req, signal);
    let step = await it.next();
    while (!step.done) step = await it.next();
    result = step.value;
  } catch (err) {
    const f = failureFrom(err);
    if (f.code !== "GENERATION_FAILED") recordProviderEvent(toWire(ctx.provider), run.kind.toLowerCase(), false, f.code);
    if (f.code === "PROVIDER_AUTH_INVALID") await markCredentialInvalid(ctx.credentialId);
    throw toAppError(f);
  }
  recordProviderEvent(toWire(ctx.provider), run.kind.toLowerCase(), true);
  await recordUsage(user.id, { provider: ctx.provider, model: ctx.modelId, task: run.kind, promptTokens: result.usage.prompt_tokens, completionTokens: result.usage.completion_tokens, requests: result.usage.llm_calls || 1 });

  const { drafts } = acceptResult(ctx, result, 1);
  const fresh = drafts[0];
  if (!fresh) throw new AppError("GENERATION_FAILED", "The new question didn't pass validation. Try again.", { reason: "NO_VALID_QUESTIONS" });
  const replacement: QuestionDraft = { ...fresh, id: old.id };

  const latest = (await db.generationRun.findUniqueOrThrow({ where: { id: run.id } })).result as unknown as StoredResult;
  const at = latest.questions.findIndex((q) => q.id === old.id);
  if (at !== -1) latest.questions[at] = replacement;
  await db.generationRun.update({
    where: { id: run.id },
    data: { result: latest as unknown as Prisma.InputJsonValue, llmCalls: { increment: result.usage.llm_calls }, promptTokens: { increment: result.usage.prompt_tokens ?? 0 }, completionTokens: { increment: result.usage.completion_tokens ?? 0 } },
  });
  return { question: replacement };
}

async function stillUsableDocs(userId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  return (await db.document.findMany({ where: { id: { in: ids }, ownerId: userId, status: "READY" }, select: { id: true } })).map((d) => d.id);
}
