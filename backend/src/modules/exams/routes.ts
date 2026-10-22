import { Hono } from "hono";
import { z } from "zod";
import { parseWith, readJson } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth } from "../../http/middleware.js";
import { listAttempts, getAttempt, saveAnswers, startAttempt, submitAttempt } from "./attempts.js";
import { EXAM_FIELDS, examLimits } from "./limits.js";
import { getResult } from "./results.js";
import { createExamSchema, examDraftSchema, listAttemptsSchema, listExamsSchema, saveAnswersSchema, submitSchema } from "./schemas.js";
import { cancelExam, createExam, deleteExam, duplicateExam, getExamFor, listExams, previewExam, publishExam, saveDraft } from "./service.js";

const idSchema = z.string().min(1).max(64);
const id = (c: { req: { param(n: string): string } }) => parseWith(idSchema, c.req.param("id"));
const query = (c: { req: { url: string } }) => Object.fromEntries(new URL(c.req.url).searchParams);
const BODY_BYTES = 512 * 1024;

/** /api/exams/* — drafts, publication, preview, attempt start. (Leaderboard/participants are mounted next to these by the groups module.) */
export function examRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.get("/limits", (c) => c.json({ limits: examLimits(), fields: EXAM_FIELDS }));
  r.get("/", async (c) => c.json(await listExams(c.get("user"), parseWith(listExamsSchema, query(c)))));
  r.post("/", async (c) => c.json({ exam: await createExam(c.get("user"), await readJson(c.req.raw, createExamSchema)) }, 201));

  r.get("/:id", async (c) => c.json({ exam: await getExamFor(c.get("user"), id(c)) }));
  r.put("/:id/draft", async (c) => c.json({ exam: await saveDraft(c.get("user"), id(c), await readJson(c.req.raw, examDraftSchema(), BODY_BYTES)) }));
  r.get("/:id/preview", async (c) => c.json({ preview: await previewExam(c.get("user"), id(c)) }));
  r.post("/:id/publish", async (c) => c.json({ exam: await publishExam(c.get("user"), id(c)) }));
  r.post("/:id/cancel", async (c) => c.json({ exam: await cancelExam(c.get("user"), id(c)) }));
  r.post("/:id/duplicate", async (c) => c.json({ exam: await duplicateExam(c.get("user"), id(c)) }, 201));
  r.delete("/:id", async (c) => {
    await deleteExam(c.get("user"), id(c));
    return c.json({ ok: true });
  });

  r.post("/:id/attempts", async (c) => {
    const out = await startAttempt(c.get("user"), id(c));
    return c.json(out, out.resumed ? 200 : 201);
  });
  r.get("/:id/attempts", async (c) => c.json({ items: (await listAttempts(c.get("user"), parseWith(listAttemptsSchema, { ...query(c), pageSize: "50" }), id(c))).items }));
  return r;
}

/** /api/attempts/* — read, autosave, submit, result, history. */
export function attemptRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.get("/", async (c) => c.json(await listAttempts(c.get("user"), parseWith(listAttemptsSchema, query(c)))));
  r.get("/:id", async (c) => c.json(await getAttempt(c.get("user"), id(c))));
  r.put("/:id/answers", async (c) => c.json(await saveAnswers(c.get("user"), id(c), (await readJson(c.req.raw, saveAnswersSchema, BODY_BYTES)).answers)));
  r.post("/:id/submit", async (c) => {
    const user = c.get("user");
    const attemptId = id(c);
    const body = await readJson(c.req.raw, submitSchema, BODY_BYTES);
    const { alreadyFinalized } = await submitAttempt(user, attemptId, body.answers);
    return c.json({ ...(await getResult(user, attemptId)), alreadyFinalized });
  });
  r.get("/:id/result", async (c) => c.json(await getResult(c.get("user"), id(c))));
  return r;
}
