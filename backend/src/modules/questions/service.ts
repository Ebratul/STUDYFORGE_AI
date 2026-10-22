import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { SessionUser } from "../../auth/types.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { toWire } from "../ai/providers.js";
import { buildContent, contentFromRow, draftFromContent, newId, normalizedFromContent, questionInclude, toView, type Derived, type QuestionRow } from "./content.js";
import { questionLimits } from "./limits.js";
import { deriveProvenance } from "./provenance.js";
import {
  contentHash,
  isNearDuplicate,
  normalizeInput,
  versionedHash,
  type bulkSchema,
  type listQuerySchema,
  type NormalizedQuestion,
  type patchQuestionSchema,
  type saveSchema,
} from "./schemas.js";
import { normalizeTag } from "./text.js";
import { ownedCollection, toCollectionView, createCollectionTx, appendToCollection } from "./collections.js";
import type { CollectionView, QuestionContent, QuestionDraft, QuestionView, SourceRef } from "./types.js";

type Tx = Prisma.TransactionClient;
type SaveBody = z.infer<ReturnType<typeof saveSchema>>;
type PatchBody = z.infer<typeof patchQuestionSchema>;
type BulkBody = z.infer<ReturnType<typeof bulkSchema>>;
type ListQuery = z.infer<typeof listQuerySchema>;

const fieldError = (message: string, fields: Record<string, string>) => new AppError("VALIDATION", message, { fields });

// ---------------------------------------------------------------------------------------------------------------------
// Generation-run context (the only place provenance may come from)
// ---------------------------------------------------------------------------------------------------------------------
export type RunContext = {
  id: string;
  provider: string;
  model: string;
  createdAt: Date;
  drafts: Map<string, QuestionDraft>;
};

export async function loadRunContext(userId: string, runId: string): Promise<RunContext | null> {
  const run = await db.generationRun.findFirst({ where: { id: runId, userId, status: "SUCCEEDED", expiresAt: { gt: new Date() } } });
  if (!run?.result) return null;
  const result = run.result as { questions?: QuestionDraft[] };
  return { id: run.id, provider: toWire(run.provider), model: run.model, createdAt: run.createdAt, drafts: new Map((result.questions ?? []).map((q) => [q.id, q])) };
}

/** Normalises + links each input to its run draft. Throws field errors for ids that don't resolve. */
export function planInputs(inputs: Parameters<typeof normalizeInput>[0][], run: RunContext | null, pathPrefix = "questions") {
  const fields: Record<string, string> = {};
  const plans = inputs.map((input, i) => {
    const n = normalizeInput(input);
    let draft: QuestionDraft | undefined;
    if (n.runQuestionId) {
      draft = run?.drafts.get(n.runQuestionId);
      if (!draft) fields[`${pathPrefix}.${i}.runQuestionId`] = "This question isn't part of that generation any more. Save it as your own question instead.";
      else if (draft.kind !== n.kind) fields[`${pathPrefix}.${i}.kind`] = "The question type doesn't match the generated question.";
    }
    return { index: i, n, draft, derived: deriveProvenance(n, draft) };
  });
  if (Object.keys(fields).length) throw fieldError("Some questions could not be linked to their generation.", fields);
  return plans;
}

export function assertNoDuplicatesWithin(norm: NormalizedQuestion[], pathPrefix = "questions"): void {
  const fields: Record<string, string> = {};
  for (let j = 1; j < norm.length; j++)
    for (let i = 0; i < j; i++)
      if (isNearDuplicate(norm[i]!, norm[j]!)) {
        fields[`${pathPrefix}.${j}`] = `This is a duplicate of question ${i + 1}.`;
        break;
      }
  if (Object.keys(fields).length) throw fieldError("Some questions are duplicates of each other.", fields);
}

/** Evidence snapshots keep their document link only while that document still exists and belongs to the caller. */
async function liveDocumentIds(userId: string, sources: SourceRef[]): Promise<Set<string>> {
  const ids = [...new Set(sources.map((s) => s.documentId).filter((d): d is string => Boolean(d)))];
  if (!ids.length) return new Set();
  return new Set((await db.document.findMany({ where: { id: { in: ids }, ownerId: userId }, select: { id: true } })).map((d) => d.id));
}

const allSources = (d: Derived): SourceRef[] => [...d.sources, ...d.partAnswers.flatMap((a) => a?.sources ?? []), ...(d.answer?.sources ?? [])];

// ---------------------------------------------------------------------------------------------------------------------
// Writing a question tree (flat inserts with explicit ids)
// ---------------------------------------------------------------------------------------------------------------------
type Written = { id: string; content: QuestionContent };

async function writeChildren(tx: Tx, questionId: string, n: NormalizedQuestion, d: Derived, live: Set<string>, keep?: { options: Set<string>; parts: Set<string> }): Promise<{ optionIds: string[]; partIds: string[] }> {
  const pick = (clientId: string | undefined, set: Set<string> | undefined) => (clientId && set?.has(clientId) ? clientId : newId());
  const optionIds = n.options.map((o) => pick(o.clientId, keep?.options));
  const partIds = n.parts.map((p) => pick(p.clientId, keep?.parts));
  const docId = (s: SourceRef) => (s.documentId && live.has(s.documentId) ? s.documentId : null);
  const sourceRow = (s: SourceRef, ordinal: number, answerId: string | null) => ({
    questionId, answerId, ordinal, documentId: docId(s), documentName: s.documentName.slice(0, 200), page: s.page, section: s.section?.slice(0, 200) ?? null, quote: s.quote.slice(0, 1000), quoteVerified: s.quoteVerified,
  });

  if (n.options.length)
    await tx.questionOption.createMany({ data: n.options.map((o, i) => ({ id: optionIds[i]!, questionId, position: i, text: o.text, isCorrect: i === n.correctIndex })) });
  if (n.parts.length)
    await tx.questionPart.createMany({ data: n.parts.map((p, i) => ({ id: partIds[i]!, questionId, position: i, label: p.label, level: p.level, prompt: p.prompt, marks: p.marks })) });

  const answers: { id: string; partId: string | null; a: NonNullable<Derived["answer"]> }[] = [];
  d.partAnswers.forEach((a, i) => a && answers.push({ id: newId(), partId: partIds[i]!, a }));
  if (d.answer) answers.push({ id: newId(), partId: null, a: d.answer });
  if (answers.length) await tx.modelAnswer.createMany({ data: answers.map((x) => ({ id: x.id, questionId, partId: x.partId, text: x.a.text, basis: x.a.basis })) });

  const sources = [
    ...d.sources.map((s, i) => sourceRow(s, i, null)),
    ...answers.flatMap((x) => x.a.sources.map((s, i) => sourceRow(s, i, x.id))),
  ];
  if (sources.length) await tx.questionSource.createMany({ data: sources });
  return { optionIds, partIds };
}

async function insertQuestion(tx: Tx, userId: string, p: { n: NormalizedQuestion; derived: Derived; hash: string; extraReasons: string[] }, run: RunContext | null, live: Set<string>): Promise<Written> {
  const id = newId();
  const { n, derived } = p;
  const reasons = [...new Set([...derived.reviewReasons, ...p.extraReasons])];
  await tx.question.create({
    data: {
      id, ownerId: userId, kind: n.kind, language: n.language, stem: n.stem, stimulus: n.stimulus, explanation: n.explanation, shortNote: n.shortNote,
      difficulty: n.difficulty, subject: n.subject, topic: n.topic, tags: n.tags, marks: n.marks, negativeMarks: n.negativeMarks,
      origin: derived.origin, sourceSupport: derived.sourceSupport, modifiedByUser: derived.modifiedByUser, reviewReasons: reasons, contentHash: p.hash,
      generationRunId: derived.origin === "AI_GENERATED" ? (run?.id ?? null) : null,
      provenanceProvider: derived.origin === "AI_GENERATED" ? (run?.provider ?? null) : null,
      provenanceModel: derived.origin === "AI_GENERATED" ? (run?.model ?? null) : null,
      generatedAt: derived.origin === "AI_GENERATED" ? (run?.createdAt ?? null) : null,
    },
  });
  const ids = await writeChildren(tx, id, n, derived, live);
  const content = buildContent(n, { ...derived, reviewReasons: reasons }, { options: ids.optionIds, parts: ids.partIds });
  await tx.questionRevision.create({ data: { questionId: id, version: 1, snapshot: content as unknown as Prisma.InputJsonValue } });
  return { id, content };
}

// ---------------------------------------------------------------------------------------------------------------------
// Save (create)
// ---------------------------------------------------------------------------------------------------------------------
export type SaveResult = {
  items: { index: number; status: "CREATED" | "EXISTING"; question: QuestionView }[];
  collection: CollectionView | null;
  warnings: { index: number; code: string; message: string }[];
};

async function nearDuplicateInBank(userId: string, n: NormalizedQuestion): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT q."id" FROM "Question" q
    WHERE q."ownerId" = ${userId} AND q."kind" = ${n.kind}::"QuestionKind" AND q."stem" % ${n.stem}
    ORDER BY similarity(q."stem", ${n.stem}) DESC LIMIT 5`;
  if (!rows.length) return false;
  const candidates = await db.question.findMany({ where: { id: { in: rows.map((r) => r.id) } }, include: questionInclude });
  return candidates.some((c) => isNearDuplicate(n, normalizedFromContent(contentFromRow(c)), 0.85));
}

export async function saveQuestions(user: SessionUser, body: SaveBody): Promise<SaveResult> {
  const limits = questionLimits();
  await enforceRateLimit({ key: `qsave:${user.id}`, limit: 30, windowSec: 60 });

  const run = body.runId ? await loadRunContext(user.id, body.runId) : null;
  if (body.runId && !run) throw fieldError("That generation is no longer available.", { runId: "That generation has expired or doesn't exist. Save the questions as your own instead." });
  if (!run && body.questions.some((q) => q.runQuestionId)) throw fieldError("A generation id is required.", { runId: "Include the generation these questions came from." });

  const plans = planInputs(body.questions, run);
  assertNoDuplicatesWithin(plans.map((p) => p.n));
  const hashes = plans.map((p) => contentHash(p.n));

  const existing = await db.question.findMany({ where: { ownerId: user.id, contentHash: { in: hashes } }, include: questionInclude });
  const existingByHash = new Map(existing.map((e) => [e.contentHash, e]));
  const fresh = plans.filter((_, i) => !existingByHash.has(hashes[i]!));

  const total = await db.question.count({ where: { ownerId: user.id } });
  if (total + fresh.length > limits.questionMaxPerUser)
    throw new AppError("QUOTA_EXCEEDED", `Your question bank is limited to ${limits.questionMaxPerUser} questions. Delete some questions to make room.`, { limit: limits.questionMaxPerUser });

  const collectionTarget = body.collection && "id" in body.collection ? await ownedCollection(user.id, body.collection.id) : null;
  if (collectionTarget) {
    const members = await db.collectionQuestion.count({ where: { collectionId: collectionTarget.id } });
    if (members + plans.length > limits.collectionMaxQuestions)
      throw new AppError("VALIDATION", `A collection can hold up to ${limits.collectionMaxQuestions} questions.`, { fields: { collection: "This collection is full." } });
  }
  if (body.collection && "create" in body.collection && plans.length > limits.collectionMaxQuestions)
    throw new AppError("VALIDATION", `A collection can hold up to ${limits.collectionMaxQuestions} questions.`, { fields: { collection: "Too many questions for one collection." } });

  const live = await liveDocumentIds(user.id, plans.flatMap((p) => allSources(p.derived)));
  const warnings: SaveResult["warnings"] = [];
  const extra = new Map<number, string[]>();
  for (const p of fresh) {
    if (await nearDuplicateInBank(user.id, p.n)) {
      extra.set(p.index, ["NEAR_DUPLICATE_IN_BANK"]);
      warnings.push({ index: p.index, code: "NEAR_DUPLICATE_IN_BANK", message: "A very similar question is already in your bank. Saved anyway; check for duplicates." });
    }
  }

  let result: SaveResult;
  try {
    result = await db.$transaction(async (tx) => {
      const items: SaveResult["items"] = [];
      const memberIds: string[] = [];
      for (const p of plans) {
        const ex = existingByHash.get(hashes[p.index]!);
        if (ex) {
          items.push({ index: p.index, status: "EXISTING", question: toView(ex) });
          memberIds.push(ex.id);
          continue;
        }
        const w = await insertQuestion(tx, user.id, { n: p.n, derived: p.derived, hash: hashes[p.index]!, extraReasons: extra.get(p.index) ?? [] }, run, live);
        const row = await tx.question.findUniqueOrThrow({ where: { id: w.id }, include: questionInclude });
        items.push({ index: p.index, status: "CREATED", question: toView(row) });
        memberIds.push(w.id);
      }
      let collection: CollectionView | null = null;
      if (body.collection && "create" in body.collection) {
        const c = await createCollectionTx(tx, user.id, body.collection.create);
        await appendToCollection(tx, c.id, memberIds);
        collection = await toCollectionView(tx, c.id);
      } else if (collectionTarget) {
        await appendToCollection(tx, collectionTarget.id, memberIds);
        collection = await toCollectionView(tx, collectionTarget.id);
      }
      return { items, collection, warnings };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = JSON.stringify(err.meta ?? {}); // the shape of `meta` differs between the engine and driver adapters
      if (target.includes("titleKey")) throw fieldError("You already have a collection with that name.", { "collection.create.title": "You already have a collection with that name." });
      throw new AppError("CONFLICT", "One of these questions was just saved by another request. Refresh and try again.");
    }
    throw err;
  }
  await recordAudit({ actorId: user.id, action: "questions.saved", targetType: "user", targetId: user.id, metadata: { created: result.items.filter((i) => i.status === "CREATED").length, runId: run?.id ?? null } });
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------------------------
export async function getQuestionRow(userId: string, id: string): Promise<QuestionRow> {
  const row = await db.question.findFirst({ where: { id, ownerId: userId }, include: questionInclude });
  if (!row) throw Errors.notFound(); // identical for "missing" and "someone else's"
  return row;
}

export async function getQuestion(user: SessionUser, id: string): Promise<QuestionView> {
  const row = await getQuestionRow(user.id, id);
  const memberships = await db.collectionQuestion.findMany({ where: { questionId: id, collection: { ownerId: user.id } }, select: { collection: { select: { id: true, title: true } } } });
  return toView(row, memberships.map((m) => m.collection));
}

export async function listQuestions(user: SessionUser, q: ListQuery) {
  const where: Prisma.QuestionWhereInput = {
    ownerId: user.id,
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.difficulty ? { difficulty: q.difficulty } : {}),
    ...(q.language ? { language: q.language } : {}),
    ...(q.subject ? { subject: q.subject } : {}),
    ...(q.topic ? { topic: q.topic } : {}),
    ...(q.tag ? { tags: { has: normalizeTag(q.tag) } } : {}),
    ...(q.collectionId ? { collections: { some: { collectionId: q.collectionId } } } : {}),
    ...(q.needsReview === "true" ? { reviewedAt: null, NOT: { reviewReasons: { isEmpty: true } } } : {}),
    ...(q.needsReview === "false" ? { OR: [{ reviewReasons: { isEmpty: true } }, { reviewedAt: { not: null } }] } : {}),
    ...(q.q
      ? {
          AND: [
            {
              OR: [
                { stem: { contains: q.q, mode: "insensitive" } },
                { topic: { contains: q.q, mode: "insensitive" } },
                { subject: { contains: q.q, mode: "insensitive" } },
                { tags: { has: normalizeTag(q.q) } },
              ],
            },
          ],
        }
      : {}),
  };
  const orderBy: Prisma.QuestionOrderByWithRelationInput[] =
    q.sort === "updated" ? [{ updatedAt: "desc" }, { id: "desc" }] : q.sort === "difficulty" ? [{ difficulty: "asc" }, { createdAt: "desc" }, { id: "desc" }] : [{ createdAt: "desc" }, { id: "desc" }];
  const [total, rows] = await Promise.all([
    db.question.count({ where }),
    db.question.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: questionInclude }),
  ]);
  return { items: rows.map((r) => toView(r)), total, page: q.page, pageSize: q.pageSize };
}

export async function facets(user: SessionUser) {
  const top = (rows: { value: string; count: bigint }[]) => rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  const [subjects, topics, tags] = await Promise.all([
    db.$queryRaw<{ value: string; count: bigint }[]>`SELECT "subject" AS value, count(*) AS count FROM "Question" WHERE "ownerId" = ${user.id} AND "subject" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`,
    db.$queryRaw<{ value: string; count: bigint }[]>`SELECT "topic" AS value, count(*) AS count FROM "Question" WHERE "ownerId" = ${user.id} AND "topic" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`,
    db.$queryRaw<{ value: string; count: bigint }[]>`SELECT t AS value, count(*) AS count FROM "Question", unnest("tags") AS t WHERE "ownerId" = ${user.id} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 100`,
  ]);
  return { subjects: top(subjects), topics: top(topics), tags: top(tags) };
}

export async function listRevisions(user: SessionUser, id: string) {
  const rows = await db.questionRevision.findMany({ where: { questionId: id, question: { ownerId: user.id } }, orderBy: { version: "desc" } });
  if (!rows.length) await getQuestionRow(user.id, id); // 404 for foreign/missing; a real question always has revision 1
  return { items: rows.map((r) => ({ version: r.version, createdAt: r.createdAt.toISOString(), question: r.snapshot as unknown as QuestionContent })) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Edit / delete / bulk
// ---------------------------------------------------------------------------------------------------------------------
export async function updateQuestion(user: SessionUser, id: string, body: PatchBody): Promise<QuestionView> {
  const row = await getQuestionRow(user.id, id);
  if (body.expectedVersion !== undefined && body.expectedVersion !== row.version)
    throw new AppError("CONFLICT", "This question was changed somewhere else. Reload it to see the latest version.", { currentVersion: row.version });

  if (!body.question) {
    if (!body.markReviewed) throw new AppError("VALIDATION", "Nothing to update.");
    await db.question.update({ where: { id }, data: { reviewedAt: new Date() } });
    return getQuestion(user, id);
  }

  const n = normalizeInput(body.question);
  if (n.kind !== row.kind) throw fieldError("The question type can't be changed.", { "question.kind": "The question type can't be changed." });
  const stored = contentFromRow(row);
  const derived = deriveProvenance(n, row.origin === "AI_GENERATED" ? draftFromContent(row.id, stored) : undefined);
  const hash = contentHash(n);
  if (hash !== row.contentHash) {
    const clash = await db.question.findFirst({ where: { ownerId: user.id, contentHash: hash, id: { not: id } }, select: { id: true } });
    if (clash) throw fieldError("An identical question is already in your bank.", { "question.stem": "An identical question is already in your bank." });
  }
  const versioned = versionedHash(n) !== versionedHash(normalizedFromContent(stored));
  const live = await liveDocumentIds(user.id, allSources(derived));
  const keep = { options: new Set(row.options.map((o) => o.id)), parts: new Set(row.parts.map((p) => p.id)) };
  const modified = row.modifiedByUser || derived.modifiedByUser;

  try {
    await db.$transaction(async (tx) => {
      await tx.questionOption.deleteMany({ where: { questionId: id } });
      await tx.questionPart.deleteMany({ where: { questionId: id } }); // cascades part answers + their sources
      await tx.modelAnswer.deleteMany({ where: { questionId: id } });
      const ids = await writeChildren(tx, id, n, { ...derived, sources: [] }, live, keep); // question-level sources are rows we keep as they are
      const version = versioned ? row.version + 1 : row.version;
      await tx.question.update({
        where: { id },
        data: {
          language: n.language, stem: n.stem, stimulus: n.stimulus, explanation: n.explanation, shortNote: n.shortNote, difficulty: n.difficulty,
          subject: n.subject, topic: n.topic, tags: n.tags, marks: n.marks, negativeMarks: n.negativeMarks, contentHash: hash,
          version, modifiedByUser: modified, ...(body.markReviewed ? { reviewedAt: new Date() } : {}),
        },
      });
      if (versioned) {
        const content = buildContent(n, { ...derived, sources: stored.sources, sourceSupport: stored.sourceSupport, reviewReasons: stored.reviewReasons }, { options: ids.optionIds, parts: ids.partIds });
        await tx.questionRevision.create({ data: { questionId: id, version, snapshot: content as unknown as Prisma.InputJsonValue } });
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new AppError("CONFLICT", "An identical question is already in your bank.");
    throw err;
  }
  return getQuestion(user, id);
}

export async function deleteQuestion(user: SessionUser, id: string): Promise<void> {
  const { count } = await db.question.deleteMany({ where: { id, ownerId: user.id } });
  if (!count) throw Errors.notFound();
  await recordAudit({ actorId: user.id, action: "questions.deleted", targetType: "question", targetId: id });
}

export async function bulkAction(user: SessionUser, body: BulkBody): Promise<{ affected: number }> {
  if ((body.action === "addToCollection" || body.action === "removeFromCollection") && body.collectionId) await ownedCollection(user.id, body.collectionId); // 404 before anything else
  const owned = await db.question.findMany({ where: { id: { in: body.ids }, ownerId: user.id }, select: { id: true } });
  const ownedSet = new Set(owned.map((o) => o.id));
  const ids = [...new Set(body.ids)].filter((id) => ownedSet.has(id)); // anything else is silently ignored: no existence oracle; order is kept
  if (!ids.length) return { affected: 0 };
  switch (body.action) {
    case "delete": {
      const { count } = await db.question.deleteMany({ where: { id: { in: ids }, ownerId: user.id } });
      await recordAudit({ actorId: user.id, action: "questions.bulk_deleted", targetType: "user", targetId: user.id, metadata: { count } });
      return { affected: count };
    }
    case "markReviewed":
      return { affected: (await db.question.updateMany({ where: { id: { in: ids } }, data: { reviewedAt: new Date() } })).count };
    case "setDifficulty": {
      if (!body.difficulty) throw fieldError("Choose a difficulty.", { difficulty: "Choose a difficulty." });
      return { affected: (await db.question.updateMany({ where: { id: { in: ids } }, data: { difficulty: body.difficulty } })).count };
    }
    case "addTags": {
      const tags = body.tags ?? [];
      if (!tags.length) throw fieldError("Enter at least one tag.", { tags: "Enter at least one tag." });
      const rows = await db.question.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
      let affected = 0;
      for (const r of rows) {
        const merged = [...new Set([...r.tags, ...tags])];
        if (merged.length > 10) continue; // would exceed the per-question tag limit
        await db.question.update({ where: { id: r.id }, data: { tags: merged } });
        affected++;
      }
      return { affected };
    }
    case "addToCollection": {
      if (!body.collectionId) throw fieldError("Choose a collection.", { collectionId: "Choose a collection." });
      const c = await ownedCollection(user.id, body.collectionId);
      const limits = questionLimits();
      const members = await db.collectionQuestion.findMany({ where: { collectionId: c.id }, select: { questionId: true } });
      const fresh = ids.filter((i) => !members.some((m) => m.questionId === i));
      if (members.length + fresh.length > limits.collectionMaxQuestions) throw fieldError(`A collection can hold up to ${limits.collectionMaxQuestions} questions.`, { collectionId: "This collection is full." });
      await db.$transaction((tx) => appendToCollection(tx, c.id, fresh));
      return { affected: fresh.length };
    }
    case "removeFromCollection": {
      if (!body.collectionId) throw fieldError("Choose a collection.", { collectionId: "Choose a collection." });
      const c = await ownedCollection(user.id, body.collectionId);
      return { affected: (await db.collectionQuestion.deleteMany({ where: { collectionId: c.id, questionId: { in: ids } } })).count };
    }
  }
}
