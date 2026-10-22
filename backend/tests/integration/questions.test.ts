import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../../src/config/env.js";
import { db } from "../../src/lib/db.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});

const mcq = (stem: string, over: Record<string, unknown> = {}) => ({
  kind: "MCQ", language: "en", stem, difficulty: "MEDIUM", topic: "Cells", subject: "Biology", tags: ["bio"],
  options: [{ text: `${stem} A` }, { text: `${stem} B` }, { text: `${stem} C` }, { text: `${stem} D` }],
  correctOptionId: "#1", explanation: "Because B.", shortNote: "Remember B.", ...over,
});
const cq = (stem: string, over: Record<string, unknown> = {}) => ({
  kind: "CQ", language: "en", stem, stimulus: `Stimulus for ${stem}`, difficulty: "HARD", topic: "Rivers",
  parts: [{ prompt: `${stem} part 1`, marks: 4, answerText: "Part answer" }, { prompt: `${stem} part 2`, marks: 6 }], ...over,
});
const save = async (u: TestUser, questions: unknown[], extra: Record<string, unknown> = {}) => client(t, u).post("/api/questions", { questions, ...extra });
const saved = async (u: TestUser, q: Record<string, unknown>) => {
  const res = await save(u, [q]);
  expect(res.status).toBe(201);
  return (await res.json()).items[0].question as { id: string; version: number; options: { id: string; text: string }[]; correctOptionId: string | null; [k: string]: any };
};

describe("saving questions", () => {
  it("stores a user-authored MCQ with server-decided provenance and a first revision", async () => {
    const u = await createUser();
    const res = await save(u, [mcq("What is a cell?")]);
    expect(res.status).toBe(201);
    const body = await res.json();
    const q = body.items[0].question;
    expect(body.items[0].status).toBe("CREATED");
    expect(q).toMatchObject({ kind: "MCQ", origin: "USER_AUTHORED", sourceSupport: "NONE", version: 1, modifiedByUser: false, needsReview: false, provenance: null, tags: ["bio"], marks: 1, negativeMarks: 0, schemaVersion: 1 });
    expect(q.options).toHaveLength(4);
    expect(q.options.every((o: { id: string }) => /^[A-Za-z0-9_-]{2,40}$/.test(o.id))).toBe(true);
    expect(q.correctOptionId).toBe(q.options[1].id);
    expect(q.sources).toEqual([]);

    const rows = await db.questionOption.findMany({ where: { questionId: q.id } });
    expect(rows.filter((r) => r.isCorrect)).toHaveLength(1);
    const revs = await (await client(t, u).get(`/api/questions/${q.id}/revisions`)).json();
    expect(revs.items.map((r: { version: number }) => r.version)).toEqual([1]);
    expect(revs.items[0].question.stem).toBe("What is a cell?");
  });

  it("stores a CQ with parts, marks total and answers, and no options", async () => {
    const u = await createUser();
    const q = await saved(u, cq("Describe the river"));
    expect(q.options).toEqual([]);
    expect(q.marks).toBe(10);
    expect(q.parts).toHaveLength(2);
    expect(q.parts[0]).toMatchObject({ marks: 4, answer: { text: "Part answer", basis: "USER_PROVIDED", sources: [] } });
    expect(q.parts[1].answer).toBeNull();
    const single = await saved(u, { kind: "CQ", language: "bn", stem: "বর্ণনা করো", difficulty: "EASY", marks: 5, answerText: "উত্তর" });
    expect(single.parts).toEqual([]);
    expect(single.answer).toMatchObject({ text: "উত্তর", basis: "USER_PROVIDED" });
  });

  it("is atomic: one invalid question saves nothing and the error names the field", async () => {
    const u = await createUser();
    const res = await save(u, [mcq("Valid one"), mcq("Bad one", { correctOptionId: "nope" })]);
    expect(res.status).toBe(422);
    const err = (await res.json()).error;
    expect(err.details.fields["questions.1.correctOptionId"]).toBe("The correct answer must be one of the options.");
    expect(await db.question.count({ where: { ownerId: u.id } })).toBe(0);
  });

  it("rejects malformed shapes: duplicate options, missing answer, empty stem, unknown keys, oversize", async () => {
    const u = await createUser();
    const bad = async (q: Record<string, unknown>) => (await save(u, [q])).status;
    expect(await bad(mcq("x", { options: [{ text: "same" }, { text: "Same!" }], correctOptionId: "#0" }))).toBe(422);
    expect(await bad(mcq("x", { correctOptionId: undefined }))).toBe(422);
    expect(await bad(mcq("   "))).toBe(422);
    expect(await bad(mcq("x", { ownerId: "someone" }))).toBe(422);
    expect(await bad(mcq("x".repeat(2001)))).toBe(422);
    expect((await client(t, u).post("/api/questions", { questions: [] })).status).toBe(422);
    expect((await client(t, u).post("/api/questions", { questions: Array.from({ length: 101 }, (_, i) => mcq(`q${i}`)) })).status).toBe(422);
  });

  it("never accepts client-supplied provenance or evidence", async () => {
    const u = await createUser();
    const forged = { ...mcq("Forged"), sources: [{ documentName: "x", quote: "y", quoteVerified: true }], sourceSupport: "SOURCE_QUOTED" };
    expect((await save(u, [forged])).status).toBe(422);
    // claiming to come from a generation that doesn't exist (or isn't yours)
    expect((await save(u, [{ ...mcq("Linked"), runQuestionId: "g_deadbeef01" }], { runId: "nonexistent" })).status).toBe(422);
    expect((await save(u, [{ ...mcq("Linked 2"), runQuestionId: "g_deadbeef01" }])).status).toBe(422);
    const other = await createUser();
    const run = await db.generationRun.create({ data: { userId: other.id, kind: "MCQ", status: "SUCCEEDED", settings: {}, provider: "MOCK", model: "m", result: { questions: [], rejectedCount: 0, warnings: [], sources: {} }, expiresAt: new Date(Date.now() + 1e7) } });
    expect((await save(u, [mcq("Mine")], { runId: run.id })).status).toBe(422); // someone else's run is indistinguishable from a missing one
  });

  it("returns an existing question for an exact duplicate and rejects duplicates inside one request", async () => {
    const u = await createUser();
    const first = await saved(u, mcq("Same question"));
    const again = await (await save(u, [mcq("same QUESTION!", { options: [{ text: "Same question D" }, { text: "Same question C" }, { text: "Same question B" }, { text: "Same question A" }], correctOptionId: "#2" })])).json();
    expect(again.items[0]).toMatchObject({ status: "EXISTING" });
    expect(again.items[0].question.id).toBe(first.id);
    expect(await db.question.count({ where: { ownerId: u.id } })).toBe(1);

    const dup = await save(u, [mcq("Another one"), mcq("Another one")]);
    expect(dup.status).toBe(422);
    expect((await dup.json()).error.details.fields["questions.1"]).toMatch(/duplicate of question 1/);
  });

  it("saves but warns about near-duplicates already in the bank", async () => {
    const u = await createUser();
    const stem = "Which organelle is known as the powerhouse of the cell and produces most of its ATP?";
    const opts = [{ text: "Nucleus" }, { text: "Mitochondrion" }, { text: "Ribosome" }, { text: "Golgi body" }];
    await saved(u, mcq(stem, { options: opts }));
    const res = await (await save(u, [mcq(`${stem} Explain.`, { options: opts.map((o, i) => ({ text: i === 3 ? "Golgi apparatus" : o.text })) })])).json();
    expect(res.items[0].status).toBe("CREATED");
    expect(res.warnings).toEqual([expect.objectContaining({ index: 0, code: "NEAR_DUPLICATE_IN_BANK" })]);
    expect(res.items[0].question.reviewReasons).toContain("NEAR_DUPLICATE_IN_BANK");
    expect(res.items[0].question.needsReview).toBe(true);
  });

  it("detects near-duplicates in Bangla too", async () => {
    const u = await createUser();
    const opts = [{ text: "মাইটোকন্ড্রিয়া" }, { text: "নিউক্লিয়াস" }, { text: "রাইবোসোম" }];
    await saved(u, mcq("কোষের শক্তিঘর নামে পরিচিত অঙ্গাণুটি কোনটি এবং এটি কী কাজ করে?", { language: "bn", options: opts }));
    const res = await (await save(u, [mcq("কোষের শক্তিঘর নামে পরিচিত অঙ্গাণুটি কোনটি এবং এটি কী কাজ করে ?", { language: "bn", options: [...opts].reverse(), correctOptionId: "#1" })])).json();
    expect(res.items[0].status).toBe("EXISTING"); // identical after normalisation
    const res2 = await (await save(u, [mcq("কোষের শক্তিঘর নামে পরিচিত অঙ্গাণুটি কোনটি এবং এটি কী কাজ করে লেখো", { language: "bn", options: [...opts.slice(0, 2), { text: "গলগি বডি" }] })])).json();
    expect(res2.warnings.map((w: { code: string }) => w.code)).toContain("NEAR_DUPLICATE_IN_BANK");
  });

  it("enforces the per-user question limit", async () => {
    const u = await createUser();
    process.env.QUESTION_MAX_PER_USER = "2";
    resetEnvCache();
    try {
      await saved(u, mcq("One"));
      await saved(u, mcq("Two"));
      const res = await save(u, [mcq("Three")]);
      expect(res.status).toBe(429);
      expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED");
    } finally {
      delete process.env.QUESTION_MAX_PER_USER;
      resetEnvCache();
    }
  });

  it("can save into a new or existing collection in the same request", async () => {
    const u = await createUser();
    const c = client(t, u);
    const res = await (await c.post("/api/questions", { questions: [mcq("In set A"), mcq("In set B")], collection: { create: { title: "Week 1", subject: "Biology" } } })).json();
    expect(res.collection).toMatchObject({ title: "Week 1", questionCount: 2 });
    const more = await (await c.post("/api/questions", { questions: [mcq("In set C")], collection: { id: res.collection.id } })).json();
    expect(more.collection.questionCount).toBe(3);
    const dupTitle = await c.post("/api/questions", { questions: [mcq("In set D")], collection: { create: { title: "week 1" } } });
    expect(dupTitle.status).toBe(422);
    expect(await db.question.count({ where: { ownerId: u.id } })).toBe(3); // atomic
  });
});

describe("reading the bank", () => {
  async function seed(u: TestUser) {
    await saved(u, mcq("Mitochondria make energy", { difficulty: "EASY", subject: "Biology", topic: "Cells", tags: ["energy"] }));
    await saved(u, mcq("Photosynthesis happens in chloroplasts", { difficulty: "HARD", subject: "Biology", topic: "Plants", tags: ["plants", "energy"] }));
    await saved(u, mcq("বাংলাদেশের রাজধানী কোথায়?", { language: "bn", difficulty: "EASY", subject: "Geography", topic: "Capitals", tags: [] }));
    await saved(u, cq("Explain the water cycle", { difficulty: "MEDIUM", subject: "Geography", topic: "Water", tags: ["water"] }));
  }

  it("paginates, filters and searches (case-insensitively) within the caller's data", async () => {
    const [u, other] = [await createUser(), await createUser()];
    await seed(u);
    await saved(other, mcq("Mitochondria of another user"));
    const c = client(t, u);
    const list = async (qs: string) => (await (await c.get(`/api/questions${qs}`)).json()) as { items: { stem: string }[]; total: number; page: number; pageSize: number };

    const all = await list("");
    expect(all.total).toBe(4);
    expect(all.items.every((i) => !i.stem.includes("another user"))).toBe(true);
    const p1 = await list("?pageSize=3");
    const p2 = await list("?pageSize=3&page=2");
    expect([p1.items.length, p2.items.length]).toEqual([3, 1]);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.stem)).size).toBe(4);

    expect((await list("?q=MITOCHONDRIA")).items.map((i) => i.stem)).toEqual(["Mitochondria make energy"]);
    expect((await list("?q=plants")).total).toBe(1); // topic / tag
    expect((await list("?q=geography")).total).toBe(2); // subject
    expect((await list("?kind=CQ")).total).toBe(1);
    expect((await list("?difficulty=EASY")).total).toBe(2);
    expect((await list("?language=bn")).total).toBe(1);
    expect((await list("?tag=ENERGY")).total).toBe(2);
    expect((await list("?subject=Geography&difficulty=EASY")).total).toBe(1);
    expect((await list("?q=বাংলাদেশ")).total).toBe(1);
    expect((await list("?sort=difficulty")).items[0]!.stem).toMatch(/Mitochondria|বাংলাদেশ/);
    expect((await c.get("/api/questions?pageSize=51")).status).toBe(422);
    expect((await c.get("/api/questions?kind=XYZ")).status).toBe(422);
  });

  it("lists facets with counts for the caller only", async () => {
    const [u, other] = [await createUser(), await createUser()];
    await seed(u);
    await saved(other, mcq("Other", { subject: "Secret", tags: ["secret"] }));
    const f = await (await client(t, u).get("/api/questions/facets")).json();
    expect(f.subjects).toEqual(expect.arrayContaining([{ value: "Biology", count: 2 }, { value: "Geography", count: 2 }]));
    expect(JSON.stringify(f)).not.toMatch(/secret/i);
    expect(f.tags).toEqual(expect.arrayContaining([{ value: "energy", count: 2 }]));
  });

  it("exposes limits and the resolved task models", async () => {
    const u = await createUser();
    const res = await (await client(t, u).get("/api/questions/limits")).json();
    expect(res.limits).toMatchObject({ mcqMaxQuestionsPerRun: 50, cqMaxQuestionsPerRun: 20, saveBatchMax: 100, exportMaxQuestions: 500 });
    expect(res.fields.stem).toBe(2000);
    expect(res.models).toEqual({ MCQ: null, CQ: null, EMBEDDING: null });
  });

  it("requires authentication", async () => {
    expect((await client(t).get("/api/questions")).status).toBe(401);
    expect((await client(t).post("/api/questions", { questions: [] })).status).toBe(401);
    expect((await client(t).get("/api/questions/limits")).status).toBe(401);
  });
});

describe("ownership: every operation is scoped to the owner", () => {
  it("returns 404 (not 403) for another user's question and never changes it", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const q = await saved(a, mcq("Private question"));
    const cb = client(t, b);
    expect((await cb.get(`/api/questions/${q.id}`)).status).toBe(404);
    expect((await cb.get(`/api/questions/${q.id}/revisions`)).status).toBe(404);
    expect((await cb.patch(`/api/questions/${q.id}`, { question: mcq("Hijacked") })).status).toBe(404);
    expect((await cb.patch(`/api/questions/${q.id}`, { markReviewed: true })).status).toBe(404);
    expect((await cb.delete(`/api/questions/${q.id}`)).status).toBe(404);
    expect((await cb.get("/api/questions/does-not-exist")).status).toBe(404); // same answer as "not yours"
    const row = await db.question.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.stem).toBe("Private question");
  });

  it("bulk operations ignore ids the caller doesn't own and report only what they affected", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const qa = await saved(a, mcq("A's question"));
    const qb = await saved(b, mcq("B's question"));
    const cb = client(t, b);
    expect(await (await cb.post("/api/questions/bulk", { action: "delete", ids: [qa.id] })).json()).toEqual({ affected: 0 });
    expect(await (await cb.post("/api/questions/bulk", { action: "setDifficulty", ids: [qa.id, qb.id], difficulty: "HARD" })).json()).toEqual({ affected: 1 });
    expect((await db.question.findUniqueOrThrow({ where: { id: qa.id } })).difficulty).toBe("MEDIUM");
    expect((await db.question.findUniqueOrThrow({ where: { id: qb.id } })).difficulty).toBe("HARD");
  });

  it("a question can't be added to a collection of another user, in either direction", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const qa = await saved(a, mcq("A's question"));
    const colA = (await (await client(t, a).post("/api/collections", { title: "A's" })).json()).collection;
    const colB = (await (await client(t, b).post("/api/collections", { title: "B's" })).json()).collection;
    expect(await (await client(t, b).post(`/api/collections/${colB.id}/questions`, { questionIds: [qa.id] })).json()).toEqual({ added: 0 });
    expect((await client(t, b).post(`/api/collections/${colA.id}/questions`, { questionIds: [qa.id] })).status).toBe(404);
    // the database refuses it even if application code were bypassed
    await expect(db.collectionQuestion.create({ data: { collectionId: colB.id, questionId: qa.id, position: 0 } })).rejects.toThrow(/same owner/);
  });
});

describe("editing", () => {
  it("bumps the version and writes a revision only when exam-visible content changes", async () => {
    const u = await createUser();
    const c = client(t, u);
    const q = await saved(u, mcq("Original stem"));
    const edit = (over: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      c.patch(`/api/questions/${q.id}`, { question: { ...mcq("Original stem"), options: q.options.map((o) => ({ id: o.id, text: o.text })), correctOptionId: q.correctOptionId, ...over }, ...extra });

    // metadata only: same version, no revision
    const meta = (await (await edit({ tags: ["new"], topic: "Other topic", difficulty: "HARD" })).json()).question;
    expect(meta).toMatchObject({ version: 1, difficulty: "HARD", topic: "Other topic", tags: ["new"], modifiedByUser: false });
    expect(await db.questionRevision.count({ where: { questionId: q.id } })).toBe(1);

    // content change: version 2 + revision with the new content; option ids are kept for options that stay
    const changed = (await (await edit({ stem: "Changed stem", correctOptionId: q.options[2]!.id })).json()).question;
    expect(changed.version).toBe(2);
    expect(changed.stem).toBe("Changed stem");
    expect(changed.options.map((o: { id: string }) => o.id)).toEqual(q.options.map((o) => o.id));
    expect(changed.correctOptionId).toBe(q.options[2]!.id);
    const revs = (await (await c.get(`/api/questions/${q.id}/revisions`)).json()).items;
    expect(revs.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect(revs[1].question.stem).toBe("Original stem"); // the old version is immutable
    expect(revs[1].question.correctOptionId).toBe(q.correctOptionId);
    const rows = await db.questionOption.findMany({ where: { questionId: q.id } });
    expect(rows.filter((r) => r.isCorrect).map((r) => r.id)).toEqual([q.options[2]!.id]);
  });

  it("supports adding, removing and reordering options, with new options getting server ids", async () => {
    const u = await createUser();
    const c = client(t, u);
    const q = await saved(u, mcq("Reorder me"));
    const res = await c.patch(`/api/questions/${q.id}`, {
      question: { ...mcq("Reorder me"), options: [{ id: q.options[3]!.id, text: q.options[3]!.text }, { text: "Brand new option" }, { id: q.options[1]!.id, text: q.options[1]!.text }], correctOptionId: q.options[1]!.id },
    });
    const got = (await res.json()).question;
    expect(got.options.map((o: { text: string }) => o.text)).toEqual([q.options[3]!.text, "Brand new option", q.options[1]!.text]);
    expect(got.options[0].id).toBe(q.options[3]!.id);
    expect(got.options[1].id).not.toBe(q.options[0]!.id);
    expect(got.correctOptionId).toBe(q.options[1]!.id);
  });

  it("uses optimistic concurrency and can't change the kind or collide with another question", async () => {
    const u = await createUser();
    const c = client(t, u);
    const q = await saved(u, mcq("Concurrent"));
    const other = await saved(u, mcq("Other question"));
    expect((await c.patch(`/api/questions/${q.id}`, { question: mcq("Concurrent edit"), expectedVersion: 5 })).status).toBe(409);
    expect((await c.patch(`/api/questions/${q.id}`, { question: cq("Now a CQ") })).status).toBe(422);
    // making this question identical to another one is refused rather than silently merged
    const clash = await c.patch(`/api/questions/${q.id}`, { question: { ...mcq("Other question"), options: other.options.map((o) => ({ text: o.text })), correctOptionId: `#${other.options.findIndex((o) => o.id === other.correctOptionId)}` } });
    expect(clash.status).toBe(422);
    expect((await c.patch(`/api/questions/${q.id}`, {})).status).toBe(422);
  });

  it("validates edits exactly like saves (no way around the rules via PATCH)", async () => {
    const u = await createUser();
    const q = await saved(u, mcq("Strict"));
    const c = client(t, u);
    expect((await c.patch(`/api/questions/${q.id}`, { question: mcq("Strict", { correctOptionId: null }) })).status).toBe(422);
    expect((await c.patch(`/api/questions/${q.id}`, { question: mcq("Strict", { options: [{ text: "x" }], correctOptionId: "#0" }) })).status).toBe(422);
    expect((await c.patch(`/api/questions/${q.id}`, { question: { ...mcq("Strict"), sourceSupport: "SOURCE_QUOTED" } })).status).toBe(422);
    expect((await db.question.findUniqueOrThrow({ where: { id: q.id } })).version).toBe(1);
  });

  it("marks a question as reviewed without creating a version", async () => {
    const u = await createUser();
    const q = await saved(u, mcq("Needs a look"));
    await db.question.update({ where: { id: q.id }, data: { reviewReasons: ["SOLVER_DISAGREES"] } });
    const c = client(t, u);
    expect((await (await c.get(`/api/questions/${q.id}`)).json()).question.needsReview).toBe(true);
    const res = (await (await c.patch(`/api/questions/${q.id}`, { markReviewed: true })).json()).question;
    expect(res).toMatchObject({ needsReview: false, version: 1 });
    expect(res.reviewedAt).toBeTruthy();
    expect((await (await c.get("/api/questions?needsReview=true")).json()).total).toBe(0);
  });

  it("deletes a question with all its children", async () => {
    const u = await createUser();
    const q = await saved(u, cq("Delete me"));
    expect((await client(t, u).delete(`/api/questions/${q.id}`)).status).toBe(200);
    expect(await db.questionPart.count({ where: { questionId: q.id } })).toBe(0);
    expect(await db.modelAnswer.count({ where: { questionId: q.id } })).toBe(0);
    expect(await db.questionRevision.count({ where: { questionId: q.id } })).toBe(0);
    expect((await client(t, u).get(`/api/questions/${q.id}`)).status).toBe(404);
  });
});

describe("bulk actions and database integrity", () => {
  it("adds tags, sets difficulty, marks reviewed, manages collection membership and deletes", async () => {
    const u = await createUser();
    const c = client(t, u);
    const a = await saved(u, mcq("Bulk A"));
    const b = await saved(u, mcq("Bulk B"));
    const col = (await (await c.post("/api/collections", { title: "Bulk set" })).json()).collection;
    const ids = [a.id, b.id];
    expect(await (await c.post("/api/questions/bulk", { action: "addTags", ids, tags: ["Exam", " Week 2 "] })).json()).toEqual({ affected: 2 });
    expect((await db.question.findUniqueOrThrow({ where: { id: a.id } })).tags).toEqual(["bio", "exam", "week 2"]);
    expect(await (await c.post("/api/questions/bulk", { action: "setDifficulty", ids, difficulty: "EASY" })).json()).toEqual({ affected: 2 });
    expect(await (await c.post("/api/questions/bulk", { action: "markReviewed", ids })).json()).toEqual({ affected: 2 });
    expect(await (await c.post("/api/questions/bulk", { action: "addToCollection", ids, collectionId: col.id })).json()).toEqual({ affected: 2 });
    expect(await (await c.post("/api/questions/bulk", { action: "addToCollection", ids, collectionId: col.id })).json()).toEqual({ affected: 0 }); // idempotent
    expect(await (await c.post("/api/questions/bulk", { action: "removeFromCollection", ids: [a.id], collectionId: col.id })).json()).toEqual({ affected: 1 });
    expect((await c.post("/api/questions/bulk", { action: "setDifficulty", ids })).status).toBe(422);
    expect((await c.post("/api/questions/bulk", { action: "addToCollection", ids })).status).toBe(422);
    expect((await c.post("/api/questions/bulk", { action: "delete", ids: Array.from({ length: 201 }, (_, i) => `id${i}`) })).status).toBe(422);
    expect(await (await c.post("/api/questions/bulk", { action: "delete", ids })).json()).toEqual({ affected: 2 });
    expect(await db.collectionQuestion.count({ where: { collectionId: col.id } })).toBe(0);
  });

  it("the database allows only one correct option and one part-less answer per question", async () => {
    const u = await createUser();
    const q = await saved(u, mcq("Integrity"));
    await expect(db.questionOption.updateMany({ where: { questionId: q.id }, data: { isCorrect: true } })).rejects.toThrow();
    const d = await saved(u, { kind: "CQ", language: "en", stem: "One answer only", difficulty: "EASY", marks: 3, answerText: "First" });
    await expect(db.modelAnswer.create({ data: { questionId: d.id, text: "Second", basis: "USER_PROVIDED" } })).rejects.toThrow();
    await expect(db.question.update({ where: { id: q.id }, data: { negativeMarks: 5 } })).rejects.toThrow(); // CHECK negativeMarks <= marks
  });

  it("deleting a source document keeps the evidence snapshot but unlinks it", async () => {
    const u = await createUser();
    const q = await saved(u, mcq("Evidence snapshot"));
    const doc = await db.document.create({ data: { ownerId: u.id, name: "notes.pdf", extension: "pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: `sha-${Date.now()}`, storageKey: `u/${u.id}/k${Date.now()}`, status: "READY" } });
    await db.questionSource.create({ data: { questionId: q.id, ordinal: 0, documentId: doc.id, documentName: "notes.pdf", page: 2, quote: "verbatim text", quoteVerified: true } });
    await db.document.delete({ where: { id: doc.id } });
    const got = (await (await client(t, u).get(`/api/questions/${q.id}`)).json()).question;
    expect(got.sources).toEqual([{ documentName: "notes.pdf", documentId: null, page: 2, section: null, quote: "verbatim text", quoteVerified: true }]);
  });
});

afterEach(() => {
  delete process.env.QUESTION_MAX_PER_USER;
});
