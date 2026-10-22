import { Hono } from "hono";
import { readJson } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth } from "../../http/middleware.js";
import { sessionSchema } from "../analysis/schemas.js";
import { createSession } from "./service.js";

/** POST /api/assistant/sessions (PART5_SPEC §5). */
export function assistantRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);
  r.post("/sessions", async (c) => c.json(await createSession(c.get("user"), await readJson(c.req.raw, sessionSchema)), 201));
  return r;
}
