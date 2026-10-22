import { Hono } from "hono";
import { parseWith } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth } from "../../http/middleware.js";
import { getLeaderboard, getParticipants } from "./leaderboard.js";
import { idSchema, pageSchema } from "./schemas.js";
import { getGroupTopics } from "./topics.js";

/** /api/exams/:id/leaderboard and /api/exams/:id/participants (mounted next to the exam routes; implemented by the groups module). */
export function leaderboardRoutes() {
  const r = new Hono<AppEnv>();
  const page = (url: string) => parseWith(pageSchema, Object.fromEntries(new URL(url).searchParams));
  r.get("/:id/leaderboard", requireAuth, async (c) => c.json(await getLeaderboard(c.get("user"), parseWith(idSchema, c.req.param("id")), page(c.req.url))));
  r.get("/:id/participants", requireAuth, async (c) => c.json(await getParticipants(c.get("user"), parseWith(idSchema, c.req.param("id")), page(c.req.url))));
  r.get("/:id/topics", requireAuth, async (c) => c.json(await getGroupTopics(c.get("user"), parseWith(idSchema, c.req.param("id")))));
  return r;
}
