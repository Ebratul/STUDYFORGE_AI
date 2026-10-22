import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { setClock } from "../../src/lib/clock.js";
import { db } from "../../src/lib/db.js";
import { examHandlers, sendReleaseNotices } from "../../src/modules/exams/jobs.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { ans, paper, publishedExam, started, submit } from "../helpers/exam-api.js";
import { seedPublishedExam } from "../helpers/exam-fixtures.js";
import { seedGradedResult } from "../helpers/analysis-fixtures.js";
import { client, makeApp, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";
import { withEnv } from "../helpers/with-env.js";

let t: TestApp;
beforeEach(async () => {
  t = makeApp();
  await db.job.deleteMany();
});
afterEach(() => setClock(null));

const drain = () => runDueJobs(examHandlers(t.rag));
const analysisOf = async (u: TestUser, attemptId: string) => (await (await client(t, u).get(`/api/analysis/attempts/${attemptId}`)).json()).analysis;
const forceDue = () => db.job.updateMany({ where: { status: "PENDING" }, data: { runAt: new Date(Date.now() - 1000) } });

/** A user with AI configured and a finished 8-question individual exam: Topic A all correct, Topic B all wrong. */
async function finishedExam(opts: { review?: "NONE" | "CORRECTNESS" | "FULL"; draft?: Record<string, unknown>; ai?: boolean } = {}) {
  const u = await createUser();
  if (opts.ai !== false) await setupAi(t, u, { embedding: false });
  const { examId, snapshot } = await publishedExam(t, u, { n: 8, draft: { reviewPolicy: opts.review ?? "FULL", release: { mode: "IMMEDIATE" }, ...(opts.draft ?? {}) } });
  const a = await started(t, u, examId);
  const res = await submit(t, u, a.id, { answers: snapshot.questions.map((q, i) => (i % 2 === 0 ? ans(q.id, q.correctId, 1) : ans(q.id, q.wrongId, 1))) });
  expect(res.status).toBe(200);
  return { u, a, examId, snapshot };
}

describe("analysis context (minimal, privacy-conscious, policy-aware)", () => {
  it("FULL review: item detail incl. correct answer/explanation; no ids, names or e-mail", async () => {
    const { u, a, examId, snapshot } = await finishedExam({ review: "FULL" });
    await drain();
    expect(t.rag.analyzeCalls).toHaveLength(1);
    const ctx = t.rag.analyzeCalls[0]!.context;
    expect(ctx.exam).toMatchObject({ question_count: 8, correct: 4, incorrect: 4, unanswered: 0, percent_bp: 5000, band: "VERY_BAD" });
    expect(ctx.topics.map((x) => [x.topic, x.correct, x.questions])).toEqual([["Topic B", 0, 4], ["Topic A", 4, 4]]);
    expect(ctx.weak_topics).toEqual(["Topic B"]);
    expect(ctx.strong_topics).toEqual(["Topic A"]);
    expect(ctx.incorrect_items).toHaveLength(4);
    expect(ctx.incorrect_items[0]).toMatchObject({ topic: "Topic B", correct_text: expect.stringContaining("Option 0"), explanation: expect.stringContaining("Explanation") });
    expect(ctx.history).toMatchObject({ data_level: "INITIAL", results_total: 1, previous_same_exam: [] });
    const all = JSON.stringify(t.rag.analyzeCalls[0]!.context);
    for (const secret of [u.id, u.email, u.name, a.id, examId, snapshot.versionId, ...snapshot.questions.map((q) => q.id), ...snapshot.questions.flatMap((q) => q.optionIds)]) expect(all).not.toContain(secret);
    expect(all.length).toBeLessThanOrEqual(12_000);
    // the request carries the user's own key, server-to-server, and nothing else about the user
    expect(t.rag.analyzeCalls[0]!.chat).toMatchObject({ provider: "mock", api_key: "mock-valid-key", model: "mock-chat" });
    expect(Object.keys(t.rag.analyzeCalls[0]!).sort()).toEqual(["chat", "context", "request_id"]);
  });

  it("CORRECTNESS review: outcomes and the learner's own choice, but no correct answer, explanation or note", async () => {
    await finishedExam({ review: "CORRECTNESS" });
    await drain();
    const items = t.rag.analyzeCalls[0]!.context.incorrect_items;
    expect(items).toHaveLength(4);
    for (const i of items) expect(i).toMatchObject({ correct_text: null, explanation: null, note: null, selected_text: expect.any(String) });
    expect(JSON.stringify(t.rag.analyzeCalls[0]!.context)).not.toMatch(/Explanation \d|Note \d/);
  });

  it("NONE review: only counts and topic accuracy, no question text", async () => {
    await finishedExam({ review: "NONE" });
    await drain();
    const ctx = t.rag.analyzeCalls[0]!.context;
    expect(ctx.incorrect_items).toEqual([]);
    expect(ctx.topics).toHaveLength(2);
    expect(JSON.stringify(ctx)).not.toMatch(/Snapshot|Bank question|Option \d/);
  });

  it("caps incorrect items and total size", async () => {
    await withEnv({ ANALYSIS_MAX_INCORRECT_ITEMS: "2" }, async () => {
      await finishedExam();
      await drain();
      expect(t.rag.analyzeCalls[0]!.context.incorrect_items).toHaveLength(2);
    });
  });

  it("uses the learner's language preference", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    await db.userPreference.upsert({ where: { userId: u.id }, create: { userId: u.id, locale: "bn" }, update: { locale: "bn" } });
    const exam = await seedPublishedExam({ owner: u, questionCount: 4 });
    const { attempt } = await seedGradedResult({ exam, user: u, outcomes: ["C", "I", "C", "I"] });
    expect((await client(t, u).post(`/api/analysis/attempts/${attempt.id}`, {})).status).toBe(202);
    await drain();
    expect(t.rag.analyzeCalls[0]!.context.language).toBe("bn");
  });
});

describe("automatic and manual analysis", () => {
  it("auto-queues once the result is released, produces ONE verified row and records ANALYSIS usage", async () => {
    const { u, a } = await finishedExam();
    const pending = await db.examAnalysis.findMany({ where: { userId: u.id } });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("PENDING");
    expect(await db.job.count({ where: { type: "exam.analysis", status: "PENDING" } })).toBe(1);

    const before = await analysisOf(u, a.id);
    expect(before).toMatchObject({ status: "PENDING", content: null, canRetry: false, dataLevel: "INITIAL" });
    expect(before.deterministic).toMatchObject({ band: "VERY_BAD", label: "Very bad", percentBp: 5000 }); // present before any AI

    await drain();
    const view = await analysisOf(u, a.id);
    expect(view).toMatchObject({ status: "READY", provider: "mock", model: "mock-chat", errorCode: null, canRetry: false });
    expect(view.content.summary).toContain("4 of 8");
    expect(view.content.weaknesses[0]).toMatchObject({ topic: "Topic B", evidence: "0 of 4 correct" });
    expect(view.content.strengths[0].topic).toBe("Topic A");
    expect(view.disclaimer).toMatch(/does not change your score/);
    const usage = await db.usageRecord.findMany({ where: { userId: u.id, category: "llm.tokens" } });
    expect(usage).toHaveLength(1);
    expect((usage[0]!.metadata as { task: string }).task).toBe("ANALYSIS");
    expect(Number(usage[0]!.quantity)).toBe(180);
  });

  it("is idempotent: re-running the job or re-posting does not call the model again or create a second row", async () => {
    const { u, a } = await finishedExam();
    await drain();
    expect(t.rag.analyzeCalls).toHaveLength(1);
    const row = await db.examAnalysis.findFirstOrThrow({ where: { userId: u.id } });
    // the same job delivered again (e.g. duplicate delivery): nothing happens
    await examHandlers(t.rag)["exam.analysis"]!({ id: "j", type: "exam.analysis", payload: { resultId: row.resultId }, attempts: 1, maxAttempts: 3 } as never, new AbortController().signal);
    const res = await client(t, u).post(`/api/analysis/attempts/${a.id}`, {});
    expect(res.status).toBe(202);
    expect((await res.json()).analysis.status).toBe("READY");
    expect(t.rag.analyzeCalls).toHaveLength(1);
    expect(await db.examAnalysis.count({ where: { userId: u.id } })).toBe(1);
    // an explicit regenerate reuses the row
    expect((await client(t, u).post(`/api/analysis/attempts/${a.id}`, { regenerate: true })).status).toBe(202);
    await drain();
    expect(t.rag.analyzeCalls).toHaveLength(2);
    const again = await db.examAnalysis.findMany({ where: { userId: u.id } });
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(row.id);
    expect(again[0]!.status).toBe("READY");
  });

  it("autoAiFeedback=false: no row, no job; a manual request still works", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    const patch = await client(t, u).patch("/api/preferences", { theme: "SYSTEM", locale: "en", emailNotifications: true, autoAiFeedback: false });
    expect(patch.status).toBe(200);
    expect((await (await client(t, u).get("/api/profile")).json()).preference.autoAiFeedback).toBe(false);
    const { examId, snapshot } = await publishedExam(t, u, { n: 4 });
    const a = await started(t, u, examId);
    await submit(t, u, a.id, { answers: paper(snapshot, 2, 2) });
    expect(await db.examAnalysis.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.job.count({ where: { type: "exam.analysis" } })).toBe(0);
    expect((await analysisOf(u, a.id)).status).toBe("NONE");
    expect((await client(t, u).post(`/api/analysis/attempts/${a.id}`, {})).status).toBe(202);
    await drain();
    expect((await analysisOf(u, a.id)).status).toBe("READY");
  });

  it("no configured model: no auto job; manual request reports NOT_CONFIGURED (retryable) and works after configuring", async () => {
    const { u, a } = await finishedExam({ ai: false });
    expect(await db.examAnalysis.count({ where: { userId: u.id } })).toBe(0);
    const res = await client(t, u).post(`/api/analysis/attempts/${a.id}`, {});
    expect((await res.json()).analysis).toMatchObject({ status: "NOT_CONFIGURED", errorCode: "NOT_CONFIGURED", canRetry: true, content: null });
    expect(t.rag.analyzeCalls).toHaveLength(0);
    await setupAi(t, u, { embedding: false });
    expect((await (await client(t, u).post(`/api/analysis/attempts/${a.id}`, {})).json()).analysis.status).toBe("PENDING");
    await drain();
    expect((await analysisOf(u, a.id)).status).toBe("READY");
    expect(await db.examAnalysis.count({ where: { userId: u.id } })).toBe(1);
  });

  it("a key removed after queueing makes the job settle as NOT_CONFIGURED (no retry storm)", async () => {
    const { u, a } = await finishedExam();
    await client(t, u).delete("/api/ai/credentials/mock");
    await drain();
    expect(t.rag.analyzeCalls).toHaveLength(0);
    expect((await analysisOf(u, a.id)).status).toBe("NOT_CONFIGURED");
    expect(await db.job.count({ where: { type: "exam.analysis", status: "PENDING" } })).toBe(0);
  });
});

describe("release gating and ownership", () => {
  it("nothing is analysed or exposed before the release time; the release path schedules it afterwards", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    const releaseAt = new Date(Date.now() + 3_600_000);
    const exam = await seedPublishedExam({ owner: u, questionCount: 4, releaseMode: "AT_TIME", releaseAt });
    const { attempt } = await seedGradedResult({ exam, user: u, outcomes: ["C", "I", "C", "I"] });

    const get = await client(t, u).get(`/api/analysis/attempts/${attempt.id}`);
    expect(get.status).toBe(409);
    expect((await get.json()).error.details.released).toBe(false);
    const post = await client(t, u).post(`/api/analysis/attempts/${attempt.id}`, {});
    expect(post.status).toBe(409);
    expect(await db.examAnalysis.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.job.count({ where: { type: "exam.analysis" } })).toBe(0);
    expect(t.rag.analyzeCalls).toHaveLength(0);
    expect(await sendReleaseNotices(exam.version.id)).toBe(false);

    setClock(() => new Date(releaseAt.getTime() + 1000));
    expect(await sendReleaseNotices(exam.version.id)).toBe(true); // what the exam.release job / sweeper runs
    expect(await db.examAnalysis.count({ where: { userId: u.id, status: "PENDING" } })).toBe(1);
    await drain();
    expect((await analysisOf(u, attempt.id)).status).toBe("READY");
  });

  it("another user's attempt is a 404, an unsubmitted attempt a 409; unauthenticated is 401", async () => {
    const { a } = await finishedExam();
    const other = await createUser();
    expect((await client(t, other).get(`/api/analysis/attempts/${a.id}`)).status).toBe(404);
    expect((await client(t, other).post(`/api/analysis/attempts/${a.id}`, {})).status).toBe(404);
    expect((await client(t).get(`/api/analysis/attempts/${a.id}`)).status).toBe(401);
    const u = await createUser();
    const { examId } = await publishedExam(t, u, { n: 2 });
    const running = await started(t, u, examId);
    expect((await client(t, u).get(`/api/analysis/attempts/${running.id}`)).status).toBe(409);
    expect((await client(t, u).get("/api/analysis/attempts/nope")).status).toBe(404);
  });

  it("rejects unknown request keys", async () => {
    const { u, a } = await finishedExam();
    expect((await client(t, u).post(`/api/analysis/attempts/${a.id}`, { regenerate: true, score: 100 })).status).toBe(422);
  });
});

describe("failures never touch the result", () => {
  const resultRow = (attemptId: string) => db.examResult.findUniqueOrThrow({ where: { attemptId } });
  const setScript = (fn: () => Promise<never>) => {
    t.rag.analyzeResultScript = fn;
  };

  it("transient failure is retried with backoff and then succeeds", async () => {
    const { u, a } = await finishedExam();
    let n = 0;
    const ok = t.rag.analyzeResultScript;
    t.rag.analyzeResultScript = async (req, s) => {
      if (n++ === 0) throw new RagAgentError("PROVIDER_RATE_LIMITED", "slow down", true, 1, 429);
      return ok(req, s);
    };
    await drain();
    expect((await analysisOf(u, a.id)).status).toBe("PENDING");
    expect(await db.job.count({ where: { type: "exam.analysis", status: "PENDING", attempts: 1 } })).toBe(1);
    await forceDue();
    await drain();
    expect(n).toBe(2);
    expect((await analysisOf(u, a.id)).status).toBe("READY");
    expect(await db.examAnalysis.count({ where: { userId: u.id } })).toBe(1);
  });

  it("exhausted retries end FAILED (retryable by the user) and the verified result is untouched", async () => {
    const { u, a } = await finishedExam();
    const before = await resultRow(a.id);
    const summaryBefore = (await (await client(t, u).get("/api/dashboard/summary")).json()).exams;
    setScript(async () => {
      throw new RagAgentError("PROVIDER_UNAVAILABLE", "down", true, null, 502);
    });
    for (let i = 0; i < 3; i++) {
      await drain();
      await forceDue();
    }
    expect(t.rag.analyzeCalls).toHaveLength(3); // ANALYSIS_MAX_ATTEMPTS, no more
    const view = await analysisOf(u, a.id);
    expect(view).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_UNAVAILABLE", canRetry: true, content: null });
    expect(view.deterministic).toMatchObject({ band: "VERY_BAD", percentBp: 5000 }); // threshold feedback is still there

    // the score, the result page and the dashboard are exactly as before
    expect(await resultRow(a.id)).toEqual(before);
    const page = await client(t, u).get(`/api/attempts/${a.id}/result`);
    expect(page.status).toBe(200);
    expect((await page.json()).score).toMatchObject({ scoreCenti: 400, percentBp: 5000, band: "VERY_BAD" });
    expect((await (await client(t, u).get("/api/dashboard/summary")).json()).exams).toEqual(summaryBefore);

    // manual retry: same row, no duplicate, result still identical
    t.rag.analyzeResultScript = async (req) => (await import("../helpers/fake-analysis.js")).defaultAnalyzeResult(req);
    const row = await db.examAnalysis.findFirstOrThrow({ where: { userId: u.id } });
    const res = await client(t, u).post(`/api/analysis/attempts/${a.id}`, {});
    expect((await res.json()).analysis.status).toBe("PENDING");
    await drain();
    expect((await analysisOf(u, a.id)).status).toBe("READY");
    const rows = await db.examAnalysis.findMany({ where: { userId: u.id } });
    expect(rows.map((r) => r.id)).toEqual([row.id]);
    expect(await resultRow(a.id)).toEqual(before);
    expect(await db.examResult.count({ where: { userId: u.id } })).toBe(1);
  });

  it("permanent provider errors fail immediately; an invalid key marks the credential", async () => {
    const { u, a } = await finishedExam();
    setScript(async () => {
      throw new RagAgentError("PROVIDER_AUTH_INVALID", "bad key", false, null, 502);
    });
    await drain();
    expect(t.rag.analyzeCalls).toHaveLength(1);
    expect((await analysisOf(u, a.id))).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_AUTH_INVALID", canRetry: true });
    expect((await db.providerCredential.findFirstOrThrow({ where: { userId: u.id } })).status).toBe("INVALID");
  });

  it("an INVALID_OUTPUT failure from rag_agent is reported with its reason, not retried", async () => {
    const { u, a } = await finishedExam();
    setScript(async () => {
      throw new RagAgentError("GENERATION_FAILED", "bad", false, null, 502, "UNGROUNDED_OUTPUT");
    });
    await drain();
    expect(t.rag.analyzeCalls).toHaveLength(1);
    expect((await analysisOf(u, a.id)).errorCode).toBe("UNGROUNDED_OUTPUT");
  });

  it("output that names topics the data doesn't support is rejected (never shown)", async () => {
    const { u, a } = await finishedExam();
    t.rag.analyzeResultScript = async () => ({
      result: { summary: "ok", strengths: [{ topic: "Topic B", detail: "x" }], weaknesses: [], next_steps: [{ type: "REVIEW_NOTES", topic: null, text: "t" }], caveats: [] },
      usage: { prompt_tokens: 1, completion_tokens: 1, llm_calls: 1 },
    });
    await drain();
    expect(await analysisOf(u, a.id)).toMatchObject({ status: "FAILED", errorCode: "INVALID_OUTPUT", content: null });
    t.rag.analyzeResultScript = async () => ({
      result: { summary: "ok", strengths: [], weaknesses: [{ topic: "Invented topic", detail: "x", evidence: "1 of 1" }], next_steps: [{ type: "REVIEW_NOTES", topic: null, text: "t" }], caveats: [] },
      usage: { prompt_tokens: 1, completion_tokens: 1, llm_calls: 1 },
    });
    await client(t, u).post(`/api/analysis/attempts/${a.id}`, {});
    await drain();
    expect((await analysisOf(u, a.id)).errorCode).toBe("INVALID_OUTPUT");
  });

  it("rate-limits manual retries per user", async () => {
    await withEnv({ ANALYSIS_RETRY_PER_HOUR: "2" }, async () => {
      const { u, a } = await finishedExam({ ai: false });
      const post = () => client(t, u).post(`/api/analysis/attempts/${a.id}`, {});
      expect((await post()).status).toBe(202);
      expect((await post()).status).toBe(202);
      const third = await post();
      expect(third.status).toBe(429);
      expect((await third.json()).error.code).toBe("RATE_LIMITED");
    });
  });
});

describe("quotas", () => {
  it("daily request quota and monthly token quota stop the job before any provider call", async () => {
    await withEnv({ AI_DAILY_REQUEST_LIMIT: "1" }, async () => {
      const { u, a } = await finishedExam();
      await db.usageRecord.create({ data: { userId: u.id, category: "llm.requests", quantity: 1n, metadata: { task: "CHAT" } } });
      await drain();
      expect(t.rag.analyzeCalls).toHaveLength(0);
      expect(await analysisOf(u, a.id)).toMatchObject({ status: "FAILED", errorCode: "QUOTA_EXCEEDED", canRetry: true });
    });
    await withEnv({ AI_MONTHLY_TOKEN_LIMIT: "100" }, async () => {
      const { u, a } = await finishedExam();
      await db.usageRecord.create({ data: { userId: u.id, category: "llm.tokens", quantity: 100n, metadata: { task: "CHAT" } } });
      await drain();
      expect(t.rag.analyzeCalls).toHaveLength(0);
      expect((await analysisOf(u, a.id)).errorCode).toBe("QUOTA_EXCEEDED");
    });
  });
});
