import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { seedPublishedExam } from "../helpers/exam-fixtures.js";
import { outcomesOf, seedGradedResult } from "../helpers/analysis-fixtures.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
const session = (u: TestUser, body: Record<string, unknown>) => client(t, u).post("/api/assistant/sessions", body);

async function result(u: TestUser, outcomes: string, opts: Parameters<typeof seedPublishedExam>[0] extends infer O ? Partial<O> : never = {}) {
  const exam = await seedPublishedExam({ owner: u, questionCount: outcomes.length, ...opts } as Parameters<typeof seedPublishedExam>[0]);
  const { attempt } = await seedGradedResult({ exam, user: u, outcomes: outcomesOf(outcomes) });
  return { exam, attemptId: attempt.id };
}
const readyDoc = (u: TestUser, status: "READY" | "PROCESSING" = "READY") =>
  db.document.create({ data: { ownerId: u.id, name: "notes.txt", extension: "txt", mimeType: "text/plain", sizeBytes: 10, sha256: randomUUID(), storageKey: `u/${u.id}/${randomUUID().replaceAll("-", "")}`, status, embeddingModel: "mock-embed", embeddingProvider: "MOCK", processingVersion: 1 } });

describe("assistant sessions: EXPLAIN_INCORRECT", () => {
  it("creates a normal GENERAL conversation with a prompt built from the caller's own released review data", async () => {
    const u = await createUser();
    const { exam, attemptId } = await result(u, "CIU");
    const wrongQ = exam.questions[1]!;
    const res = await session(u, { kind: "EXPLAIN_INCORRECT", attemptId, questionId: wrongQ.id });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt).toContain("Snapshot question 2");
    expect(body.prompt).toContain("My answer: B. Snapshot option 1 of 2");
    expect(body.prompt).toContain("Correct answer: A. Snapshot option 0 of 2");
    expect(body.prompt).toContain("Snapshot explanation 2");
    expect(body.href).toBe(`/chat/${body.conversationId}`);
    const conv = (await (await client(t, u).get(`/api/conversations/${body.conversationId}`)).json()).conversation;
    expect(conv).toMatchObject({ mode: "GENERAL", documentIds: [] });
    // unanswered questions can be explained too
    const un = await session(u, { kind: "EXPLAIN_INCORRECT", attemptId, questionId: exam.questions[2]!.id });
    expect((await un.json()).prompt).toContain("(I left it unanswered)");
  });

  it("is refused for correct answers, other users' attempts, unreleased results and exams that hide the key", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const { exam, attemptId } = await result(u, "CI");
    expect((await session(u, { kind: "EXPLAIN_INCORRECT", attemptId, questionId: exam.questions[0]!.id })).status).toBe(409); // answered correctly
    expect((await session(other, { kind: "EXPLAIN_INCORRECT", attemptId, questionId: exam.questions[1]!.id })).status).toBe(404);
    expect((await session(u, { kind: "EXPLAIN_INCORRECT", attemptId, questionId: "nope" })).status).toBe(404);
    expect((await session(u, { kind: "EXPLAIN_INCORRECT", attemptId: "nope", questionId: exam.questions[1]!.id })).status).toBe(404);

    const held = await result(u, "CI", { releaseMode: "AT_TIME", releaseAt: new Date(Date.now() + 3_600_000) });
    const r = await session(u, { kind: "EXPLAIN_INCORRECT", attemptId: held.attemptId, questionId: held.exam.questions[1]!.id });
    expect(r.status).toBe(409);
    expect((await r.json()).error.details.released).toBe(false);

    for (const review of ["CORRECTNESS", "NONE"] as const) {
      const hidden = await result(u, "CI", { reviewPolicy: review });
      const res = await session(u, { kind: "EXPLAIN_INCORRECT", attemptId: hidden.attemptId, questionId: hidden.exam.questions[1]!.id });
      expect(res.status, review).toBe(403);
      expect((await res.json()).error.code).toBe("NOT_ELIGIBLE");
    }
    expect(await db.conversation.count({ where: { userId: u.id } })).toBe(0); // nothing was created on refusal
  });
});

describe("assistant sessions: other kinds", () => {
  it("TOPIC_SUMMARY: DOCUMENT_ONLY conversation over the caller's own ready documents only", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const doc = await readyDoc(u);
    const res = await session(u, { kind: "TOPIC_SUMMARY", topic: "Cells", documentIds: [doc.id] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt).toContain("Cells");
    const conv = (await (await client(t, u).get(`/api/conversations/${body.conversationId}`)).json()).conversation;
    expect(conv).toMatchObject({ mode: "DOCUMENT_ONLY", documentIds: [doc.id] });
    // foreign document ids look like missing ones; processing-only documents are refused; invalid bodies too
    expect((await session(other, { kind: "TOPIC_SUMMARY", topic: "Cells", documentIds: [doc.id] })).status).toBe(404);
    expect((await session(u, { kind: "TOPIC_SUMMARY", topic: "Cells", documentIds: [(await readyDoc(u, "PROCESSING")).id] })).status).toBe(422);
    expect((await session(u, { kind: "TOPIC_SUMMARY", topic: "Cells", documentIds: [] })).status).toBe(422);
    expect((await session(u, { kind: "TOPIC_SUMMARY", documentIds: [doc.id] })).status).toBe(422);
  });

  it("REVISION_PLAN: needs real data; the prompt contains only the caller's own verified numbers", async () => {
    const [u, other] = [await createUser(), await createUser()];
    expect((await session(u, { kind: "REVISION_PLAN" })).status).toBe(409);
    await result(u, "CICICICI");
    await result(other, "IIIIIIII");
    const res = await session(u, { kind: "REVISION_PLAN" });
    expect(res.status).toBe(201);
    const { prompt, conversationId } = await res.json();
    expect(prompt).toContain("- Topic B: 0 of 4 correct");
    expect(prompt).toContain("Topic A: 4 of 4 correct");
    expect(prompt).toMatch(/initial suggestions/);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conversationId } })).userId).toBe(u.id);
  });

  it("PRACTICE_QUESTIONS and RELATED_CQ return prefilled generator links without making a conversation or an AI call", async () => {
    const u = await createUser();
    const a = await (await session(u, { kind: "PRACTICE_QUESTIONS", topic: "Cell biology & more" })).json();
    expect(a).toEqual({ conversationId: null, prompt: null, href: "/mcq?topic=Cell%20biology%20%26%20more&grounding=GENERAL" });
    const b = await (await session(u, { kind: "RELATED_CQ", topic: "Rivers" })).json();
    expect(b.href).toBe("/cq?topic=Rivers&grounding=GENERAL");
    expect(await db.conversation.count({ where: { userId: u.id } })).toBe(0);
    expect(t.rag.chatCalls).toHaveLength(0);
  });

  it("validates strictly, requires authentication and is rate limited", async () => {
    const u = await createUser();
    expect((await session(u, { kind: "UNKNOWN" })).status).toBe(422);
    expect((await session(u, { kind: "REVISION_PLAN", extra: 1 })).status).toBe(422);
    expect((await client(t).post("/api/assistant/sessions", { kind: "REVISION_PLAN" })).status).toBe(401);
    let last = 201;
    for (let i = 0; i < 22 && last !== 429; i++) last = (await session(u, { kind: "PRACTICE_QUESTIONS", topic: "x" })).status;
    expect(last).toBe(429);
  });
});
