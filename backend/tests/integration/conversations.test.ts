import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent, ChatRequest } from "../../src/clients/rag-agent.js";
import { RagAgentError } from "../../src/clients/rag-agent.js";
import { db } from "../../src/lib/db.js";
import { INSUFFICIENT_EVIDENCE_MESSAGE } from "../../src/modules/conversations/chat.js";
import { client, makeApp, readSse, setupAi, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});

async function readyDoc(u: TestUser, name = "bio.txt", model = "mock-embed") {
  return db.document.create({
    data: { ownerId: u.id, name, extension: "txt", mimeType: "text/plain", sizeBytes: 100, sha256: randomUUID(), storageKey: `u/${u.id}/${randomUUID().replaceAll("-", "")}`, status: "READY", embeddingModel: model, embeddingProvider: "MOCK", processingVersion: 1 },
  });
}
async function newConv(u: TestUser, body: Record<string, unknown> = {}) {
  const res = await client(t, u).post("/api/conversations", body);
  return (await res.json()).conversation as { id: string; title: string; mode: string; documentIds: string[] };
}
const send = (u: TestUser, id: string, body: unknown, signal?: AbortSignal) => {
  const headers = new Headers(u.headers);
  headers.set("origin", "http://localhost:3100");
  headers.set("content-type", "application/json");
  return t.app.request(`/api/conversations/${id}/messages`, { method: "POST", headers, body: JSON.stringify(body), signal });
};
const answerWith = (content: string, extra: Partial<Extract<ChatEvent, { event: "final" }>["data"]> = {}) =>
  async function* (): AsyncGenerator<ChatEvent> {
    yield { event: "meta", data: { mode: "x", provider: "mock", model: "mock-chat", documents_considered: 0, retrieval: "skipped" } };
    yield { event: "delta", data: { text: content } };
    yield { event: "final", data: { content, fallback: false, insufficient_evidence: false, finish_reason: "stop", usage: { prompt_tokens: 12, completion_tokens: 8 }, ...extra } };
  };

describe("conversation CRUD, search and ownership", () => {
  it("creates, renames, lists (paginated) and deletes", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const c = client(t, u);
    const created = await Promise.all(["Alpha", "Beta", "Gamma"].map((title) => c.post("/api/conversations", { title }).then((r) => r.json())));
    expect(created).toHaveLength(3);
    const p1 = await (await c.get("/api/conversations?limit=2")).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await (await c.get(`/api/conversations?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x: { id: string }) => x.id)).size).toBe(3);

    const id = p1.items[0].id;
    expect((await (await c.patch(`/api/conversations/${id}`, { title: "Renamed" })).json()).conversation.title).toBe("Renamed");
    expect((await c.patch(`/api/conversations/${id}`, { title: "   " })).status).toBe(422);
    expect((await c.delete(`/api/conversations/${id}`)).status).toBe(200);
    expect((await c.get(`/api/conversations/${id}`)).status).toBe(404);
  });

  it("searches titles and message text, case-insensitively, within the caller's data only", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const ca = client(t, a);
    const c1 = await newConv(a, { title: "Photosynthesis notes" });
    const c2 = await newConv(a, { title: "Other" });
    await db.message.create({ data: { conversationId: c2.id, role: "USER", content: "What is MITOCHONDRIA?" } });
    const bConv = await newConv(b, { title: "Photosynthesis for B" });
    const titles = async (q: string) => (await (await ca.get(`/api/conversations?q=${encodeURIComponent(q)}`)).json()).items.map((i: { id: string }) => i.id);
    expect(await titles("photosynth")).toEqual([c1.id]);
    expect(await titles("mitochondria")).toEqual([c2.id]);
    expect(await titles("nothing-matches")).toEqual([]);
    expect(await titles("B")).not.toContain(bConv.id);
  });

  it("cross-user: B cannot read, rename, delete, list messages of, or post to A's conversation", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await setupAi(t, a);
    await setupAi(t, b);
    const conv = await newConv(a);
    await db.message.create({ data: { conversationId: conv.id, role: "USER", content: "private" } });
    const cb = client(t, b);
    expect((await cb.get(`/api/conversations/${conv.id}`)).status).toBe(404);
    expect((await cb.patch(`/api/conversations/${conv.id}`, { title: "pwn" })).status).toBe(404);
    expect((await cb.get(`/api/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await send(b, conv.id, { content: "hi" })).status).toBe(404);
    expect((await cb.delete(`/api/conversations/${conv.id}`)).status).toBe(404);
    expect((await (await cb.get("/api/conversations")).json()).items).toEqual([]);
    expect(await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).toMatchObject({ title: "New conversation" });
    expect(t.rag.chatCalls).toHaveLength(0);
  });

  it("attaching documents requires owning every one of them", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const mine = await readyDoc(a);
    const theirs = await readyDoc(b);
    const ca = client(t, a);
    expect((await ca.post("/api/conversations", { documentIds: [mine.id, theirs.id] })).status).toBe(404);
    const conv = await newConv(a, { documentIds: [mine.id] });
    expect(conv.documentIds).toEqual([mine.id]);
    expect(conv.mode).toBe("DOCUMENT_ONLY");
    expect((await ca.patch(`/api/conversations/${conv.id}`, { documentIds: [theirs.id] })).status).toBe(404);
    expect((await (await ca.get(`/api/conversations/${conv.id}`)).json()).conversation.documentIds).toEqual([mine.id]);
  });

  it("pages long histories newest-first with a stable cursor", async () => {
    const u = await createUser();
    const conv = await newConv(u);
    const base = Date.now() - 100_000;
    for (let i = 0; i < 12; i++) await db.message.create({ data: { conversationId: conv.id, role: i % 2 ? "ASSISTANT" : "USER", content: `m${i}`, createdAt: new Date(base + i * 1000) } });
    const c = client(t, u);
    const p1 = await (await c.get(`/api/conversations/${conv.id}/messages?limit=5`)).json();
    expect(p1.items.map((m: { content: string }) => m.content)).toEqual(["m7", "m8", "m9", "m10", "m11"]);
    const p2 = await (await c.get(`/api/conversations/${conv.id}/messages?limit=5&before=${p1.nextBefore}`)).json();
    expect(p2.items.map((m: { content: string }) => m.content)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
    const p3 = await (await c.get(`/api/conversations/${conv.id}/messages?limit=5&before=${p2.nextBefore}`)).json();
    expect(p3.items.map((m: { content: string }) => m.content)).toEqual(["m0", "m1"]);
    expect(p3.nextBefore).toBeNull();
  });
});

describe("general chat", () => {
  it("streams, persists both turns, titles the conversation, records usage and uses the selected model", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    const res = await send(u, conv.id, { content: "Explain osmosis simply" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["message_start", "meta", "delta", "delta", "final"]);
    expect(events[0]!.data.title).toBe("Explain osmosis simply");
    expect(events.at(-1)!.data.message).toMatchObject({ role: "ASSISTANT", content: "Hello world", status: "COMPLETE", provider: "mock", model: "mock-chat" });

    const msgs = await db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
    expect(msgs.map((m) => [m.role, m.status, m.content])).toEqual([["USER", "COMPLETE", "Explain osmosis simply"], ["ASSISTANT", "COMPLETE", "Hello world"]]);
    expect(msgs[1]).toMatchObject({ promptTokens: 10, completionTokens: 5 });
    expect((await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).title).toBe("Explain osmosis simply");
    const usage = await (await client(t, u).get("/api/ai/usage")).json();
    expect(usage).toMatchObject({ tokens: 15, requests: 1 });
    expect(t.rag.chatCalls[0]).toMatchObject({ user_id: u.id, mode: "GENERAL", use_documents: false, document_ids: [], chat: { provider: "mock", model: "mock-chat" } });
  });

  it("follow-ups include prior completed turns as bounded history", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    t.rag.chatScript = answerWith("first answer");
    await readSse(await send(u, conv.id, { content: "first question" }));
    t.rag.chatScript = answerWith("second answer");
    await readSse(await send(u, conv.id, { content: "follow up" }));
    expect(t.rag.chatCalls[1]!.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow up" },
    ]);
  });

  it("an upstream failure is persisted as FAILED, reported with a safe message, and can be retried (regenerate)", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    t.rag.chatScript = async function* () {
      yield { event: "error", data: { code: "PROVIDER_RATE_LIMITED", message: "The provider is rate limiting requests.", retryable: true, retry_after_seconds: 7 } };
    };
    const failed = await readSse(await send(u, conv.id, { content: "hello" }));
    expect(failed.at(-1)).toMatchObject({ event: "error", data: { code: "PROVIDER_RATE_LIMITED", retryable: true, retryAfter: 7 } });
    const [userMsg, assistantMsg] = await db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
    expect(assistantMsg).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_RATE_LIMITED" });

    t.rag.chatScript = answerWith("recovered");
    const retried = await readSse(await send(u, conv.id, { regenerate: true }));
    expect(retried.at(-1)!.data.message.content).toBe("recovered");
    const after = await db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "asc" } });
    expect(after.map((m) => [m.role, m.status])).toEqual([["USER", "COMPLETE"], ["ASSISTANT", "COMPLETE"]]);
    expect(after[0]!.id).toBe(userMsg!.id); // the question is not duplicated
    expect(t.rag.chatCalls.at(-1)!.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });

  it("an unexpected transport failure never surfaces internals or the provider key", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    // eslint-disable-next-line require-yield
    t.rag.chatScript = async function* () {
      throw new RagAgentError("UPSTREAM_UNAVAILABLE", "The AI service is unavailable right now. Please try again shortly.", true, null, 503);
    };
    const text = JSON.stringify(await readSse(await send(u, conv.id, { content: "hello" })));
    expect(text).toContain("UPSTREAM_UNAVAILABLE");
    expect(text).not.toContain("mock-valid-key");
  });

  it("stopping mid-stream keeps the partial text as INTERRUPTED", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    const abort = new AbortController();
    t.rag.chatScript = async function* (_req: ChatRequest, signal?: AbortSignal) {
      yield { event: "delta", data: { text: "partial " } };
      yield { event: "delta", data: { text: "answer" } };
      await new Promise<void>((_r, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    };
    const res = await send(u, conv.id, { content: "long one" });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    while (!seen.includes("answer")) seen += dec.decode((await reader.read()).value);
    await reader.cancel(); // what the browser does when the user presses Stop
    abort.abort();
    for (let i = 0; i < 50; i++) {
      const m = await db.message.findFirst({ where: { conversationId: conv.id, role: "ASSISTANT" } });
      if (m?.status === "INTERRUPTED") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await db.message.findFirstOrThrow({ where: { conversationId: conv.id, role: "ASSISTANT" } })).toMatchObject({ status: "INTERRUPTED", content: "partial answer" });
  });

  it("only one reply may stream per conversation; abandoned placeholders are recovered", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    const stuck = await db.message.create({ data: { conversationId: conv.id, role: "ASSISTANT", content: "", status: "STREAMING" } });
    const blocked = await send(u, conv.id, { content: "hi" });
    expect(blocked.status).toBe(409);
    await db.message.update({ where: { id: stuck.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await send(u, conv.id, { content: "hi" })).status).toBe(200);
    expect((await db.message.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("INTERRUPTED");
  });

  it("validates input and configuration before streaming (plain JSON errors)", async () => {
    const u = await createUser();
    const conv = await newConv(u, { mode: "GENERAL" });
    const noModel = await send(u, conv.id, { content: "hi" });
    expect(noModel.status).toBe(422);
    expect((await noModel.json()).error).toMatchObject({ code: "NOT_CONFIGURED", message: expect.stringContaining("Settings") });
    await setupAi(t, u);
    expect((await send(u, conv.id, { content: "   " })).status).toBe(422);
    expect((await send(u, conv.id, { content: "x".repeat(8001) })).status).toBe(422);
    expect((await send(u, conv.id, { regenerate: true })).status).toBe(422); // nothing to regenerate
    expect(t.rag.chatCalls).toHaveLength(0);
    expect(await db.message.count({ where: { conversationId: conv.id } })).toBe(0);
  });

  it("enforces the daily AI quota before calling the provider", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    await db.usageRecord.create({ data: { userId: u.id, category: "llm.requests", quantity: 1000n } });
    const res = await send(u, conv.id, { content: "hi" });
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED");
    expect(t.rag.chatCalls).toHaveLength(0);
  });

  it("rate limits chat requests per user", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "GENERAL" });
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await send(u, conv.id, { regenerate: true })).status);
    expect(statuses).toContain(429);
  });
});

describe("document-only policy", () => {
  it("with no documents attached: fixed fallback, no provider call, no usage", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const conv = await newConv(u, { mode: "DOCUMENT_ONLY" });
    const events = await readSse(await send(u, conv.id, { content: "What is the capital of France?" }));
    expect(events.map((e) => e.event)).toEqual(["message_start", "final"]);
    expect(events[1]!.data.message).toMatchObject({ content: INSUFFICIENT_EVIDENCE_MESSAGE, insufficientEvidence: true, citations: [] });
    expect(t.rag.chatCalls).toHaveLength(0);
    expect((await (await client(t, u).get("/api/ai/usage")).json()).requests).toBe(0);
  });

  it("only the caller's READY, model-matching documents are sent for retrieval", async () => {
    const [a, b] = [await createUser(), await createUser()];
    await setupAi(t, a);
    const mine = await readyDoc(a, "mine.txt");
    const processing = await db.document.create({ data: { ownerId: a.id, name: "p.txt", extension: "txt", mimeType: "text/plain", sizeBytes: 5, sha256: randomUUID(), storageKey: `u/${a.id}/${"b".repeat(32)}`, status: "PROCESSING" } });
    const otherModel = await readyDoc(a, "old.txt", "text-embedding-ada-002");
    const theirs = await readyDoc(b, "theirs.txt");
    const conv = await newConv(a, { mode: "DOCUMENT_ONLY", documentIds: [mine.id, processing.id, otherModel.id] });
    // even if a foreign link were somehow inserted, it must never be forwarded
    await db.conversationDocument.create({ data: { conversationId: conv.id, documentId: theirs.id } });
    t.rag.chatScript = answerWith("From the notes [1]");
    const events = await readSse(await send(a, conv.id, { content: "what does it say?" }));
    expect(t.rag.chatCalls[0]!.document_ids).toEqual([mine.id]);
    expect(t.rag.chatCalls[0]).toMatchObject({ mode: "DOCUMENT_ONLY", use_documents: true, embedding: { provider: "mock", model: "mock-embed" } });
    expect(events[0]!.data.warnings.join(" ")).toMatch(/still processing|different embedding model/);
  });

  it("needs an embedding model to search documents (clear error, nothing sent)", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    const doc = await readyDoc(u);
    const conv = await newConv(u, { documentIds: [doc.id] });
    const res = await send(u, conv.id, { content: "q" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/embedding model/);
    expect(t.rag.chatCalls).toHaveLength(0);
  });

  it("persists citations, drops any that point at documents outside the authorised set, and keeps the document-only flag", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const doc = await readyDoc(u, "Biology.pdf");
    const conv = await newConv(u, { documentIds: [doc.id] });
    t.rag.chatScript = async function* () {
      yield { event: "citations", data: { citations: [
        { ordinal: 1, document_id: doc.id, document_name: "Biology.pdf", chunk_id: "c1", page: 3, section: null, quote: "Cells are the basic unit of life", quote_verified: true },
        { ordinal: 2, document_id: "someone-elses-doc", document_name: "Secret.pdf", chunk_id: "c9", page: 1, section: null, quote: "leaked", quote_verified: true },
      ] } };
      yield { event: "final", data: { content: "Cells are the basic unit of life [1]", fallback: false, insufficient_evidence: false, usage: { prompt_tokens: 50, completion_tokens: 9 } } };
    };
    const events = await readSse(await send(u, conv.id, { content: "What are cells?" }));
    const message = events.at(-1)!.data.message;
    expect(message.citations).toHaveLength(1);
    expect(message.citations[0]).toMatchObject({ ordinal: 1, documentId: doc.id, documentName: "Biology.pdf", page: 3, quote: "Cells are the basic unit of life", quoteVerified: true });
    expect(JSON.stringify(message)).not.toMatch(/Secret|leaked/);
    const history = await (await client(t, u).get(`/api/conversations/${conv.id}/messages`)).json();
    expect(history.items.at(-1).citations).toHaveLength(1);
  });

  it("a fallback from the agent is stored as insufficient evidence and is not billed as an answer", async () => {
    const u = await createUser();
    await setupAi(t, u);
    const doc = await readyDoc(u);
    const conv = await newConv(u, { documentIds: [doc.id] });
    t.rag.chatScript = answerWith(INSUFFICIENT_EVIDENCE_MESSAGE, { fallback: true, insufficient_evidence: true, usage: { prompt_tokens: null, completion_tokens: null } });
    const events = await readSse(await send(u, conv.id, { content: "unrelated" }));
    expect(events.at(-1)!.data.message).toMatchObject({ insufficientEvidence: true, content: INSUFFICIENT_EVIDENCE_MESSAGE });
    expect((await (await client(t, u).get("/api/ai/usage")).json()).requests).toBe(0);
  });
});

describe("general mode with documents", () => {
  it("uses documents only when attached, and warns instead of failing when they cannot be used", async () => {
    const u = await createUser();
    await setupAi(t, u, { embedding: false });
    const doc = await readyDoc(u);
    const conv = await newConv(u, { mode: "GENERAL", documentIds: [doc.id] });
    const events = await readSse(await send(u, conv.id, { content: "hello" }));
    expect(events[0]!.data.warnings.join(" ")).toMatch(/embedding model/);
    expect(t.rag.chatCalls[0]).toMatchObject({ mode: "GENERAL", use_documents: false, document_ids: [], embedding: null });
  });
});
