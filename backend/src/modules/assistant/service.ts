import type { SessionUser } from "../../auth/types.js";
import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError, Errors } from "../../lib/errors.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { loadPlanData } from "../analysis/context.js";
import type { SessionInput } from "../analysis/schemas.js";
import { createConversation } from "../conversations/service.js";
import { isReleased } from "../exams/release.js";

/**
 * Study assistant sessions (PART5_SPEC §5). The assistant is NOT a new chat engine: it creates a normal conversation (same ownership,
 * document-only/general policy, quotas, citations and injection defences as Part 2) and hands the client a first prompt built only from
 * data the caller may already see. The client sends that prompt through the existing message stream.
 */

export type AssistantSession = { conversationId: string | null; prompt: string | null; href: string };

const enc = encodeURIComponent;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const clip = (s: string | null | undefined, n: number) => ((s ?? "").length > n ? `${(s ?? "").slice(0, n - 1)}…` : (s ?? ""));

export async function createSession(user: SessionUser, input: SessionInput): Promise<AssistantSession> {
  await enforceRateLimit({ key: `assistant:${user.id}`, limit: 20, windowSec: 3600 });
  switch (input.kind) {
    case "PRACTICE_QUESTIONS":
      return { conversationId: null, prompt: null, href: `/mcq?topic=${enc(input.topic)}&grounding=GENERAL` };
    case "RELATED_CQ":
      return { conversationId: null, prompt: null, href: `/cq?topic=${enc(input.topic)}&grounding=GENERAL` };
    case "EXPLAIN_INCORRECT":
      return explainIncorrect(user, input.attemptId, input.questionId);
    case "TOPIC_SUMMARY":
      return topicSummary(user, input.topic, input.documentIds);
    case "REVISION_PLAN":
      return revisionPlan(user);
  }
}

async function start(user: SessionUser, title: string, prompt: string, mode: "GENERAL" | "DOCUMENT_ONLY", documentIds: string[] = []): Promise<AssistantSession> {
  const max = getEnv().CHAT_MAX_MESSAGE_CHARS;
  const conv = await createConversation(user, { title: clip(title, 120), mode, ...(documentIds.length ? { documentIds } : {}) });
  return { conversationId: conv.id, prompt: clip(prompt, max), href: `/chat/${conv.id}` };
}

async function explainIncorrect(user: SessionUser, attemptId: string, questionId: string): Promise<AssistantSession> {
  const attempt = await db.examAttempt.findFirst({ where: { id: attemptId, userId: user.id }, include: { result: { include: { items: { where: { examQuestionId: questionId } } } } } });
  if (!attempt) throw Errors.notFound();
  if (!attempt.result) throw new AppError("CONFLICT", "This attempt hasn't been submitted yet.", { status: attempt.status });
  const v = await db.examVersion.findUniqueOrThrow({ where: { id: attempt.examVersionId }, select: { releaseMode: true, closesAt: true, releaseAt: true, reviewPolicy: true } });
  if (!isReleased(v, clockNow())) throw new AppError("CONFLICT", "Results for this exam haven't been released yet.", { released: false });
  if (v.reviewPolicy !== "FULL") throw new AppError("NOT_ELIGIBLE", "This exam doesn't show correct answers, so the assistant can't explain them.");
  const item = attempt.result.items[0];
  const q = await db.examQuestionSnapshot.findFirst({ where: { id: questionId, examVersionId: attempt.examVersionId }, include: { options: { orderBy: { position: "asc" } } } });
  if (!q || !item) throw Errors.notFound();
  if (item.outcome === "CORRECT") throw new AppError("CONFLICT", "Only incorrect or unanswered questions can be explained.", { outcome: item.outcome });
  const options = q.options.map((o, i) => `${LETTERS[i]}. ${clip(o.text, 400)}`).join("\n");
  const sel = q.options.findIndex((o) => o.id === item.selectedOptionId);
  const correct = q.options.findIndex((o) => o.isCorrect);
  const prompt = [
    "Please explain this exam question to me. Explain why the correct answer is right and, if I chose an answer, what the misunderstanding might be. Keep it clear and practical, and suggest one way to remember it.",
    "",
    `Question: ${clip(q.stem, 1000)}`,
    options,
    `My answer: ${sel >= 0 ? `${LETTERS[sel]}. ${clip(q.options[sel]!.text, 400)}` : "(I left it unanswered)"}`,
    `Correct answer: ${LETTERS[correct]}. ${clip(q.options[correct]?.text, 400)}`,
    q.explanation ? `Explanation provided with the exam: ${clip(q.explanation, 1500)}` : "",
  ].filter(Boolean).join("\n");
  return start(user, `Review: ${clip(q.stem, 60)}`, prompt, "GENERAL");
}

async function topicSummary(user: SessionUser, topic: string, documentIds: string[]): Promise<AssistantSession> {
  const unique = [...new Set(documentIds)];
  const docs = await db.document.findMany({ where: { id: { in: unique }, ownerId: user.id }, select: { id: true, status: true } });
  if (docs.length !== unique.length) throw Errors.notFound(); // foreign ids look like missing ones (same rule as chat)
  if (!docs.some((d) => d.status === "READY")) throw new AppError("VALIDATION", "None of the selected documents is ready yet.", { fields: { documentIds: "Wait for processing to finish." } });
  const prompt = `Summarise what my documents say about “${topic}”. Use only the documents, organise the summary with short headings, and cite your sources.`;
  return start(user, `Summary: ${topic}`, prompt, "DOCUMENT_ONLY", unique);
}

async function revisionPlan(user: SessionUser): Promise<AssistantSession> {
  const d = await loadPlanData(user.id);
  if (d.level === "NONE") throw new AppError("CONFLICT", "You need at least one released exam result first.", { dataLevel: "NONE" });
  const lines = (list: typeof d.weak) => list.map((t) => `- ${t.topic}: ${t.correct} of ${t.questions} correct`).join("\n");
  const prompt = [
    "Please help me build a short revision plan from my real exam results below. Do not invent scores or topics, and note that this is based on limited data" + (d.level === "BASED_ON_HISTORY" ? "." : " (initial suggestions)."),
    d.weak.length ? `Topics to work on:\n${lines(d.weak)}` : "No topic is clearly weak yet.",
    d.strong.length ? `Topics going well:\n${lines(d.strong)}` : "",
    d.notEnough.length ? `Not enough answers yet to judge: ${d.notEnough.map((t) => t.topic).join(", ")}` : "",
  ].filter(Boolean).join("\n\n");
  return start(user, "Revision plan", prompt, "GENERAL");
}
