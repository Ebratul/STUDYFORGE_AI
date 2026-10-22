import { z } from "zod";
import type { ConversationMode, Prisma } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { getEnv } from "../../config/env.js";
import type { SessionUser } from "../../auth/types.js";

export const DEFAULT_TITLE = "New conversation";

export const createSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["GENERAL", "DOCUMENT_ONLY"]).optional(),
  documentIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});
export const updateSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(120, "Use at most 120 characters.").optional(),
  mode: z.enum(["GENERAL", "DOCUMENT_ONLY"]).optional(),
  documentIds: z.array(z.string().min(1).max(64)).max(50).optional(),
});

export type CitationView = {
  ordinal: number;
  documentId: string | null;
  documentName: string;
  page: number | null;
  section: string | null;
  quote: string;
  quoteVerified: boolean;
};

export type MessageView = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  status: "COMPLETE" | "STREAMING" | "INTERRUPTED" | "FAILED";
  mode: ConversationMode | null;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  insufficientEvidence: boolean;
  createdAt: string;
  citations: CitationView[];
};

export type ConversationView = {
  id: string;
  title: string;
  mode: ConversationMode;
  documentIds: string[];
  lastMessageAt: string;
  createdAt: string;
};

type ConvRow = Prisma.ConversationGetPayload<{ include: { documents: { select: { documentId: true } } } }>;
const withDocs = { documents: { select: { documentId: true } } } as const;

function toView(c: ConvRow): ConversationView {
  return { id: c.id, title: c.title, mode: c.mode, documentIds: c.documents.map((d) => d.documentId), lastMessageAt: c.lastMessageAt.toISOString(), createdAt: c.createdAt.toISOString() };
}

type MsgRow = Prisma.MessageGetPayload<{ include: { citations: true } }>;
export function toMessageView(m: MsgRow): MessageView {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status,
    mode: m.mode,
    provider: m.provider?.toLowerCase() ?? null,
    model: m.model,
    errorCode: m.errorCode,
    insufficientEvidence: m.insufficientEvidence,
    createdAt: m.createdAt.toISOString(),
    citations: [...m.citations]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => ({ ordinal: c.ordinal, documentId: c.documentId, documentName: c.documentName, page: c.page, section: c.section, quote: c.quote, quoteVerified: c.quoteVerified })),
  };
}

/** Every conversation access goes through this: the owner is part of the WHERE clause. */
export async function ownedConversation(user: SessionUser, id: string) {
  const conv = await db.conversation.findFirst({ where: { id, userId: user.id }, include: withDocs });
  if (!conv) throw Errors.notFound();
  return conv;
}

/** All ids must be documents owned by the user; otherwise 404 (foreign ids are indistinguishable from missing ones). */
async function assertOwnedDocuments(user: SessionUser, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length > getEnv().CHAT_MAX_DOCUMENTS) throw new AppError("VALIDATION", `You can attach up to ${getEnv().CHAT_MAX_DOCUMENTS} documents to a conversation.`);
  if (unique.length === 0) return unique;
  const count = await db.document.count({ where: { id: { in: unique }, ownerId: user.id } });
  if (count !== unique.length) throw Errors.notFound();
  return unique;
}

export async function createConversation(user: SessionUser, input: z.infer<typeof createSchema>) {
  const docIds = await assertOwnedDocuments(user, input.documentIds ?? []);
  const conv = await db.conversation.create({
    data: {
      userId: user.id,
      title: input.title ?? DEFAULT_TITLE,
      mode: input.mode ?? (docIds.length ? "DOCUMENT_ONLY" : "GENERAL"),
      documents: { create: docIds.map((documentId) => ({ documentId })) },
    },
    include: withDocs,
  });
  return toView(conv);
}

export async function getConversation(user: SessionUser, id: string) {
  return toView(await ownedConversation(user, id));
}

export async function updateConversation(user: SessionUser, id: string, patch: z.infer<typeof updateSchema>) {
  await ownedConversation(user, id);
  const docIds = patch.documentIds ? await assertOwnedDocuments(user, patch.documentIds) : undefined;
  const conv = await db.$transaction(async (tx) => {
    if (docIds) {
      await tx.conversationDocument.deleteMany({ where: { conversationId: id } });
      if (docIds.length) await tx.conversationDocument.createMany({ data: docIds.map((documentId) => ({ conversationId: id, documentId })) });
    }
    return tx.conversation.update({
      where: { id },
      data: { ...(patch.title ? { title: patch.title } : {}), ...(patch.mode ? { mode: patch.mode } : {}) },
      include: withDocs,
    });
  });
  return toView(conv);
}

export async function deleteConversation(user: SessionUser, id: string) {
  const { count } = await db.conversation.deleteMany({ where: { id, userId: user.id } });
  if (count === 0) throw Errors.notFound();
  await recordAudit({ actorId: user.id, action: "conversation.deleted", targetType: "conversation", targetId: id });
}

const encodeCursor = (d: Date, id: string) => Buffer.from(`${d.toISOString()}|${id}`).toString("base64url");
function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const at = new Date(iso ?? "");
    if (!id || Number.isNaN(at.getTime())) throw new Error("bad");
    return { at, id };
  } catch {
    throw new AppError("VALIDATION", "Invalid cursor.");
  }
}

export async function listConversations(user: SessionUser, opts: { q?: string; cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const q = opts.q?.trim().slice(0, 100);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const where: Prisma.ConversationWhereInput = {
    userId: user.id,
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { messages: { some: { content: { contains: q, mode: "insensitive" } } } }] } : {}),
    ...(cursor ? { AND: [{ OR: [{ lastMessageAt: { lt: cursor.at } }, { lastMessageAt: cursor.at, id: { lt: cursor.id } }] }] } : {}),
  };
  const rows = await db.conversation.findMany({ where, include: withDocs, orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], take: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(toView), nextCursor: rows.length > limit && last ? encodeCursor(last.lastMessageAt, last.id) : null };
}

/** Newest-first paging of history; the page itself is returned in chronological order. */
export async function listMessages(user: SessionUser, conversationId: string, opts: { before?: string; limit?: number }) {
  await ownedConversation(user, conversationId);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  let beforeFilter: Prisma.MessageWhereInput = {};
  if (opts.before) {
    const anchor = await db.message.findFirst({ where: { id: opts.before, conversationId }, select: { createdAt: true, id: true } });
    if (!anchor) throw Errors.notFound();
    beforeFilter = { OR: [{ createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }] };
  }
  const rows = await db.message.findMany({
    where: { conversationId, ...beforeFilter },
    include: { citations: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { items: page.map(toMessageView), nextBefore: hasMore ? (page[0]?.id ?? null) : null };
}
