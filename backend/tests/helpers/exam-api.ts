import { db } from "../../src/lib/db.js";
import { client, type TestApp } from "./http.js";
import { seedBankQuestions } from "./exam-fixtures.js";
import type { TestUser } from "./users.js";

export const iso = (ms: number) => new Date(ms).toISOString();

/** A full draft body with sensible defaults (strict schema: only known keys). */
export function draftBody(questionIds: string[], over: Record<string, unknown> = {}) {
  return { title: "Midterm exam", description: "Chapters 1–3", questionIds, marks: { perQuestion: 1 }, negativeMarking: { fraction: 0 }, durationMinutes: 30, attemptLimit: 1, ...over };
}

export type Snapshot = { versionId: string; questions: { id: string; stem: string; optionIds: string[]; correctId: string; wrongId: string; topic: string | null; marksCenti: number }[] };

export async function snapshotOf(examId: string): Promise<Snapshot> {
  const v = await db.examVersion.findFirstOrThrow({ where: { examId }, orderBy: { version: "desc" }, include: { questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } } } });
  return {
    versionId: v.id,
    questions: v.questions.map((q) => ({
      id: q.id, stem: q.stem, optionIds: q.options.map((o) => o.id), correctId: q.options.find((o) => o.isCorrect)!.id, wrongId: q.options.find((o) => !o.isCorrect)!.id, topic: q.topic, marksCenti: q.marksCenti,
    })),
  };
}

/** Creates N bank questions, a draft, saves it and publishes it through the real API. Returns the snapshot rows for use in assertions. */
export async function publishedExam(
  t: TestApp, owner: TestUser,
  opts: { n?: number; draft?: Record<string, unknown>; mode?: "INDIVIDUAL" | "GROUP"; groupId?: string; title?: string } = {},
) {
  const bank = await seedBankQuestions(owner, opts.n ?? 3);
  const c = client(t, owner);
  const created = await c.post("/api/exams", { title: opts.title ?? "Midterm exam", mode: opts.mode ?? "INDIVIDUAL", ...(opts.groupId ? { groupId: opts.groupId } : {}) });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${await created.text()}`);
  const examId = (await created.json()).exam.id as string;
  const saved = await c.put(`/api/exams/${examId}/draft`, draftBody(bank.map((b) => b.id), { title: opts.title ?? "Midterm exam", ...(opts.draft ?? {}) }));
  if (saved.status !== 200) throw new Error(`draft failed: ${saved.status} ${await saved.text()}`);
  const pub = await c.post(`/api/exams/${examId}/publish`);
  if (pub.status !== 200) throw new Error(`publish failed: ${pub.status} ${await pub.text()}`);
  return { examId, bank, snapshot: await snapshotOf(examId), exam: (await pub.json()).exam as { id: string; status: string } };
}

export const startAttempt = async (t: TestApp, u: TestUser, examId: string) => client(t, u).post(`/api/exams/${examId}/attempts`);
export async function started(t: TestApp, u: TestUser, examId: string) {
  const res = await startAttempt(t, u, examId);
  if (res.status !== 200 && res.status !== 201) throw new Error(`start failed: ${res.status} ${await res.text()}`);
  return (await res.json()).attempt as { id: string; deadlineAt: string; startedAt: string; remainingMs: number; questions: { id: string; options: { id: string }[] }[] };
}

export const ans = (questionId: string, optionId: string | null, seq: number, marked?: boolean) => ({ questionId, optionId, seq, ...(marked === undefined ? {} : { marked }) });
export const save = (t: TestApp, u: TestUser, attemptId: string, answers: unknown[]) => client(t, u).put(`/api/attempts/${attemptId}/answers`, { answers });
export const submit = (t: TestApp, u: TestUser, attemptId: string, body: Record<string, unknown> = {}) => client(t, u).post(`/api/attempts/${attemptId}/submit`, body);
export const result = (t: TestApp, u: TestUser, attemptId: string) => client(t, u).get(`/api/attempts/${attemptId}/result`);

/** Answers the first `correct` questions correctly, the next `wrong` incorrectly, and leaves the rest blank. */
export function paper(snap: Snapshot, correct: number, wrong = 0) {
  return snap.questions.flatMap((q, i) => (i < correct ? [ans(q.id, q.correctId, 1)] : i < correct + wrong ? [ans(q.id, q.wrongId, 1)] : []));
}
