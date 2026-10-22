import { Hono } from "hono";
import { z } from "zod";
import { parseWith, readJson } from "../../http/body.js";
import type { AppEnv } from "../../http/context.js";
import { requireAuth } from "../../http/middleware.js";
import { createInvite, joinGroup, listInvites, previewInvite, revokeInvite } from "./invites.js";
import { createGroupSchema, deleteGroupSchema, idSchema, inviteSchema, joinSchema, meSchema, pageSchema, roleSchema, updateGroupSchema } from "./schemas.js";
import { changeRole, createGroup, deleteGroup, getGroup, leaveGroup, listGroupExams, listGroups, listMembers, removeMember, setMyPrivacy, updateGroup } from "./service.js";

/** /api/groups/* — groups, members, invitations, join. */
export function groupRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);
  const id = (c: { req: { param(n: string): string } }, name = "id") => parseWith(idSchema, c.req.param(name));
  const page = (url: string) => parseWith(pageSchema, Object.fromEntries(new URL(url).searchParams));

  r.get("/", async (c) => c.json(await listGroups(c.get("user"))));
  r.post("/", async (c) => c.json({ group: await createGroup(c.get("user"), await readJson(c.req.raw, createGroupSchema())) }, 201));

  // Static paths first so "join" is never read as a group id.
  r.get("/join-preview", async (c) => c.json(await previewInvite(c.get("user"), parseWith(z.string().min(1).max(80), c.req.query("code") ?? ""), c.get("clientIp"))));
  r.post("/join", async (c) => c.json(await joinGroup(c.get("user"), (await readJson(c.req.raw, joinSchema)).code, c.get("clientIp"))));

  r.get("/:id", async (c) => c.json({ group: await getGroup(c.get("user"), id(c)) }));
  r.patch("/:id", async (c) => c.json({ group: await updateGroup(c.get("user"), id(c), await readJson(c.req.raw, updateGroupSchema())) }));
  r.delete("/:id", async (c) => {
    await deleteGroup(c.get("user"), id(c), await readJson(c.req.raw, deleteGroupSchema));
    return c.json({ ok: true });
  });

  r.get("/:id/members", async (c) => c.json(await listMembers(c.get("user"), id(c), page(c.req.url))));
  r.patch("/:id/members/:memberId", async (c) => {
    await changeRole(c.get("user"), id(c), id(c, "memberId"), (await readJson(c.req.raw, roleSchema)).role);
    return c.json({ ok: true });
  });
  r.delete("/:id/members/:memberId", async (c) => {
    await removeMember(c.get("user"), id(c), id(c, "memberId"));
    return c.json({ ok: true });
  });
  r.post("/:id/leave", async (c) => {
    await leaveGroup(c.get("user"), id(c));
    return c.json({ ok: true });
  });
  r.patch("/:id/me", async (c) => c.json(await setMyPrivacy(c.get("user"), id(c), (await readJson(c.req.raw, meSchema)).showNameOnLeaderboard)));

  r.post("/:id/invites", async (c) => c.json(await createInvite(c.get("user"), id(c), await readJson(c.req.raw, inviteSchema())), 201));
  r.get("/:id/invites", async (c) => c.json(await listInvites(c.get("user"), id(c))));
  r.delete("/:id/invites/:inviteId", async (c) => {
    await revokeInvite(c.get("user"), id(c), id(c, "inviteId"));
    return c.json({ ok: true });
  });

  r.get("/:id/exams", async (c) => c.json(await listGroupExams(c.get("user"), id(c), page(c.req.url))));
  return r;
}
