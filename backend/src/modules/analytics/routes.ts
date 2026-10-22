import { Hono } from "hono";
import { z } from "zod";
import { parseWith } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth } from "../../http/middleware.js";
import { myAnalytics, myResults } from "./me.js";

const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10) });

/** /api/analytics/* (PART5_SPEC §7): caller-scoped, released results only. */
export function analyticsRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);
  r.get("/me", async (c) => c.json(await myAnalytics(c.get("user"))));
  r.get("/me/results", async (c) => c.json(await myResults(c.get("user"), parseWith(pageSchema, Object.fromEntries(new URL(c.req.url).searchParams)))));
  return r;
}
