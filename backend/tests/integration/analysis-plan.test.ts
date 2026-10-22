import { beforeEach, describe, expect, it } from "vitest";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { db } from "../../src/lib/db.js";
import { INITIAL_CAVEAT } from "../../src/modules/analysis/plan.js";
import { examHandlers } from "../../src/modules/exams/jobs.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";
import { seedPublishedExam } from "../helpers/exam-fixtures.js";
import { outcomesOf, seedGradedResult } from "../helpers/analysis-fixtures.js";
import { client, makeApp, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";
import { withEnv } from "../helpers/with-env.js";

let t: TestApp;
beforeEach(async () => {
  t = makeApp();
  await db.job.deleteMany();
});
const drain = () => runDueJobs(examHandlers(t.rag));
const getPlan = async (u: TestUser) => (await client(t, u).get("/api/analysis/plan")).json();
const postPlan = (u: TestUser) => client(t, u).post("/api/analysis/plan", {});

/** 8 questions: Topic A = even positions, Topic B = odd. "CICIC…" style strings give per-topic accuracy. */
async function withResult(u: TestUser, outcomes: string, opts: { exam?: Awaited<ReturnType<typeof seedPublishedExam>>; n?: number; finalizedAt?: Date; attemptNo?: number } = {}) {
  const exam = opts.exam ?? (await seedPublishedExam({ owner: u, questionCount: opts.n ?? 8, attemptLimit: 5 }));
  await seedGradedResult({ exam, user: u, outcomes: outcomesOf(outcomes, exam.questions.length), ...(opts.finalizedAt ? { finalizedAt: opts.finalizedAt } : {}), ...(opts.attemptNo ? { attemptNo: opts.attemptNo } : {}) });
  return exam;
}

describe("study plan — deterministic part", () => {
  it("no data: an honest empty state, no suggestions, nothing to generate", async () => {
    const u = await createUser();
    const p = await getPlan(u);
    expect(p).toMatchObject({ dataLevel: "NONE", resultCount: 0, suggestions: [], weakTopics: [], plan: null, canGenerate: false });
    expect(p.emptyState).toMatch(/real results/);
    const res = await postPlan(u);
    expect(res.status).toBe(409);
    expect(await db.studyPlan.count({ where: { userId: u.id } })).toBe(0);
  });

  it("builds weak/strong lists and suggestions from the verified numbers, labelled as initial with little data", async () => {
    const u = await createUser();
    await withResult(u, "CICICICI"); // Topic A (even positions) all correct, Topic B all wrong
    const p = await getPlan(u);
    expect(p.dataLevel).toBe("INITIAL");
    expect(p.label).toBe("INITIAL_SUGGESTIONS");
    expect(p.weakTopics.map((x: { topic: string }) => x.topic)).toEqual(["Topic B"]);
    expect(p.strongTopics.map((x: { topic: string }) => x.topic)).toEqual(["Topic A"]);
    const types = p.suggestions.map((s: { type: string }) => s.type);
    expect(types).toEqual(["REVIEW_NOTES", "REVISIT_QUESTIONS", "PRACTICE_MCQ", "ASK_ASSISTANT"]);
    expect(p.suggestions[0]).toMatchObject({ topic: "Topic B", href: "/question-bank?topic=Topic%20B", reason: "0 of 4 correct so far." });
    expect(p.suggestions[2].href).toBe("/mcq?topic=Topic%20B&grounding=GENERAL");
    expect(p.suggestions[3]).toMatchObject({ href: null, assistant: { kind: "REVISION_PLAN" } });
  });

  it("topics with too few answers are 'not enough data', never weak or strong", async () => {
    const u = await createUser();
    await withResult(u, "IC", { n: 2 }); // one question per topic
    const p = await getPlan(u);
    expect(p.weakTopics).toEqual([]);
    expect(p.strongTopics).toEqual([]);
    expect(p.notEnoughData.map((x: { topic: string }) => x.topic).sort()).toEqual(["Topic A", "Topic B"]);
    expect(p.suggestions).toEqual([]);
  });

  it("suggests comparing attempts when one exam was taken twice, and only counts released results", async () => {
    const u = await createUser();
    const exam = await withResult(u, "CICICICI");
    await withResult(u, "CCCCCCCI", { exam, attemptNo: 2, finalizedAt: new Date() });
    const p = await getPlan(u);
    expect(p.suggestions.some((s: { type: string; href: string }) => s.type === "COMPARE_ATTEMPTS" && s.href === `/exams/${exam.exam.id}`)).toBe(true);
    // a held-back result is invisible
    const held = await seedPublishedExam({ owner: u, questionCount: 8, releaseMode: "AT_TIME", releaseAt: new Date(Date.now() + 3_600_000) });
    await seedGradedResult({ exam: held, user: u, outcomes: outcomesOf("IIIIIIII") });
    expect((await getPlan(u)).resultCount).toBe(2);
  });
});

describe("study plan — AI part", () => {
  it("is idempotent per data state, stale when the data changes, and labelled by code", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    await withResult(u, "CICICICI");
    const first = await postPlan(u);
    expect(first.status).toBe(202);
    const plan1 = (await first.json()).plan;
    expect(plan1).toMatchObject({ status: "PENDING", label: "INITIAL_SUGGESTIONS", stale: false, content: null });
    expect((await postPlan(u).then((r) => r.json())).plan.id).toBe(plan1.id); // same data ⇒ same row
    expect(await db.job.count({ where: { type: "study-plan" } })).toBe(1);

    await drain();
    const ready = (await getPlan(u)).plan;
    expect(ready).toMatchObject({ id: plan1.id, status: "READY", stale: false, basis: { results: 1, topics: 2, answered: 8 } });
    expect(ready.content.headline).toBeTruthy();
    expect(ready.content.caveats).toContain(INITIAL_CAVEAT); // enforced by code even though the fake model returned none
    expect(t.rag.analyzePlanCalls).toHaveLength(1);
    expect(t.rag.analyzePlanCalls[0]!.context.data_level).toBe("INITIAL");
    expect(JSON.stringify(t.rag.analyzePlanCalls[0]!.context)).not.toContain(u.id);

    // re-posting a READY plan does not call the model again
    await postPlan(u);
    await drain();
    expect(t.rag.analyzePlanCalls).toHaveLength(1);

    // new verified data ⇒ the old plan is stale, a new row is created for the new fingerprint
    await withResult(u, "CCCCCCCC");
    const stale = await getPlan(u);
    expect(stale.plan).toMatchObject({ id: plan1.id, stale: true });
    expect(stale.canGenerate).toBe(true);
    const next = (await (await postPlan(u)).json()).plan;
    expect(next.id).not.toBe(plan1.id);
    expect(await db.studyPlan.count({ where: { userId: u.id } })).toBe(2);
  });

  it("with history (≥3 results and a topic with ≥5 answers) the plan is based on history and needs no forced caveat", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    for (const o of ["CICICICI", "CICCCICI", "CCCICICI"]) await withResult(u, o);
    await postPlan(u);
    await drain();
    const p = (await getPlan(u)).plan;
    expect(p).toMatchObject({ status: "READY", label: "BASED_ON_HISTORY" });
    expect(p.content.caveats).not.toContain(INITIAL_CAVEAT);
    expect(t.rag.analyzePlanCalls[0]!.context.data_level).toBe("BASED_ON_HISTORY");
    expect(t.rag.analyzePlanCalls[0]!.context.results).toHaveLength(3);
  });

  it("keeps only the newest STUDY_PLAN_MAX_PER_USER plans", async () => {
    await withEnv({ STUDY_PLAN_MAX_PER_USER: "2" }, async () => {
      const u = await createUser();
      await setupAi(t, u, { embedding: false });
      for (let i = 0; i < 3; i++) {
        await withResult(u, i % 2 ? "CICICICI" : "IICCICCI");
        await postPlan(u);
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(await db.studyPlan.count({ where: { userId: u.id } })).toBe(2);
    });
  });

  it("no model: NOT_CONFIGURED (no job); transient failures retry; permanent and ungrounded output fail; retry reuses the row", async () => {
    const u = await createUser();
    await withResult(u, "CICICICI");
    const a = (await (await postPlan(u)).json()).plan;
    expect(a).toMatchObject({ status: "NOT_CONFIGURED", errorCode: "NOT_CONFIGURED", canRetry: true });
    expect(await db.job.count({ where: { type: "study-plan" } })).toBe(0);

    await setupAi(t, u, { embedding: false });
    let n = 0;
    const ok = t.rag.analyzePlanScript;
    t.rag.analyzePlanScript = async (req, s) => {
      if (n++ === 0) throw new RagAgentError("PROVIDER_TIMEOUT", "slow", true, null, 504);
      return ok(req, s);
    };
    expect((await (await postPlan(u)).json()).plan).toMatchObject({ id: a.id, status: "PENDING" });
    await drain();
    expect((await getPlan(u)).plan.status).toBe("PENDING");
    await db.job.updateMany({ where: { status: "PENDING" }, data: { runAt: new Date(Date.now() - 1000) } });
    await drain();
    expect((await getPlan(u)).plan).toMatchObject({ id: a.id, status: "READY" });

    // ungrounded topic in the plan ⇒ FAILED INVALID_OUTPUT, retryable
    t.rag.analyzePlanScript = async () => ({ result: { headline: "h", focus: [{ topic: "Nope", reason: "r" }], steps: [{ type: "REVIEW_NOTES", topic: null, text: "t" }], caveats: [] }, usage: { prompt_tokens: 1, completion_tokens: 1, llm_calls: 1 } });
    await withResult(u, "CCCCCCCC");
    const b = (await (await postPlan(u)).json()).plan;
    await drain();
    expect((await getPlan(u)).plan).toMatchObject({ id: b.id, status: "FAILED", errorCode: "INVALID_OUTPUT", canRetry: true });
    expect(await db.examResult.count({ where: { userId: u.id } })).toBe(2); // results untouched
  });

  it("is scoped to the caller and rate limited", async () => {
    await withEnv({ ANALYSIS_RETRY_PER_HOUR: "1" }, async () => {
      const [u, other] = [await createUser(), await createUser()];
      await withResult(u, "CICICICI");
      expect((await getPlan(other)).dataLevel).toBe("NONE");
      expect((await postPlan(u)).status).toBe(202);
      expect((await postPlan(u)).status).toBe(429);
    });
    expect((await client(t).get("/api/analysis/plan")).status).toBe(401);
  });
});
