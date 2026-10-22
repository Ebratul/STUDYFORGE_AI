import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { questionInclude, toView } from "./content.js";
import { questionLimits } from "./limits.js";
import type { collectionFields } from "./schemas.js";
import type { CollectionView } from "./types.js";

type Tx = Prisma.TransactionClient;
type CollectionInput = { [K in keyof typeof collectionFields]: z.infer<(typeof collectionFields)[K]> };

export const titleKeyOf = (title: string) => title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

type Row = { id: string; title: string; description: string | null; subject: string | null; createdAt: Date; updatedAt: Date; _count: { questions: number } };
const toView_ = (r: Row): CollectionView => ({
  id: r.id,
  title: r.title,
  description: r.description,
  subject: r.subject,
  questionCount: r._count.questions,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
const select = { id: true, title: true, description: true, subject: true, createdAt: true, updatedAt: true, _count: { select: { questions: true } } } as const;

/** Throws NotFound for missing *and* foreign collections (no existence oracle). */
export async function ownedCollection(userId: string, id: string) {
  const c = await db.questionCollection.findFirst({ where: { id, ownerId: userId }, select });
  if (!c) throw Errors.notFound();
  return c;
}

export async function toCollectionView(tx: Tx, id: string): Promise<CollectionView> {
  return toView_(await tx.questionCollection.findUniqueOrThrow({ where: { id }, select }));
}

const duplicateTitle = () => new AppError("CONFLICT", "You already have a collection with that name.", { fields: { title: "You already have a collection with that name." } });

export async function createCollectionTx(tx: Tx, userId: string, input: CollectionInput) {
  const limits = questionLimits();
  if ((await tx.questionCollection.count({ where: { ownerId: userId } })) >= limits.collectionMaxPerUser)
    throw new AppError("VALIDATION", `You can have up to ${limits.collectionMaxPerUser} collections.`, { fields: { title: "Collection limit reached." } });
  return tx.questionCollection.create({ data: { ownerId: userId, title: input.title, titleKey: titleKeyOf(input.title), description: input.description ?? null, subject: input.subject ?? null }, select: { id: true } });
}

/** Adds members at the end (idempotent). The DB trigger additionally rejects cross-owner membership. */
export async function appendToCollection(tx: Tx, collectionId: string, questionIds: string[]): Promise<void> {
  if (!questionIds.length) return;
  const last = await tx.collectionQuestion.aggregate({ where: { collectionId }, _max: { position: true } });
  let pos = (last._max.position ?? -1) + 1;
  await tx.collectionQuestion.createMany({ data: [...new Set(questionIds)].map((questionId) => ({ collectionId, questionId, position: pos++ })), skipDuplicates: true });
  await tx.questionCollection.update({ where: { id: collectionId }, data: { updatedAt: new Date() } });
}

export async function listCollections(user: SessionUser, q: { q?: string | undefined; page: number; pageSize: number }) {
  const where: Prisma.QuestionCollectionWhereInput = { ownerId: user.id, ...(q.q ? { title: { contains: q.q, mode: "insensitive" } } : {}) };
  const [total, rows] = await Promise.all([
    db.questionCollection.count({ where }),
    db.questionCollection.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, select }),
  ]);
  return { items: rows.map(toView_), total, page: q.page, pageSize: q.pageSize };
}

export async function createCollection(user: SessionUser, input: CollectionInput): Promise<CollectionView> {
  try {
    return await db.$transaction(async (tx) => toCollectionView(tx, (await createCollectionTx(tx, user.id, input)).id));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw duplicateTitle();
    throw err;
  }
}

export async function getCollection(user: SessionUser, id: string): Promise<CollectionView> {
  return toView_(await ownedCollection(user.id, id));
}

export async function updateCollection(user: SessionUser, id: string, input: Partial<CollectionInput>): Promise<CollectionView> {
  await ownedCollection(user.id, id);
  try {
    const row = await db.questionCollection.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title, titleKey: titleKeyOf(input.title) } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
      },
      select,
    });
    return toView_(row);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw duplicateTitle();
    throw err;
  }
}

export async function deleteCollection(user: SessionUser, id: string): Promise<void> {
  const { count } = await db.questionCollection.deleteMany({ where: { id, ownerId: user.id } }); // members are removed, questions stay
  if (!count) throw Errors.notFound();
}

export async function listCollectionQuestions(user: SessionUser, id: string, q: { page: number; pageSize: number }) {
  await ownedCollection(user.id, id);
  const where = { collectionId: id, question: { ownerId: user.id } };
  const [total, rows] = await Promise.all([
    db.collectionQuestion.count({ where }),
    db.collectionQuestion.findMany({ where, orderBy: [{ position: "asc" }, { addedAt: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { question: { include: questionInclude } } }),
  ]);
  return { items: rows.map((r) => toView(r.question)), total, page: q.page, pageSize: q.pageSize };
}

/** All members in order (used by export). */
export async function collectionMemberViews(user: SessionUser, id: string, max: number) {
  const c = await ownedCollection(user.id, id);
  const rows = await db.collectionQuestion.findMany({ where: { collectionId: id, question: { ownerId: user.id } }, orderBy: [{ position: "asc" }, { addedAt: "asc" }], take: max + 1, include: { question: { include: questionInclude } } });
  return { collection: c, questions: rows.map((r) => toView(r.question)) };
}

export async function addToCollection(user: SessionUser, id: string, questionIds: string[]): Promise<{ added: number }> {
  const c = await ownedCollection(user.id, id);
  const ownedSet = new Set((await db.question.findMany({ where: { id: { in: questionIds }, ownerId: user.id }, select: { id: true } })).map((r) => r.id));
  const owned = [...new Set(questionIds)].filter((qid) => ownedSet.has(qid)); // keeps the order the caller sent
  const limits = questionLimits();
  return db.$transaction(async (tx) => {
    const members = new Set((await tx.collectionQuestion.findMany({ where: { collectionId: c.id }, select: { questionId: true } })).map((m) => m.questionId));
    const fresh = owned.filter((qid) => !members.has(qid));
    if (members.size + fresh.length > limits.collectionMaxQuestions)
      throw new AppError("VALIDATION", `A collection can hold up to ${limits.collectionMaxQuestions} questions.`, { fields: { questionIds: "This collection is full." } });
    await appendToCollection(tx, c.id, fresh);
    return { added: fresh.length };
  });
}

export async function removeFromCollection(user: SessionUser, id: string, questionId: string): Promise<void> {
  const c = await ownedCollection(user.id, id);
  const { count } = await db.collectionQuestion.deleteMany({ where: { collectionId: c.id, questionId } });
  if (!count) throw Errors.notFound();
  await db.questionCollection.update({ where: { id: c.id }, data: { updatedAt: new Date() } });
}

export async function reorderCollection(user: SessionUser, id: string, questionIds: string[]): Promise<void> {
  const c = await ownedCollection(user.id, id);
  const members = await db.collectionQuestion.findMany({ where: { collectionId: c.id }, select: { questionId: true } });
  const current = new Set(members.map((m) => m.questionId));
  const given = new Set(questionIds);
  if (given.size !== questionIds.length || given.size !== current.size || [...given].some((q) => !current.has(q)))
    throw new AppError("VALIDATION", "The new order must list every question in the collection exactly once.", { fields: { questionIds: "Send each question once." } });
  await db.$transaction([
    ...questionIds.map((questionId, position) => db.collectionQuestion.update({ where: { collectionId_questionId: { collectionId: c.id, questionId } }, data: { position } })),
    db.questionCollection.update({ where: { id: c.id }, data: { updatedAt: new Date() } }),
  ]);
}
