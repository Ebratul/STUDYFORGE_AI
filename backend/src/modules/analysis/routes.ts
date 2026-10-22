import { Hono } from "hono";
import { z } from "zod";
import { parseWith, readJson } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth } from "../../http/middleware.js";
import { getPlanState, requestPlan } from "./plan.js";
import { requestAnalysisSchema } from "./schemas.js";
import { getAnalysisView, requestAnalysis } from "./service.js";

const idSchema = z.string().min(1).max(64);

/** /api/analysis/* — AI feedback for a result and the personalized plan (PART5_SPEC §3–§4). Every handler is scoped to the caller. */
export function analysisRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.get("/attempts/:attemptId", async (c) => c.json({ analysis: await getAnalysisView(c.get("user"), parseWith(idSchema, c.req.param("attemptId"))) }));
  r.post("/attempts/:attemptId", async (c) =>
    c.json({ analysis: await requestAnalysis(c.get("user"), parseWith(idSchema, c.req.param("attemptId")), await readJson(c.req.raw, requestAnalysisSchema)) }, 202),
  );

  r.get("/plan", async (c) => c.json(await getPlanState(c.get("user"))));
  r.post("/plan", async (c) => {
    await readJson(c.req.raw, z.strictObject({}));
    return c.json({ plan: await requestPlan(c.get("user")) }, 202);
  });
  return r;
}
