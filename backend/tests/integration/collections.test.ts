import { beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "../../src/config/env.js";
import { db } from "../../src/lib/db.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});

const mcq = (stem: string) => ({
  kind: "MCQ", language: "en", stem, difficulty: "EASY", options: [{ text: `${stem} A` }, { text: `${stem} B` }], correctOptionId: "#0",
});
async function makeQuestions(u: TestUser, n: number, prefix = "Q") {
  const res = await client(t, u).post("/api/questions", { questions: Array.from({ length: n }, (_, i) => mcq(`${prefix} number ${i + 1} about topic ${i * 7}`)) });
  return (await res.json()).items.map((i: { question: { id: string } }) => i.question.id) as string[];
}
const newCollection = async (u: TestUser, title: string, extra: Record<string, unknown> = {}) => (await (await client(t, u).post("/api/collections", { title, ...extra })).json()).collection as { id: string; title: string; questionCount: number };
const members = async (u: TestUser, id: string, qs = "") => (await (await client(t, u).get(`/api/collections/${id}/questions${qs}`)).json()) as { items: { id: string }[]; total: number };

describe("collections", () => {
  it("creates, reads, updates and deletes; deleting keeps the questions", async () => {
    const u = await createUser();
    const c = client(t, u);
    const col = await newCollection(u, "  Midterm prep ", { description: "Chapters 1–3", subject: "Biology" });
    expect(col).toMatchObject({ title: "Midterm prep", questionCount: 0 });
    expect((await (await c.get(`/api/collections/${col.id}`)).json()).collection).toMatchObject({ description: "Chapters 1–3", subject: "Biology" });
    const patched = (await (await c.patch(`/api/collections/${col.id}`, { title: "Finals", description: null })).json()).collection;
    expect(patched).toMatchObject({ title: "Finals", description: null, subject: "Biology" });
    expect((await c.patch(`/api/collections/${col.id}`, { title: "   " })).status).toBe(422);
    expect((await c.patch(`/api/collections/${col.id}`, { owner: "x" })).status).toBe(422);

    const [q] = await makeQuestions(u, 1);
    await c.post(`/api/collections/${col.id}/questions`, { questionIds: [q] });
    expect((await c.delete(`/api/collections/${col.id}`)).status).toBe(200);
    expect((await c.get(`/api/collections/${col.id}`)).status).toBe(404);
    expect((await c.get(`/api/questions/${q}`)).status).toBe(200); // the question lives on
  });

  it("titles are unique per user, case-insensitively, and may repeat across users", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await newCollection(a, "Biology");
    const dup = await client(t, a).post("/api/collections", { title: " BIOLOGY " });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.details.fields.title).toMatch(/already have/);
    expect((await client(t, b).post("/api/collections", { title: "Biology" })).status).toBe(201);
    const other = await newCollection(a, "Chemistry");
    expect((await client(t, a).patch(`/api/collections/${other.id}`, { title: "biology" })).status).toBe(409);
    expect((await client(t, a).patch(`/api/collections/${other.id}`, { title: "Chemistry" })).status).toBe(200); // renaming to itself is fine
  });

  it("lists with search and pagination for the caller only", async () => {
    const [a, b] = [await createUser(), await createUser()];
    for (const title of ["Alpha set", "Beta set", "Gamma"]) await newCollection(a, title);
    await newCollection(b, "Alpha of B");
    const c = client(t, a);
    const list = async (qs: string) => (await (await c.get(`/api/collections${qs}`)).json()) as { items: { title: string }[]; total: number };
    expect((await list("")).total).toBe(3);
    expect((await list("?q=SET")).items.map((i) => i.title).sort()).toEqual(["Alpha set", "Beta set"]);
    const p1 = await list("?pageSize=2");
    const p2 = await list("?pageSize=2&page=2");
    expect([p1.items.length, p2.items.length]).toEqual([2, 1]);
    expect((await c.get("/api/collections?pageSize=101")).status).toBe(422);
  });

  it("adds members idempotently, in order, with a count and a per-collection cap", async () => {
    const u = await createUser();
    const c = client(t, u);
    const ids = await makeQuestions(u, 4);
    const col = await newCollection(u, "Ordered");
    expect(await (await c.post(`/api/collections/${col.id}/questions`, { questionIds: [ids[2], ids[0]] })).json()).toEqual({ added: 2 });
    expect(await (await c.post(`/api/collections/${col.id}/questions`, { questionIds: [ids[0], ids[3], "not-a-question"] })).json()).toEqual({ added: 1 });
    expect((await members(u, col.id)).items.map((i) => i.id)).toEqual([ids[2], ids[0], ids[3]]);
    expect((await (await c.get(`/api/collections/${col.id}`)).json()).collection.questionCount).toBe(3);

    process.env.COLLECTION_MAX_QUESTIONS = "3";
    resetEnvCache();
    try {
      const res = await c.post(`/api/collections/${col.id}/questions`, { questionIds: [ids[1]] });
      expect(res.status).toBe(422);
      expect((await res.json()).error.details.fields.questionIds).toMatch(/full/);
    } finally {
      delete process.env.COLLECTION_MAX_QUESTIONS;
      resetEnvCache();
    }
  });

  it("removes members and reorders only with an exact permutation", async () => {
    const u = await createUser();
    const c = client(t, u);
    const ids = await makeQuestions(u, 3);
    const col = await newCollection(u, "Reorder");
    await c.post(`/api/collections/${col.id}/questions`, { questionIds: ids });
    expect((await c.put(`/api/collections/${col.id}/order`, { questionIds: [ids[2]!, ids[0]!, ids[1]!] })).status).toBe(200);
    expect((await members(u, col.id)).items.map((i) => i.id)).toEqual([ids[2], ids[0], ids[1]]);
    for (const bad of [[ids[0]], [ids[0], ids[0], ids[1]], [...ids, "extra"], [ids[0], ids[1], "other"]])
      expect((await c.put(`/api/collections/${col.id}/order`, { questionIds: bad })).status, JSON.stringify(bad)).toBe(422);
    expect((await members(u, col.id)).items.map((i) => i.id)).toEqual([ids[2], ids[0], ids[1]]);

    expect((await c.delete(`/api/collections/${col.id}/questions/${ids[0]}`)).status).toBe(200);
    expect((await c.delete(`/api/collections/${col.id}/questions/${ids[0]}`)).status).toBe(404);
    expect((await members(u, col.id)).items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
  });

  it("paginates members in order and filters the bank by collection", async () => {
    const u = await createUser();
    const c = client(t, u);
    const ids = await makeQuestions(u, 5);
    const col = await newCollection(u, "Paged");
    await c.post(`/api/collections/${col.id}/questions`, { questionIds: ids.slice(0, 4) });
    const p1 = await members(u, col.id, "?pageSize=3");
    const p2 = await members(u, col.id, "?pageSize=3&page=2");
    expect(p1.total).toBe(4);
    expect([...p1.items, ...p2.items].map((i) => i.id)).toEqual(ids.slice(0, 4));
    const filtered = await (await c.get(`/api/questions?collectionId=${col.id}`)).json();
    expect(filtered.total).toBe(4);
    expect(filtered.items.map((i: { id: string }) => i.id)).not.toContain(ids[4]);
  });

  it("a question can belong to several collections without being copied", async () => {
    const u = await createUser();
    const c = client(t, u);
    const [q] = await makeQuestions(u, 1);
    const [a, b] = [await newCollection(u, "A"), await newCollection(u, "B")];
    await c.post(`/api/collections/${a.id}/questions`, { questionIds: [q] });
    await c.post(`/api/collections/${b.id}/questions`, { questionIds: [q] });
    expect(await db.question.count({ where: { ownerId: u.id } })).toBe(1);
    const detail = (await (await c.get(`/api/questions/${q}`)).json()).question;
    expect(detail.collections.map((x: { title: string }) => x.title).sort()).toEqual(["A", "B"]);
    await c.delete(`/api/collections/${a.id}`);
    expect((await (await c.get(`/api/questions/${q}`)).json()).question.collections).toEqual([{ id: b.id, title: "B" }]);
  });

  it("enforces the collections-per-user limit", async () => {
    const u = await createUser();
    process.env.COLLECTION_MAX_PER_USER = "2";
    resetEnvCache();
    try {
      await newCollection(u, "One");
      await newCollection(u, "Two");
      expect((await client(t, u).post("/api/collections", { title: "Three" })).status).toBe(422);
    } finally {
      delete process.env.COLLECTION_MAX_PER_USER;
      resetEnvCache();
    }
  });
});

describe("collection ownership", () => {
  it("another user gets 404 for every collection operation and can't read or change its members", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const ids = await makeQuestions(a, 2);
    const col = await newCollection(a, "Private");
    await client(t, a).post(`/api/collections/${col.id}/questions`, { questionIds: ids });
    const cb = client(t, b);
    expect((await cb.get(`/api/collections/${col.id}`)).status).toBe(404);
    expect((await cb.patch(`/api/collections/${col.id}`, { title: "Mine now" })).status).toBe(404);
    expect((await cb.delete(`/api/collections/${col.id}`)).status).toBe(404);
    expect((await cb.get(`/api/collections/${col.id}/questions`)).status).toBe(404);
    expect((await cb.post(`/api/collections/${col.id}/questions`, { questionIds: [] })).status).toBe(422);
    expect((await cb.post(`/api/collections/${col.id}/questions`, { questionIds: ids })).status).toBe(404);
    expect((await cb.delete(`/api/collections/${col.id}/questions/${ids[0]}`)).status).toBe(404);
    expect((await cb.put(`/api/collections/${col.id}/order`, { questionIds: ids })).status).toBe(404);
    expect((await cb.post("/api/questions/bulk", { action: "addToCollection", ids, collectionId: col.id })).status).toBe(404);
    expect((await cb.post("/api/questions", { questions: [mcq("Sneaky")], collection: { id: col.id } })).status).toBe(404);
    expect((await (await cb.get("/api/collections")).json()).items).toEqual([]);
    expect(await db.collectionQuestion.count({ where: { collectionId: col.id } })).toBe(2);
    expect(await db.question.count({ where: { ownerId: b.id } })).toBe(0); // the failed save above created nothing
  });
});
