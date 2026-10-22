import { createHash } from "node:crypto";
import { db } from "../../lib/db.js";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Canonical JSON: object keys sorted recursively (PostgreSQL jsonb does not preserve key order). */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): Json => {
    if (Array.isArray(v)) return v.map(norm);
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
    }
    return (v ?? null) as Json;
  };
  return JSON.stringify(norm(value));
}

export type SnapshotHeader = {
  title: string; description: string | null; mode: string; groupId: string | null; durationSeconds: number; attemptLimit: number;
  opensAt: Date | null; closesAt: Date | null; shuffleQuestions: boolean; shuffleOptions: boolean; reviewPolicy: string; releaseMode: string; releaseAt: Date | null;
  lateStart: string; lateJoinGroup: boolean; leaderboardVisible: boolean; reminderMinutes: number | null; negativeMarkingBp: number; questionCount: number; totalCenti: number;
};
export type SnapshotQuestion = {
  position: number; sourceQuestionId: string | null; sourceQuestionVersion: number; stem: string; explanation: string | null; shortNote: string | null; topic: string | null;
  subject: string | null; difficulty: string; language: string; marksCenti: number; negativeCenti: number; sources: unknown;
  options: { position: number; text: string; isCorrect: boolean }[];
};

/** SHA-256 over the full grading-relevant content: header (rules, window, policies) + every question, option and key. */
export function snapshotHash(header: SnapshotHeader, questions: SnapshotQuestion[]): string {
  const h = {
    ...header,
    opensAt: header.opensAt?.toISOString() ?? null,
    closesAt: header.closesAt?.toISOString() ?? null,
    releaseAt: header.releaseAt?.toISOString() ?? null,
  };
  const qs = [...questions]
    .sort((a, b) => a.position - b.position)
    .map((q) => ({ ...q, options: [...q.options].sort((a, b) => a.position - b.position) }));
  return createHash("sha256").update(canonicalJson({ header: h, questions: qs })).digest("hex");
}

/** Recomputes the hash from the stored rows. `MISMATCH` would mean a published snapshot was altered. */
export async function verifySnapshot(versionId: string): Promise<"OK" | "MISMATCH"> {
  const v = await db.examVersion.findUnique({ where: { id: versionId }, include: { questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } } } });
  if (!v) return "MISMATCH";
  const header: SnapshotHeader = {
    title: v.title, description: v.description, mode: v.mode, groupId: v.groupId, durationSeconds: v.durationSeconds, attemptLimit: v.attemptLimit, opensAt: v.opensAt, closesAt: v.closesAt,
    shuffleQuestions: v.shuffleQuestions, shuffleOptions: v.shuffleOptions, reviewPolicy: v.reviewPolicy, releaseMode: v.releaseMode, releaseAt: v.releaseAt, lateStart: v.lateStart,
    lateJoinGroup: v.lateJoinGroup, leaderboardVisible: v.leaderboardVisible, reminderMinutes: v.reminderMinutes, negativeMarkingBp: v.negativeMarkingBp, questionCount: v.questionCount, totalCenti: v.totalCenti,
  };
  const questions: SnapshotQuestion[] = v.questions.map((q) => ({
    position: q.position, sourceQuestionId: q.sourceQuestionId, sourceQuestionVersion: q.sourceQuestionVersion, stem: q.stem, explanation: q.explanation, shortNote: q.shortNote, topic: q.topic,
    subject: q.subject, difficulty: q.difficulty, language: q.language, marksCenti: q.marksCenti, negativeCenti: q.negativeCenti, sources: q.sources,
    options: q.options.map((o) => ({ position: o.position, text: o.text, isCorrect: o.isCorrect })),
  }));
  return snapshotHash(header, questions) === v.snapshotHash ? "OK" : "MISMATCH";
}
