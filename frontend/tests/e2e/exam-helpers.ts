import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { api } from "./questions-helpers";

/** Saves `n` hand-written MCQs to the bank (option A is correct) and returns their ids. */
export async function seedBank(page: Page, n: number, prefix = "Exam question"): Promise<string[]> {
  const questions = Array.from({ length: n }, (_, i) => ({
    kind: "MCQ", language: "en", stem: `${prefix} ${i + 1}: which option is right? ${Math.random().toString(36).slice(2, 8)}`, difficulty: "MEDIUM", topic: i % 2 ? "Energy" : "Cells",
    options: [{ text: "Right answer" }, { text: "Wrong answer one" }, { text: "Wrong answer two" }, { text: "Wrong answer three" }], correctOptionId: "#0", explanation: `Because option A is right (${i + 1}).`, shortNote: "Remember A.",
  }));
  const res = await api(page, "POST", "/api/questions", { questions, collection: { create: { title: `${prefix} set ${Date.now()}` } } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()).items as { question: { id: string } }[]).map((i) => i.question.id);
}

export type ExamOptions = {
  title?: string; durationMinutes?: number; attemptLimit?: number; negativeFraction?: number; reviewPolicy?: "NONE" | "CORRECTNESS" | "FULL";
  release?: { mode: "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME"; at?: string | null }; window?: { opensAt?: string | null; closesAt?: string | null }; shuffle?: boolean;
  group?: { id: string } | null;
};

/** Creates, fills and publishes an exam through the API (so UI tests can focus on taking it). Returns its id. */
export async function publishExam(page: Page, questionIds: string[], o: ExamOptions = {}): Promise<string> {
  const created = await api(page, "POST", "/api/exams", { title: o.title ?? "E2E exam", mode: o.group ? "GROUP" : "INDIVIDUAL", ...(o.group ? { groupId: o.group.id } : {}) });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json()).exam.id as string;
  const draft = {
    title: o.title ?? "E2E exam", description: null, questionIds, marks: { perQuestion: 1 }, negativeMarking: { fraction: o.negativeFraction ?? 0 }, durationMinutes: o.durationMinutes ?? 20, attemptLimit: o.attemptLimit ?? 2,
    window: { opensAt: o.window?.opensAt ?? null, closesAt: o.window?.closesAt ?? null }, lateStart: "CAP_AT_CLOSE", lateJoinGroup: true, shuffleQuestions: o.shuffle ?? false, shuffleOptions: o.shuffle ?? false,
    reviewPolicy: o.reviewPolicy ?? "FULL", release: { mode: o.release?.mode ?? "IMMEDIATE", at: o.release?.at ?? null }, leaderboardVisible: true, reminderMinutes: null,
  };
  const put = await api(page, "PUT", `/api/exams/${id}/draft`, draft);
  expect(put.status(), await put.text()).toBe(200);
  const pub = await api(page, "POST", `/api/exams/${id}/publish`, {});
  expect(pub.status(), await pub.text()).toBe(200);
  return id;
}

/** Starts an attempt through the API and returns its id. */
export async function startAttempt(page: Page, examId: string): Promise<string> {
  const res = await api(page, "POST", `/api/exams/${examId}/attempts`, {});
  expect(res.status(), await res.text()).toBeLessThan(300);
  return (await res.json()).attempt.id as string;
}
