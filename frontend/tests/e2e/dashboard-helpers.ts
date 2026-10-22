import type { Page } from "@playwright/test";
import { expect } from "./fixtures";
import { publishExam, seedBank, startAttempt, type ExamOptions } from "./exam-helpers";
import { api } from "./questions-helpers";

export type Pick = "right" | "wrong" | "skip";

/** Answers an attempt through the API (option text decides right/wrong: seeded questions have "Right answer" and "Wrong answer one…") and submits it. */
export async function answerAndSubmit(page: Page, attemptId: string, picks: Pick[]): Promise<void> {
  const view = await api(page, "GET", `/api/attempts/${attemptId}`);
  expect(view.status(), await view.text()).toBe(200);
  const body = await view.json();
  const questions = (body.attempt ?? body).questions as { id: string; options: { id: string; text: string }[] }[];
  const answers = questions.flatMap((q, i) => {
    const how = picks[i] ?? "skip";
    if (how === "skip") return [];
    const opt = q.options.find((o) => (how === "right" ? o.text === "Right answer" : o.text !== "Right answer"));
    return opt ? [{ questionId: q.id, optionId: opt.id, marked: false, seq: 1 }] : [];
  });
  if (answers.length) expect((await api(page, "PUT", `/api/attempts/${attemptId}/answers`, { answers })).status()).toBe(200);
  const sub = await api(page, "POST", `/api/attempts/${attemptId}/submit`, {});
  expect(sub.status(), await sub.text()).toBeLessThan(300);
}

/** Seeds a bank, publishes an exam, takes it with the given picks and returns the attempt id. */
export async function takeExam(page: Page, picks: Pick[], opts: ExamOptions = {}): Promise<{ examId: string; attemptId: string }> {
  const ids = await seedBank(page, picks.length);
  const examId = await publishExam(page, ids, { durationMinutes: 20, ...opts });
  const attemptId = await startAttempt(page, examId);
  await answerAndSubmit(page, attemptId, picks);
  return { examId, attemptId };
}
