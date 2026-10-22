import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { seedGroup, seedPublishedExam } from "../helpers/exam-fixtures.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";
import { withEnv } from "../helpers/with-env.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});

const create = async (u: TestUser, body: Record<string, unknown> = {}) => {
  const res = await client(t, u).post("/api/groups", { title: "Biology batch", ...body });
  expect(res.status).toBe(201);
  return (await res.json()).group as { id: string; title: string; capacity: number; memberCount: number; myRole: string };
};
const members = async (u: TestUser, id: string, qs = "") => (await (await client(t, u).get(`/api/groups/${id}/members${qs}`)).json()) as { items: { memberId: string; displayName: string; role: string; isSelf: boolean }[]; total: number };

describe("groups", () => {
  it("creates a group with the creator as its single OWNER and default capacity", async () => {
    const u = await createUser();
    const g = await create(u, { description: "  Weekly mocks  " });
    expect(g).toMatchObject({ title: "Biology batch", capacity: 30, memberCount: 1, myRole: "OWNER" });
    expect((await (await client(t, u).get(`/api/groups/${g.id}`)).json()).group).toMatchObject({ description: "Weekly mocks", ownerName: u.name });
    expect((await db.groupMember.findMany({ where: { groupId: g.id } })).map((m) => m.role)).toEqual(["OWNER"]);
    expect((await (await client(t, u).get("/api/groups")).json()).items).toHaveLength(1);
  });

  it("validates input on the server (title, capacity bounds, unknown keys)", async () => {
    const u = await createUser();
    const bad = async (body: Record<string, unknown>) => (await client(t, u).post("/api/groups", body)).status;
    expect(await bad({ title: "   " })).toBe(422);
    expect(await bad({ title: "x".repeat(81) })).toBe(422);
    expect(await bad({ title: "ok", capacity: 1 })).toBe(422);
    expect(await bad({ title: "ok", capacity: 501 })).toBe(422);
    expect(await bad({ title: "ok", capacity: 2.5 })).toBe(422);
    expect(await bad({ title: "ok", ownerId: "someone" })).toBe(422);
    expect(await bad({ title: "ok", description: "d".repeat(501) })).toBe(422);
    expect((await client(t).post("/api/groups", { title: "anon" })).status).toBe(401);
  });

  it("enforces the per-user group limits", async () => {
    const u = await createUser();
    await withEnv({ GROUP_MAX_OWNED_PER_USER: "2" }, async () => {
      await create(u, { title: "One" });
      await create(u, { title: "Two" });
      expect((await client(t, u).post("/api/groups", { title: "Three" })).status).toBe(422);
    });
  });

  it("is invisible to non-members (404 everywhere), including mutations", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const g = await create(a);
    const cb = client(t, b);
    for (const res of [
      await cb.get(`/api/groups/${g.id}`), await cb.patch(`/api/groups/${g.id}`, { title: "Mine" }), await cb.get(`/api/groups/${g.id}/members`),
      await cb.post(`/api/groups/${g.id}/leave`, {}), await cb.patch(`/api/groups/${g.id}/me`, { showNameOnLeaderboard: false }), await cb.get(`/api/groups/${g.id}/invites`),
      await cb.post(`/api/groups/${g.id}/invites`, {}), await cb.get(`/api/groups/${g.id}/exams`), await cb.raw("DELETE", `/api/groups/${g.id}`, { confirmTitle: g.title }),
    ])
      expect(res.status).toBe(404);
    expect((await cb.get("/api/groups/nope")).status).toBe(404);
    expect((await (await cb.get("/api/groups")).json()).items).toEqual([]);
    expect((await db.group.findUniqueOrThrow({ where: { id: g.id } })).title).toBe("Biology batch");
  });
});

describe("roles matrix", () => {
  async function setup() {
    const [owner, admin, m1, m2] = [await createUser(), await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { capacity: 10, members: [{ user: admin, role: "ADMIN" }, { user: m1 }, { user: m2 }] });
    return { owner, admin, m1, m2, group };
  }

  it("only the OWNER edits the group; capacity can't go below the current member count", async () => {
    const { owner, admin, m1, group } = await setup();
    for (const u of [admin, m1]) expect((await client(t, u).patch(`/api/groups/${group.id}`, { title: "Hijack" })).status).toBe(403);
    expect((await (await client(t, owner).patch(`/api/groups/${group.id}`, { title: "Renamed", description: null, capacity: 4 })).json()).group).toMatchObject({ title: "Renamed", capacity: 4, description: null });
    const low = await client(t, owner).patch(`/api/groups/${group.id}`, { capacity: 3 });
    expect(low.status).toBe(422);
    expect((await low.json()).error.details.fields.capacity).toMatch(/4/);
    expect((await client(t, owner).patch(`/api/groups/${group.id}`, { title: "   " })).status).toBe(422);
  });

  it("delete needs the OWNER and the exact group name, and cascades members, invites and exams", async () => {
    const { owner, admin, group } = await setup();
    await seedPublishedExam({ owner, group });
    await client(t, owner).post(`/api/groups/${group.id}/invites`, {});
    expect((await client(t, admin).raw("DELETE", `/api/groups/${group.id}`, { confirmTitle: group.title })).status).toBe(403);
    const wrong = await client(t, owner).raw("DELETE", `/api/groups/${group.id}`, { confirmTitle: "nope" });
    expect(wrong.status).toBe(422);
    expect((await client(t, owner).raw("DELETE", `/api/groups/${group.id}`, { confirmTitle: group.title })).status).toBe(200);
    expect(await db.group.count({ where: { id: group.id } })).toBe(0);
    expect(await db.groupMember.count({ where: { groupId: group.id } })).toBe(0);
    expect(await db.groupInvite.count({ where: { groupId: group.id } })).toBe(0);
    expect(await db.exam.count({ where: { groupId: group.id } })).toBe(0);
  });

  it("lists members OWNER first, with display names, no e-mail and a self flag", async () => {
    const { owner, admin, m1, group } = await setup();
    await db.userProfile.upsert({ where: { userId: m1.id }, create: { userId: m1.id, displayName: "Nadia K." }, update: { displayName: "Nadia K." } });
    const res = await client(t, m1).get(`/api/groups/${group.id}/members`);
    const raw = await res.text();
    for (const u of [owner, admin, m1]) expect(raw).not.toContain(u.email);
    const list = JSON.parse(raw) as Awaited<ReturnType<typeof members>>;
    expect(list.items.map((i) => i.role)).toEqual(["OWNER", "ADMIN", "MEMBER", "MEMBER"]);
    expect(list.items.find((i) => i.isSelf)).toMatchObject({ memberId: m1.id, displayName: "Nadia K." });
    expect(Object.keys(list.items[0]!).sort()).toEqual(["displayName", "isSelf", "joinedAt", "memberId", "role"]);
    const p = await members(m1, group.id, "?pageSize=2&page=2");
    expect(p.items).toHaveLength(2);
    expect(p.total).toBe(4);
    expect((await client(t, m1).get(`/api/groups/${group.id}/members?pageSize=101`)).status).toBe(422);
  });

  it("only the OWNER changes roles, never the owner's own", async () => {
    const { owner, admin, m1, group } = await setup();
    const patch = (u: TestUser, target: TestUser, role: string) => client(t, u).patch(`/api/groups/${group.id}/members/${target.id}`, { role });
    expect((await patch(admin, m1, "ADMIN")).status).toBe(403);
    expect((await patch(m1, admin, "MEMBER")).status).toBe(403);
    expect((await patch(owner, m1, "ADMIN")).status).toBe(200);
    expect((await db.groupMember.findUniqueOrThrow({ where: { groupId_userId: { groupId: group.id, userId: m1.id } } })).role).toBe("ADMIN");
    expect((await patch(owner, owner, "MEMBER")).status).toBe(422);
    expect((await patch(owner, m1, "OWNER")).status).toBe(422);
    expect((await patch(owner, await createUser(), "ADMIN")).status).toBe(404);
  });

  it("OWNER and ADMIN remove MEMBERs; only the OWNER removes ADMINs; the owner can't be removed; removed users are told once", async () => {
    const { owner, admin, m1, m2, group } = await setup();
    const rm = (u: TestUser, target: TestUser) => client(t, u).delete(`/api/groups/${group.id}/members/${target.id}`);
    expect((await rm(m1, m2)).status).toBe(403);
    expect((await rm(m1, owner)).status).toBe(403);
    expect((await rm(admin, owner)).status).toBe(403);
    expect((await rm(owner, owner)).status).toBe(422); // use "leave"
    expect((await rm(admin, m1)).status).toBe(200);
    expect((await rm(admin, m1)).status).toBe(404); // already gone
    expect((await rm(owner, admin)).status).toBe(200);
    const notes = await db.notification.findMany({ where: { userId: m1.id, type: "group.member_removed" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain(group.title);
    // admin-on-admin is refused
    const a2 = await createUser();
    await db.groupMember.create({ data: { groupId: group.id, userId: a2.id, role: "ADMIN" } });
    const a3 = await createUser();
    await db.groupMember.create({ data: { groupId: group.id, userId: a3.id, role: "ADMIN" } });
    expect((await rm(a2, a3)).status).toBe(403);
    expect((await rm(owner, a3)).status).toBe(200);
  });

  it("members and admins can leave, the owner can't; the owner is notified once", async () => {
    const { owner, admin, m1, group } = await setup();
    expect((await client(t, owner).post(`/api/groups/${group.id}/leave`, {})).status).toBe(403);
    expect((await client(t, m1).post(`/api/groups/${group.id}/leave`, {})).status).toBe(200);
    expect((await client(t, m1).post(`/api/groups/${group.id}/leave`, {})).status).toBe(404);
    expect((await client(t, admin).post(`/api/groups/${group.id}/leave`, {})).status).toBe(200);
    expect(await db.notification.count({ where: { userId: owner.id, type: "group.member_left" } })).toBe(2);
    expect((await client(t, m1).get(`/api/groups/${group.id}`)).status).toBe(404);
    expect(await db.groupMember.count({ where: { groupId: group.id } })).toBe(2);
  });

  it("each member controls their own leaderboard-name privacy", async () => {
    const { m1, group } = await setup();
    expect(await (await client(t, m1).patch(`/api/groups/${group.id}/me`, { showNameOnLeaderboard: false })).json()).toEqual({ showNameOnLeaderboard: false });
    expect((await db.groupMember.findUniqueOrThrow({ where: { groupId_userId: { groupId: group.id, userId: m1.id } } })).showNameOnLeaderboard).toBe(false);
    expect((await client(t, m1).patch(`/api/groups/${group.id}/me`, { showNameOnLeaderboard: "no" })).status).toBe(422);
    expect((await client(t, m1).patch(`/api/groups/${group.id}/me`, { showNameOnLeaderboard: true, role: "OWNER" })).status).toBe(422);
  });
});

describe("database guarantees", () => {
  it("rejects a second OWNER and refuses inserts past capacity even when the application is bypassed", async () => {
    const [owner, a, b, c] = [await createUser(), await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { capacity: 2 });
    await expect(db.groupMember.create({ data: { groupId: group.id, userId: a.id, role: "OWNER" } })).rejects.toThrow();
    await db.groupMember.create({ data: { groupId: group.id, userId: a.id } });
    await expect(db.groupMember.create({ data: { groupId: group.id, userId: b.id } })).rejects.toThrow(/group is full/);
    // the trigger serializes concurrent raw inserts too
    const results = await Promise.allSettled([db.groupMember.create({ data: { groupId: group.id, userId: b.id } }), db.groupMember.create({ data: { groupId: group.id, userId: c.id } })]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(await db.groupMember.count({ where: { groupId: group.id } })).toBe(2);
  });

  it("a group's capacity can't be configured out of range", async () => {
    const owner = await createUser();
    await expect(db.group.create({ data: { ownerId: owner.id, title: "x", capacity: 0 } })).rejects.toThrow();
    await expect(db.group.create({ data: { ownerId: owner.id, title: "x", capacity: 1001 } })).rejects.toThrow();
  });
});

describe("group exam history", () => {
  it("shows published/cancelled exams to members, drafts only to their author, with the caller's own participation status", async () => {
    const [owner, m1, m2, outsider] = [await createUser(), await createUser(), await createUser(), await createUser()];
    const group = await seedGroup(owner, { members: [{ user: m1 }, { user: m2 }] });
    const published = await seedPublishedExam({ owner, group, title: "Midterm", questionCount: 2 });
    const cancelled = await seedPublishedExam({ owner, group, title: "Cancelled one" });
    await db.exam.update({ where: { id: cancelled.exam.id }, data: { status: "CANCELLED" } });
    await db.exam.create({ data: { ownerId: owner.id, groupId: group.id, mode: "GROUP", title: "Secret draft", draft: {} } });
    await db.examAttempt.create({
      data: { examVersionId: published.version.id, userId: m1.id, attemptNo: 1, startedAt: new Date(), deadlineAt: new Date(Date.now() + 3_600_000), questionOrder: [], optionOrder: {} },
    });

    const list = async (u: TestUser) => (await (await client(t, u).get(`/api/groups/${group.id}/exams`)).json()) as { items: { id: string; title: string; status: string; mine: boolean; myStatus: string | null; myResult: unknown; questionCount: number | null }[]; total: number };
    const asM1 = await list(m1);
    expect(asM1.items.map((i) => i.title).sort()).toEqual(["Cancelled one", "Midterm"]);
    const mid = asM1.items.find((i) => i.title === "Midterm")!;
    expect(mid).toMatchObject({ myStatus: "IN_PROGRESS", questionCount: 2, mine: false, myResult: null });
    expect(asM1.items.find((i) => i.title === "Cancelled one")!.myStatus).toBe("MISSED");
    expect((await list(m2)).items.find((i) => i.title === "Midterm")!.myStatus).toBe("NOT_STARTED");
    const asOwner = await list(owner);
    expect(asOwner.items.map((i) => i.title)).toContain("Secret draft");
    expect(asOwner.items.find((i) => i.title === "Midterm")).toMatchObject({ mine: true, myStatus: "AUTHOR" });
    expect((await client(t, outsider).get(`/api/groups/${group.id}/exams`)).status).toBe(404);
  });
});
