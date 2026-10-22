import { Hono } from "hono";
import { getAuth } from "./auth/auth.js";
import type { RagAgentClient } from "./clients/rag-agent.js";
import { db } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import type { AppEnv } from "./http/context.js";
import { onError, onNotFound, requestContext, sameOriginGuard } from "./http/middleware.js";
import { accountRoutes } from "./modules/account/routes.js";
import { aiRoutes } from "./modules/ai/routes.js";
import { conversationRoutes } from "./modules/conversations/routes.js";
import { documentRoutes } from "./modules/documents/routes.js";
import { attemptRoutes, examRoutes } from "./modules/exams/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { analysisRoutes } from "./modules/analysis/routes.js";
import { analyticsRoutes } from "./modules/analytics/routes.js";
import { assistantRoutes } from "./modules/assistant/routes.js";
import { groupRoutes } from "./modules/groups/routes.js";
import { leaderboardRoutes } from "./modules/groups/leaderboard-routes.js";
import { collectionRoutes, exportRoutes, generationRoutes, questionRoutes } from "./modules/questions/routes.js";
import type { Storage } from "./modules/documents/storage/types.js";

export type Deps = { rag: RagAgentClient; storage: Storage };

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use("*", requestContext);
  app.onError(onError);
  app.notFound(onNotFound);

  // Liveness (no dependencies) and readiness (database; AI service status is informational).
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/ready", async (c) => {
    try {
      await db.$queryRaw`SELECT 1`;
    } catch (err) {
      logger.error("ready.db_unreachable", { err });
      return c.json({ status: "unavailable" }, 503);
    }
    return c.json({ status: "ready", ai: (await deps.rag.ready()) ? "up" : "down" });
  });

  // CSRF: every mutating /api request must carry our own Origin (the browser sends the frontend origin).
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health" || c.req.path === "/api/ready") return next();
    return sameOriginGuard(c, next);
  });

  // Better Auth owns /api/auth/* (sessions, passwords, verification, recovery).
  app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth().handler(c.req.raw));

  app.route("/api", accountRoutes);
  app.route("/api/ai", aiRoutes(deps.rag));
  app.route("/api/conversations", conversationRoutes(deps.rag));
  app.route("/api/documents", documentRoutes(deps.storage));
  app.route("/api/questions", questionRoutes());
  app.route("/api/collections", collectionRoutes());
  app.route("/api/generation", generationRoutes(deps.rag));
  app.route("/api/export", exportRoutes());
  app.route("/api/exams", examRoutes());
  app.route("/api/exams", leaderboardRoutes());
  app.route("/api/attempts", attemptRoutes());
  app.route("/api/groups", groupRoutes());
  app.route("/api/analysis", analysisRoutes());
  app.route("/api/assistant", assistantRoutes());
  app.route("/api/analytics", analyticsRoutes());
  app.route("/api/admin", adminRoutes(deps));
  return app;
}
