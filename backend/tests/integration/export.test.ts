import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { client, makeApp, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});

const mcq = (stem: string, over: Record<string, unknown> = {}) => ({
  kind: "MCQ", language: "en", stem, difficulty: "EASY", topic: "Secret-topic", subject: "Biology", tags: ["private-tag"],
  options: [{ text: `${stem} A` }, { text: `${stem} B` }, { text: `${stem} C` }], correctOptionId: "#1", explanation: "Because B.", shortNote: "Note B.", ...over,
});
const inc = { answers: true, explanations: true, notes: true, sources: true };
const save = async (u: TestUser, questions: unknown[], extra: Record<string, unknown> = {}) => (await (await client(t, u).post("/api/questions", { questions, ...extra })).json()) as { items: { question: { id: string } }[]; collection: { id: string } | null };
const exp = (u: TestUser, body: Record<string, unknown>) => client(t, u).post("/api/export", { include: inc, ...body });
const text = async (res: Response) => new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));

describe("export", () => {
  it("exports saved questions as JSON with export-local ids and no private metadata", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const { items } = await save(u, [mcq("What is B?"), mcq("What is C?", { correctOptionId: "#2" })]);
    const ids = items.map((i) => i.question.id);
    const res = await exp(u, { source: { questionIds: ids }, format: "json", title: "My set" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="my-set-\d{8}\.json"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const raw = await text(res);
    const json = JSON.parse(raw);
    expect(json).toMatchObject({ format: "studyforge.questions", version: 1, title: "My set" });
    expect(json.questions).toHaveLength(2);
    expect(json.questions[0]).toMatchObject({ kind: "MCQ", stem: "What is B?", correctOptionId: json.questions[0].options[1].id });
    expect(json.questions[0].options.map((o: { id: string }) => o.id)).toEqual(["a", "b", "c"]);

    // nothing internal leaks
    for (const secret of [...ids, u.id, u.email, "mock", "mock-chat", "generationRunId", "ownerId", "documentId", "reviewReasons", "provenance"]) expect(raw).not.toContain(secret);
    expect(await exp(other, { source: { questionIds: ids }, format: "json" }).then((r) => r.status)).toBe(404); // someone else's ids: nothing to export
  });

  it("honours the include flags in every format", async () => {
    const u = await createUser();
    const { items } = await save(u, [mcq("Flags question")]);
    const body = { source: { questionIds: [items[0]!.question.id] } };
    const without = { answers: false, explanations: false, notes: false, sources: false };
    const json = JSON.parse(await text(await exp(u, { ...body, format: "json", include: without })));
    expect(json.questions[0]).not.toHaveProperty("correctOptionId", expect.anything());
    expect(json.questions[0].explanation ?? null).toBeNull();
    expect(json.questions[0].shortNote ?? null).toBeNull();
    const txtWith = await text(await exp(u, { ...body, format: "txt" }));
    const txtWithout = await text(await exp(u, { ...body, format: "txt", include: without }));
    expect(txtWith).toContain("Because B.");
    expect(txtWithout).not.toContain("Because B.");
    expect(txtWithout).toContain("Flags question");
  });

  it("exports a collection in its saved order, titled after the collection", async () => {
    const u = await createUser();
    const { items, collection } = await save(u, [mcq("First q"), mcq("Second q"), mcq("Third q")], { collection: { create: { title: "Exam 1" } } });
    const ids = items.map((i) => i.question.id);
    await client(t, u).put(`/api/collections/${collection!.id}/order`, { questionIds: [ids[2]!, ids[0]!, ids[1]!] });
    const res = await exp(u, { source: { collectionId: collection!.id }, format: "txt" });
    expect(res.headers.get("content-disposition")).toMatch(/exam-1-\d{8}\.txt/);
    const body = await text(res);
    expect(body.indexOf("Third q")).toBeLessThan(body.indexOf("First q"));
    expect(body.indexOf("First q")).toBeLessThan(body.indexOf("Second q"));
    expect(body).toContain("Exam 1");
  });

  it("exports unsaved drafts after validating them exactly like a save, and never persists them", async () => {
    const u = await createUser();
    const ok = await exp(u, { source: { drafts: [mcq("Draft one"), mcq("Draft two")] }, format: "json" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(await text(ok)).questions).toHaveLength(2);
    expect(await db.question.count({ where: { ownerId: u.id } })).toBe(0);

    const invalid = await exp(u, { source: { drafts: [mcq("Bad draft", { correctOptionId: "#9" })] }, format: "json" });
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.details.fields["source.drafts.0.correctOptionId"]).toBeTruthy();
    expect((await exp(u, { source: { drafts: [mcq("Same"), mcq("Same")] }, format: "json" })).status).toBe(422);
    expect((await exp(u, { source: { drafts: [{ ...mcq("Forged"), sources: [] }] }, format: "json" })).status).toBe(422);
  });

  it("exports a generation run, including source evidence only when asked (and never document ids)", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const res = await client(t, u).post("/api/generation/mcq", { pastedText: "Cells are small.", grounding: "SOURCE_ONLY", count: 2 });
    const raw = await res.text();
    const run = JSON.parse(/event: result\ndata: (.*)\n/.exec(raw)![1]!).run;
    const withSources = await text(await exp(u, { source: { runId: run.id }, format: "json" }));
    expect(JSON.parse(withSources).questions[0].sources[0]).toMatchObject({ documentName: "Pasted text", quoteVerified: true });
    expect(withSources).not.toContain("documentId");
    const withoutSources = JSON.parse(await text(await exp(u, { source: { runId: run.id }, format: "json", include: { ...inc, sources: false } })));
    expect(withoutSources.questions[0].sources ?? []).toEqual([]);
    expect((await exp(await createUser(), { source: { runId: run.id }, format: "json" })).status).toBe(404);
  });

  it("produces a valid PDF (including Bangla) and CQ content in text", async () => {
    const u = await createUser();
    const { items } = await save(u, [
      mcq("কোষের শক্তিঘর কোনটি?", { language: "bn", options: [{ text: "মাইটোকন্ড্রিয়া" }, { text: "রাইবোসোম" }], correctOptionId: "#0" }),
      { kind: "CQ", language: "bn", stem: "উদ্দীপকটি পড়ো", stimulus: "একটি নদীর গল্প", difficulty: "MEDIUM", parts: [{ label: "ক", level: "KNOWLEDGE", prompt: "নদী কী?", marks: 1, answerText: "প্রবাহিত জলধারা" }, { label: "খ", level: "COMPREHENSION", prompt: "ব্যাখ্যা করো", marks: 2 }] },
    ]);
    const ids = items.map((i) => i.question.id);
    const pdf = await exp(u, { source: { questionIds: ids }, format: "pdf", title: "বাংলা সেট" });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);
    expect(pdf.headers.get("content-disposition")).toMatch(/filename="questions-\d{8}\.pdf"/); // Bangla title → safe ASCII fallback name

    const txt = await text(await exp(u, { source: { questionIds: ids }, format: "txt" }));
    expect(txt).toContain("উদ্দীপকটি পড়ো");
    expect(txt).toContain("একটি নদীর গল্প");
    expect(txt).toContain("প্রবাহিত জলধারা");
    expect(txt).toMatch(/ক\)/);
  });

  it("validates the request: format, include flags, unknown keys, limits, auth and rate limiting", async () => {
    const u = await createUser();
    const { items } = await save(u, [mcq("Valid")]);
    const source = { questionIds: [items[0]!.question.id] };
    expect((await exp(u, { source, format: "docx" })).status).toBe(422);
    expect((await exp(u, { source, format: "json", include: { answers: true } })).status).toBe(422);
    expect((await exp(u, { source, format: "json", extra: 1 })).status).toBe(422);
    expect((await exp(u, { source: { questionIds: [] }, format: "json" })).status).toBe(422);
    expect((await exp(u, { source: { questionIds: Array.from({ length: 501 }, (_, i) => `id${i}`) }, format: "json" })).status).toBe(422);
    expect((await exp(u, { source: { collectionId: "nope" }, format: "json" })).status).toBe(404);
    expect((await client(t).post("/api/export", { source, format: "json", include: inc })).status).toBe(401);
    let last = 200;
    for (let i = 0; i < 22 && last !== 429; i++) last = (await exp(u, { source, format: "txt" })).status;
    expect(last).toBe(429);
  });
});
