import { Hono } from "hono";
import type { RagAgentClient } from "../../clients/rag-agent.js";
import { parseWith, readJson } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth, requirePermissionMw } from "../../http/middleware.js";
import type { Storage } from "../documents/storage/types.js";
import { auditQuery, idParam, metricsQuery, patchUserBody, usersQuery } from "./schemas.js";
import { auditEvents, effectiveConfig, health, jobs, listUsers, metrics, overview, retryJob, revokeUserSessions, updateUser, usage } from "./service.js";

const query = (c: { req: { url: string } }) => Object.fromEntries(new URL(c.req.url).searchParams);

/**
 * /api/admin/* (PART5_SPEC §9). Every route needs a specific permission; callers without it get 404 so the surface does not advertise itself.
 * There is deliberately NO route here that reads another user's conversations, documents, credentials, answers or attempts.
 */
export function adminRoutes(deps: { rag: RagAgentClient; storage: Storage }) {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  r.get("/overview", requirePermissionMw("admin:dashboard:view"), async (c) => c.json(await overview()));

  r.get("/users", requirePermissionMw("admin:users:view"), async (c) => c.json(await listUsers(c.get("user"), parseWith(usersQuery, query(c)))));
  r.patch("/users/:id", requirePermissionMw("admin:users:manage"), async (c) =>
    c.json({ user: await updateUser(c.get("user"), parseWith(idParam, c.req.param("id")), await readJson(c.req.raw, patchUserBody)) }),
  );
  r.post("/users/:id/revoke-sessions", requirePermissionMw("admin:users:manage"), async (c) => c.json(await revokeUserSessions(c.get("user"), parseWith(idParam, c.req.param("id")))));

  r.get("/usage", requirePermissionMw("admin:usage:view"), async (c) => c.json(await usage()));
  r.get("/metrics", requirePermissionMw("admin:metrics:view"), async (c) => c.json(await metrics(parseWith(metricsQuery, query(c)).hours)));

  r.get("/jobs", requirePermissionMw("admin:jobs:view"), async (c) => c.json(await jobs()));
  r.post("/jobs/:id/retry", requirePermissionMw("admin:jobs:manage"), async (c) => c.json(await retryJob(c.get("user"), parseWith(idParam, c.req.param("id")))));

  r.get("/health", requirePermissionMw("admin:health:view"), async (c) => c.json(await health(deps)));
  r.get("/audit", requirePermissionMw("admin:audit:view"), async (c) => c.json(await auditEvents(parseWith(auditQuery, query(c)))));
  r.get("/config", requirePermissionMw("admin:config:view"), (c) => c.json({ config: effectiveConfig() }));
  return r;
}
