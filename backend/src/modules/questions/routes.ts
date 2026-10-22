import { Hono } from "hono";
import { z } from "zod";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { parseWith, readJson } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth } from "../../http/middleware.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError, Errors } from "../../lib/errors.js";
import { enforceRateLimit } from "../../lib/rate-limit.js";
import { db } from "../../lib/db.js";
import { resolveModel } from "../ai/preferences.js";
import { toWire } from "../ai/providers.js";
import {
  addToCollection, collectionMemberViews, createCollection, deleteCollection, getCollection, listCollectionQuestions, listCollections, removeFromCollection, reorderCollection, updateCollection,
} from "./collections.js";
import { buildContent, contentFromRow, questionInclude } from "./content.js";
import { contentDisposition, exportFilename, renderExport } from "./export/index.js";
import { deleteRun, getRun, listRuns, prepareGeneration, regenerateQuestion } from "./generation.js";
import { FIELD, questionLimits } from "./limits.js";
import { bulkSchema, collectionFields, exportSchema, listQuerySchema, patchQuestionSchema, regenerateSchema, saveSchema } from "./schemas.js";
import { assertNoDuplicatesWithin, bulkAction, deleteQuestion, facets, getQuestion, listQuestions, listRevisions, loadRunContext, planInputs, saveQuestions, updateQuestion } from "./service.js";
import type { QuestionContent, RunKind } from "./types.js";

const idSchema = z.string().min(1).max(64);
const id = (c: { req: { param(n: string): string } }, name = "id") => parseWith(idSchema, c.req.param(name));
const SAVE_BYTES = 2 * 1024 * 1024;
const enc = new TextEncoder();
const sse = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const pageQuery = z.object({ q: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });

// ---------------------------------------------------------------------------------------------------------------------
export function questionRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.get("/limits", async (c) => {
    const user = c.get("user");
    const ref = async (task: "MCQ" | "CQ" | "EMBEDDING") => {
      const m = await resolveModel(user.id, task);
      return m ? { provider: toWire(m.provider), modelId: m.modelId } : null;
    };
    return c.json({
      limits: questionLimits(),
      fields: FIELD,
      models: { MCQ: await ref("MCQ"), CQ: await ref("CQ"), EMBEDDING: await ref("EMBEDDING") },
    });
  });

  r.get("/facets", async (c) => c.json(await facets(c.get("user"))));

  r.get("/", async (c) => c.json(await listQuestions(c.get("user"), parseWith(listQuerySchema, Object.fromEntries(new URL(c.req.url).searchParams)))));

  r.post("/", async (c) => c.json(await saveQuestions(c.get("user"), await readJson(c.req.raw, saveSchema(), SAVE_BYTES)), 201));

  r.post("/bulk", async (c) => c.json(await bulkAction(c.get("user"), await readJson(c.req.raw, bulkSchema()))));

  r.get("/:id", async (c) => c.json({ question: await getQuestion(c.get("user"), id(c)) }));
  r.get("/:id/revisions", async (c) => c.json(await listRevisions(c.get("user"), id(c))));
  r.patch("/:id", async (c) => c.json({ question: await updateQuestion(c.get("user"), id(c), await readJson(c.req.raw, patchQuestionSchema, SAVE_BYTES)) }));
  r.delete("/:id", async (c) => {
    await deleteQuestion(c.get("user"), id(c));
    return c.json({ ok: true });
  });
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
export function collectionRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.get("/", async (c) => c.json(await listCollections(c.get("user"), parseWith(pageQuery, Object.fromEntries(new URL(c.req.url).searchParams)))));
  r.post("/", async (c) => c.json({ collection: await createCollection(c.get("user"), await readJson(c.req.raw, z.strictObject(collectionFields))) }, 201));
  r.get("/:id", async (c) => c.json({ collection: await getCollection(c.get("user"), id(c)) }));
  r.patch("/:id", async (c) =>
    c.json({ collection: await updateCollection(c.get("user"), id(c), await readJson(c.req.raw, z.strictObject({ title: collectionFields.title.optional(), description: collectionFields.description.optional(), subject: collectionFields.subject.optional() }))) }),
  );
  r.delete("/:id", async (c) => {
    await deleteCollection(c.get("user"), id(c));
    return c.json({ ok: true });
  });

  r.get("/:id/questions", async (c) => c.json(await listCollectionQuestions(c.get("user"), id(c), parseWith(pageQuery, Object.fromEntries(new URL(c.req.url).searchParams)))));
  r.post("/:id/questions", async (c) =>
    c.json(await addToCollection(c.get("user"), id(c), (await readJson(c.req.raw, z.strictObject({ questionIds: z.array(idSchema).min(1).max(questionLimits().bulkMaxIds) }))).questionIds)),
  );
  r.delete("/:id/questions/:questionId", async (c) => {
    await removeFromCollection(c.get("user"), id(c), id(c, "questionId"));
    return c.json({ ok: true });
  });
  r.put("/:id/order", async (c) => {
    await reorderCollection(c.get("user"), id(c), (await readJson(c.req.raw, z.strictObject({ questionIds: z.array(idSchema).max(questionLimits().collectionMaxQuestions) }))).questionIds);
    return c.json({ ok: true });
  });
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
export function generationRoutes(rag: RagAgentClient) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  const start = (kind: RunKind) => async (c: import("hono").Context<AppEnv>) => {
    const body = await readJson(c.req.raw, z.record(z.string(), z.unknown()), 512 * 1024);
    const prepared = await prepareGeneration(rag, c.get("user"), kind, body);

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    c.req.raw.signal.addEventListener("abort", onAbort);
    let ping: NodeJS.Timeout | undefined;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        ping = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": ping\n\n"));
          } catch {
            /* closed */
          }
        }, 15_000);
        try {
          for await (const ev of prepared.events(abort.signal)) controller.enqueue(sse(ev.event, ev.data));
        } finally {
          clearInterval(ping);
          c.req.raw.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            /* already closed by cancel */
          }
        }
      },
      cancel() {
        abort.abort(); // Stop pressed or the tab was closed: the provider call is cancelled and the run is marked interrupted
        clearInterval(ping);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
  };

  r.post("/mcq", start("MCQ"));
  r.post("/cq", start("CQ"));

  r.get("/runs", async (c) => {
    const q = parseWith(z.object({ kind: z.enum(["MCQ", "CQ"]).optional(), limit: z.coerce.number().int().min(1).max(30).default(10) }), Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(await listRuns(c.get("user"), q));
  });
  r.get("/runs/:id", async (c) => c.json({ run: await getRun(c.get("user"), id(c)) }));
  r.delete("/runs/:id", async (c) => {
    await deleteRun(c.get("user"), id(c));
    return c.json({ ok: true });
  });
  r.post("/runs/:id/regenerate", async (c) =>
    c.json(await regenerateQuestion(rag, c.get("user"), id(c), await readJson(c.req.raw, regenerateSchema, 128 * 1024), c.req.raw.signal)),
  );
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
export function exportRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.post("/", async (c) => {
    const user = c.get("user");
    const body = await readJson(c.req.raw, exportSchema, 4 * 1024 * 1024);
    await enforceRateLimit({ key: `qexport:${user.id}`, limit: 20, windowSec: 60 });
    const max = questionLimits().exportMaxQuestions;
    let items: QuestionContent[] = [];
    let title = body.title;

    const src = body.source;
    if ("questionIds" in src) {
      const rows = await db.question.findMany({ where: { id: { in: src.questionIds }, ownerId: user.id }, include: questionInclude });
      const byId = new Map(rows.map((q) => [q.id, q]));
      items = [...new Set(src.questionIds)].flatMap((qid) => (byId.has(qid) ? [contentFromRow(byId.get(qid)!)] : [])); // foreign ids are dropped, never revealed
    } else if ("collectionId" in src) {
      const { collection, questions } = await collectionMemberViews(user, src.collectionId, max);
      title ??= collection.title;
      items = questions;
    } else if ("runId" in src && !("drafts" in src)) {
      const run = await getRun(user, src.runId);
      if (run.status !== "SUCCEEDED") throw new AppError("CONFLICT", "That generation has no questions to export.");
      items = run.questions;
    } else if ("drafts" in src) {
      const run = src.runId ? await loadRunContext(user.id, src.runId) : null;
      if (src.runId && !run) throw new AppError("VALIDATION", "That generation is no longer available.", { fields: { "source.runId": "Expired or unknown generation." } });
      const plans = planInputs(src.drafts, run, "source.drafts");
      assertNoDuplicatesWithin(plans.map((p) => p.n), "source.drafts");
      items = plans.map((p) => buildContent(p.n, p.derived));
    }
    if (!items.length) throw Errors.notFound();
    if (items.length > max) throw new AppError("VALIDATION", `You can export up to ${max} questions at a time.`);

    const result = await renderExport(items, { format: body.format, include: body.include, ...(title ? { title } : {}) });
    await recordAudit({ actorId: user.id, action: "questions.exported", targetType: "user", targetId: user.id, metadata: { format: body.format, count: items.length } });
    return new Response(result.body as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": result.contentType,
        "content-disposition": contentDisposition(exportFilename(title, result.extension)),
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });
  return r;
}
