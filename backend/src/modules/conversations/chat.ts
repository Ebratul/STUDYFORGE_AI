import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { RagAgentError, type ChatEvent, type ChatRequest, type RagAgentClient, type RagCitation } from "../../clients/rag-agent.js";
import { getEnv } from "../../config/env.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { recordProviderEvent } from "../../lib/metrics.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import type { SessionUser } from "../../auth/types.js";
import { getDecryptedKey, markCredentialInvalid } from "../ai/credentials.js";
import { documentIdentitySelect, embeddingCredentials, guidanceFor, identityOf, isCompatible, STALE_DOCUMENTS_MESSAGE, STALE_SOME_DOCUMENTS_WARNING } from "../ai/embedding-identity.js";
import { resolveModel, toWireParams } from "../ai/preferences.js";
import { toWire } from "../ai/providers.js";
import { assertWithinQuota, recordUsage } from "../ai/usage.js";
import { DEFAULT_TITLE, ownedConversation, toMessageView, type MessageView } from "./service.js";

/** Must match the text produced by rag_agent's gate (rag_agent/CONTRACT.md §4.1). Used when there are no documents to search. */
export const INSUFFICIENT_EVIDENCE_MESSAGE =
  "Sorry, I couldn't find enough relevant information in your uploaded documents to answer this question. Please upload a relevant document or ask a question about the available content.";

export const sendSchema = z.union([
  z.object({ content: z.string(), regenerate: z.undefined().optional() }),
  z.object({ regenerate: z.literal(true), content: z.undefined().optional() }),
]);

export type SseEvent = { event: string; data: unknown };

export type PreparedTurn = { events(signal: AbortSignal): AsyncGenerator<SseEvent> };

const STALE_STREAM_MS = 10 * 60 * 1000;

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || DEFAULT_TITLE;
}

/**
 * Validates everything that can fail *before* streaming starts (so the client gets a normal JSON error),
 * persists the user turn plus a STREAMING assistant placeholder, and returns the event generator.
 */
export async function prepareChat(
  rag: RagAgentClient,
  user: SessionUser,
  conversationId: string,
  input: { content?: string; regenerate?: boolean },
): Promise<PreparedTurn> {
  const env = getEnv();
  const conv = await ownedConversation(user, conversationId);
  await enforceRateLimit({ key: `chat:${user.id}`, limit: 30, windowSec: 60 });

  // One in-flight reply per conversation. Placeholders abandoned by a crashed request are marked interrupted.
  const inflight = await db.message.findMany({ where: { conversationId, status: "STREAMING" }, select: { id: true, createdAt: true } });
  const fresh = inflight.some((m) => Date.now() - m.createdAt.getTime() < STALE_STREAM_MS);
  if (fresh) throw new AppError("CONFLICT", "A response is already being generated for this conversation.");
  if (inflight.length) await db.message.updateMany({ where: { id: { in: inflight.map((m) => m.id) } }, data: { status: "INTERRUPTED" } });

  let userText: string;
  if (input.regenerate) {
    const lastUser = await db.message.findFirst({ where: { conversationId, role: "USER" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!lastUser) throw new AppError("VALIDATION", "There is nothing to regenerate yet.");
    userText = lastUser.content;
  } else {
    userText = (input.content ?? "").trim();
    if (!userText) throw new AppError("VALIDATION", "Enter a message.", { fields: { content: "Enter a message." } });
    if (userText.length > env.CHAT_MAX_MESSAGE_CHARS)
      throw new AppError("VALIDATION", `Messages can be up to ${env.CHAT_MAX_MESSAGE_CHARS} characters.`, { fields: { content: `Use at most ${env.CHAT_MAX_MESSAGE_CHARS} characters.` } });
  }

  await assertWithinQuota(user);

  const chatModel = await resolveModel(user.id, "CHAT");
  if (!chatModel) throw new AppError("NOT_CONFIGURED", "Choose a default model in Settings → AI connection before chatting.");
  const chatKey = await getDecryptedKey(user.id, chatModel.provider);
  const chat = chatModel; // narrowed copy for use inside the generator closure

  // Documents: only the caller's own READY documents attached to this conversation.
  const attachedIds = conv.documents.map((d) => d.documentId);
  const ready = attachedIds.length
    ? await db.document.findMany({ where: { id: { in: attachedIds }, ownerId: user.id, status: "READY" }, select: documentIdentitySelect })
    : [];

  const warnings: string[] = [];
  const embedding = await resolveModel(user.id, "EMBEDDING");
  let embeddingCreds: ChatRequest["embedding"] = null;
  let documentIds: string[] = [];
  if (ready.length) {
    if (!embedding) {
      if (conv.mode === "DOCUMENT_ONLY") throw new AppError("NOT_CONFIGURED", "Choose an embedding model in Settings → AI connection to search your documents.");
      warnings.push("Your documents were not used because no embedding model is configured.");
    } else {
      // Same provider + model + dimension as the vectors in the index: never mix embedding spaces (AI_CONNECTION_SPEC §3).
      const identity = identityOf(embedding);
      const matching = ready.filter((d) => isCompatible(d, identity));
      if (matching.length === 0) {
        if (conv.mode === "DOCUMENT_ONLY") throw new AppError("CONFLICT", STALE_DOCUMENTS_MESSAGE, { reason: "EMBEDDING_STALE" });
        warnings.push(STALE_DOCUMENTS_MESSAGE);
      } else {
        if (matching.length < ready.length) warnings.push(STALE_SOME_DOCUMENTS_WARNING);
        const key = await getDecryptedKey(user.id, embedding.provider);
        embeddingCreds = embeddingCredentials(embedding, key.key);
        documentIds = matching.map((d) => d.id);
      }
    }
  }
  const attachedNotReady = attachedIds.length - ready.length;
  if (attachedNotReady > 0) warnings.push(`${attachedNotReady} attached document${attachedNotReady > 1 ? "s are" : " is"} still processing or failed, so ${attachedNotReady > 1 ? "they were" : "it was"} not searched.`);

  // History: completed turns only, bounded by count and characters (newest kept).
  const past = await db.message.findMany({
    where: { conversationId, status: "COMPLETE", ...(input.regenerate ? { createdAt: { lte: (await lastUserTime(conversationId)) } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: env.CHAT_HISTORY_MAX_MESSAGES,
    select: { role: true, content: true, id: true },
  });
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let chars = userText.length;
  for (const m of past) {
    if (input.regenerate && m.role === "USER" && m.content === userText && history.length === 0) continue; // the question being regenerated
    if (chars + m.content.length > env.CHAT_HISTORY_MAX_CHARS) break;
    chars += m.content.length;
    history.unshift({ role: m.role === "USER" ? "user" : "assistant", content: m.content });
  }
  const messages = [...history, { role: "user" as const, content: userText }];

  // Persist the user turn (unless regenerating) and the assistant placeholder.
  const isFirst = (await db.message.count({ where: { conversationId } })) === 0;
  const t0 = Date.now(); // explicit timestamps: user turn < assistant placeholder, so ordering never depends on id tie-breaks
  const { userMessage, assistant } = await db.$transaction(async (tx) => {
    let userMessage = null;
    if (input.regenerate) {
      const lastUser = await tx.message.findFirst({ where: { conversationId, role: "USER" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if (lastUser) await tx.message.deleteMany({ where: { conversationId, OR: [{ createdAt: { gt: lastUser.createdAt } }, { createdAt: lastUser.createdAt, id: { gt: lastUser.id } }] } });
    } else {
      userMessage = await tx.message.create({ data: { conversationId, role: "USER", content: userText, status: "COMPLETE", mode: conv.mode, createdAt: new Date(t0) }, include: { citations: true } });
    }
    const assistant = await tx.message.create({
      data: { conversationId, role: "ASSISTANT", content: "", status: "STREAMING", mode: conv.mode, provider: chatModel.provider, model: chatModel.modelId, createdAt: new Date(t0 + 1) },
      include: { citations: true },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), ...(isFirst && conv.title === DEFAULT_TITLE && !input.regenerate ? { title: titleFrom(userText) } : {}) },
    });
    return { userMessage, assistant };
  });

  const request: ChatRequest = {
    request_id: randomUUID(),
    user_id: user.id,
    mode: conv.mode,
    chat: {
      provider: toWire(chatModel.provider),
      api_key: chatKey.key,
      model: chatModel.modelId,
      params: toWireParams(chatModel.params),
    },
    embedding: embeddingCreds,
    messages,
    document_ids: documentIds,
    use_documents: documentIds.length > 0,
    retrieval: { top_k: env.RETRIEVAL_TOP_K, min_similarity: env.RETRIEVAL_MIN_SIMILARITY, max_context_chars: env.RETRIEVAL_MAX_CONTEXT_CHARS },
  };

  const noDocumentsInDocOnly = conv.mode === "DOCUMENT_ONLY" && documentIds.length === 0;
  const authorized = new Set(documentIds);

  async function* events(signal: AbortSignal): AsyncGenerator<SseEvent> {
    yield {
      event: "message_start",
      data: {
        userMessage: userMessage ? toMessageView(userMessage) : null,
        assistantMessage: toMessageView(assistant),
        warnings,
        title: isFirst && conv.title === DEFAULT_TITLE && !input.regenerate ? titleFrom(userText) : null,
      },
    };

    // Document-only with nothing to search: answer with the fixed fallback without calling any provider.
    if (noDocumentsInDocOnly) {
      const done = await db.message.update({ where: { id: assistant.id }, data: { content: INSUFFICIENT_EVIDENCE_MESSAGE, status: "COMPLETE", insufficientEvidence: true }, include: { citations: true } });
      yield { event: "final", data: { message: toMessageView(done) } };
      return;
    }

    let content = "";
    let citations: RagCitation[] = [];
    let outcome: "final" | "error" | "interrupted" = "interrupted";
    let final: Extract<ChatEvent, { event: "final" }>["data"] | null = null;
    let failure: { code: string; message: string; retryable: boolean; retryAfter: number | null } | null = null;

    try {
      for await (const ev of rag.chatStream(request, signal)) {
        if (ev.event === "delta") {
          content += ev.data.text;
          yield { event: "delta", data: ev.data };
        } else if (ev.event === "meta" || ev.event === "status") {
          yield { event: ev.event, data: ev.data };
        } else if (ev.event === "citations") {
          // Defence in depth: only citations that point at documents this request was authorized to search.
          citations = ev.data.citations.filter((c) => authorized.has(c.document_id));
        } else if (ev.event === "final") {
          final = ev.data;
          outcome = "final";
        } else if (ev.event === "error") {
          failure = { code: ev.data.code, message: guidanceFor(ev.data.code, ev.data.message), retryable: Boolean(ev.data.retryable), retryAfter: ev.data.retry_after_seconds ?? null };
          outcome = "error";
        }
      }
      if (outcome === "interrupted" && !signal.aborted) {
        failure = { code: "UPSTREAM_UNAVAILABLE", message: "The AI service ended the response early.", retryable: true, retryAfter: null };
        outcome = "error";
      }
    } catch (err) {
      if (signal.aborted) outcome = "interrupted";
      else {
        outcome = "error";
        failure =
          err instanceof RagAgentError
            ? { code: err.code, message: err.message, retryable: err.retryable, retryAfter: err.retryAfterSeconds }
            : { code: "INTERNAL", message: "Something went wrong while generating the answer.", retryable: true, retryAfter: null };
        if (!(err instanceof RagAgentError)) logger.error("chat.stream_failed", { err });
      }
    }

    // Persist the outcome even if the client has gone away.
    let saved: MessageView | null = null;
    try {
      if (outcome === "final" && final) {
        if (!final.fallback) recordProviderEvent(chat.provider, "chat", true);
        const data: Prisma.MessageUpdateInput = {
          content: final.content,
          status: "COMPLETE",
          insufficientEvidence: Boolean(final.insufficient_evidence),
          promptTokens: final.usage?.prompt_tokens ?? null,
          completionTokens: final.usage?.completion_tokens ?? null,
          citations: {
            create: citations.map((c) => ({
              ordinal: c.ordinal,
              documentId: c.document_id,
              documentName: c.document_name.slice(0, 200),
              chunkId: c.chunk_id,
              page: c.page,
              section: c.section?.slice(0, 200) ?? null,
              quote: c.quote.slice(0, 1000),
              quoteVerified: c.quote_verified,
            })),
          },
        };
        const row = await db.message.update({ where: { id: assistant.id }, data, include: { citations: true } });
        saved = toMessageView(row);
        if (!final.fallback)
          await recordUsage(user.id, { provider: chat.provider, model: chat.modelId, task: "CHAT", promptTokens: final.usage?.prompt_tokens, completionTokens: final.usage?.completion_tokens });
      } else if (outcome === "error" && failure) {
        recordProviderEvent(chat.provider, "chat", false, failure.code);
        if (failure.code === "PROVIDER_AUTH_INVALID") await markCredentialInvalid(chatKey.credentialId);
        const row = await db.message.update({ where: { id: assistant.id }, data: { content, status: "FAILED", errorCode: failure.code }, include: { citations: true } });
        saved = toMessageView(row);
      } else {
        const row = await db.message.update({ where: { id: assistant.id }, data: { content, status: "INTERRUPTED" }, include: { citations: true } });
        saved = toMessageView(row);
      }
    } catch (err) {
      logger.error("chat.persist_failed", { err });
    }

    if (outcome === "final") yield { event: "final", data: { message: saved } };
    else if (outcome === "error" && failure) yield { event: "error", data: { ...failure, message: failure.message, message_view: saved } };
    else yield { event: "interrupted", data: { message: saved } };
  }

  return { events };
}

async function lastUserTime(conversationId: string): Promise<Date> {
  const m = await db.message.findFirst({ where: { conversationId, role: "USER" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true } });
  return m?.createdAt ?? new Date();
}
