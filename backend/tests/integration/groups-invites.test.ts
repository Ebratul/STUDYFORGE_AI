import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClock } from "../../src/lib/clock.js";
import { db } from "../../src/lib/db.js";
import { notifyUsers } from "../../src/modules/account/notifications.js";
import { hashCode, normalizeCode } from "../../src/modules/groups/invites.js";
import { seedGroup } from "../helpers/exam-fixtures.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";
import { withEnv } from "../helpers/with-env.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => setClock(null));

const ip = () => ({ "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
const invite = async (u: TestUser, groupId: string, body: Record<string, unknown> = {}) => {
  const res = await client(t, u).post(`/api/groups/${groupId}/invites`, body);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { invite: { id: string; status: string; expiresAt: string; maxUses: number; useCount: number; codeHint: string; forEmail: boolean }; code: string; link: string };
};
const join = (u: TestUser, code: string, headers: Record<string, string> = ip()) => client(t, u).raw("POST", "/api/groups/join", { code }, headers);
const preview = (u: TestUser, code: string, headers: Record<string, string> = ip()) => client(t, u).raw("GET", `/api/groups/join-preview?code=${encodeURIComponent(code)}`, undefined, headers);
const setup = async (opts: { capacity?: number } = {}) => {
  const [owner, admin, member] = [await createUser(), await createUser(), await createUser()];
  const group = await seedGroup(owner, { ...opts, members: [{ user: admin, role: "ADMIN" }, { user: member }] });
  return { owner, admin, member, group };
};

describe("creating and managing invitations", () => {
  it("returns the code once (128-bit, grouped) with a link; only its hash is stored; the list never shows it", async () => {
    const { owner, group } = await setup();
    const res = await invite(owner, group.id, { expiresInHours: 24, maxUses: 5 });
    expect(res.code).toMatch(/^([A-Z2-7]{5}-){5}[A-Z2-7]$/);
    expect(res.link).toBe(`http://localhost:3100/join/${res.code}`);
    expect(res.invite).toMatchObject({ status: "ACTIVE", maxUses: 5, useCount: 0, forEmail: false, codeHint: normalizeCode(res.code)!.slice(-4) });
    const row = await db.groupInvite.findUniqueOrThrow({ where: { id: res.invite.id } });
    expect(row.codeHash).toBe(hashCode(normalizeCode(res.code)!));
    expect(JSON.stringify(row)).not.toContain(normalizeCode(res.code)!);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const list = await (await client(t, owner).get(`/api/groups/${group.id}/invites`)).text();
    expect(list).not.toContain(normalizeCode(res.code)!);
    expect(list).not.toContain(res.code);
    expect(JSON.parse(list).items[0]).toMatchObject({ id: res.invite.id, status: "ACTIVE", codeHint: res.invite.codeHint });
    expect(Object.keys(JSON.parse(list).items[0]).sort()).toEqual(["codeHint", "createdAt", "expiresAt", "forEmail", "id", "maxUses", "status", "useCount"]);
  });

  it("only OWNER and ADMIN manage invitations", async () => {
    const { owner, admin, member, group } = await setup();
    expect((await client(t, member).post(`/api/groups/${group.id}/invites`, {})).status).toBe(403);
    expect((await client(t, member).get(`/api/groups/${group.id}/invites`)).status).toBe(403);
    const made = await invite(admin, group.id);
    expect((await client(t, member).delete(`/api/groups/${group.id}/invites/${made.invite.id}`)).status).toBe(403);
    expect((await client(t, owner).delete(`/api/groups/${group.id}/invites/${made.invite.id}`)).status).toBe(200);
    const stranger = await createUser();
    expect((await client(t, stranger).post(`/api/groups/${group.id}/invites`, {})).status).toBe(404);
  });

  it("validates lifetime, uses and e-mail; caps active invitations per group", async () => {
    const { owner, group } = await setup();
    const bad = async (body: Record<string, unknown>) => (await client(t, owner).post(`/api/groups/${group.id}/invites`, body)).status;
    expect(await bad({ expiresInHours: 0 })).toBe(422);
    expect(await bad({ expiresInHours: 721 })).toBe(422);
    expect(await bad({ maxUses: 0 })).toBe(422);
    expect(await bad({ maxUses: 501 })).toBe(422);
    expect(await bad({ email: "not-an-email" })).toBe(422);
    expect(await bad({ code: "CHOSEN" })).toBe(422);
    await withEnv({ INVITE_MAX_ACTIVE_PER_GROUP: "2" }, async () => {
      await invite(owner, group.id);
      const second = await invite(owner, group.id);
      expect(await bad({})).toBe(422);
      await client(t, owner).delete(`/api/groups/${group.id}/invites/${second.invite.id}`);
      expect(await bad({})).toBe(201); // a revoked invite frees a slot
    });
  });

  it("revocation is idempotent and unknown ids are 404", async () => {
    const { owner, group } = await setup();
    const { invite: i, code } = await invite(owner, group.id);
    const c = client(t, owner);
    expect((await c.delete(`/api/groups/${group.id}/invites/${i.id}`)).status).toBe(200);
    expect((await c.delete(`/api/groups/${group.id}/invites/${i.id}`)).status).toBe(200);
    expect((await c.delete(`/api/groups/${group.id}/invites/nope`)).status).toBe(404);
    expect((await (await c.get(`/api/groups/${group.id}/invites`)).json()).items[0].status).toBe("REVOKED");
    expect((await join(await createUser(), code)).status).toBe(404);
  });
});

describe("joining", () => {
  it("previews a code without joining, then joins as MEMBER and notifies the staff once", async () => {
    const { owner, admin, group } = await setup();
    const { code, invite: i } = await invite(owner, group.id);
    const joiner = await createUser();
    const pv = await (await preview(joiner, code.toLowerCase())).json();
    expect(pv).toEqual({ group: { title: "Study group", memberCount: 3, capacity: 30 } });
    expect(await db.groupMember.count({ where: { groupId: group.id, userId: joiner.id } })).toBe(0);

    const res = await join(joiner, code);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ alreadyMember: false, group: { id: group.id, myRole: "MEMBER", memberCount: 4 } });
    expect((await db.groupInvite.findUniqueOrThrow({ where: { id: i.id } })).useCount).toBe(1);
    expect((await db.groupMember.findUniqueOrThrow({ where: { groupId_userId: { groupId: group.id, userId: joiner.id } } })).role).toBe("MEMBER");
    for (const staff of [owner, admin]) expect(await db.notification.count({ where: { userId: staff.id, type: "group.member_joined" } })).toBe(1);
    expect(await db.notification.count({ where: { userId: joiner.id, type: "group.member_joined" } })).toBe(0);

    // joining again with the same code is idempotent: no extra use, no duplicate notification
    const again = await (await join(joiner, code)).json();
    expect(again.alreadyMember).toBe(true);
    expect((await db.groupInvite.findUniqueOrThrow({ where: { id: i.id } })).useCount).toBe(1);
    expect(await db.notification.count({ where: { userId: owner.id, type: "group.member_joined" } })).toBe(1);
  });

  it("answers every failure with the same INVALID_INVITE (unknown, malformed, expired, revoked, used up, bound to someone else)", async () => {
    const { owner, group } = await setup();
    const joiner = await createUser();
    const expired = await invite(owner, group.id, { expiresInHours: 1 });
    const revoked = await invite(owner, group.id);
    await client(t, owner).delete(`/api/groups/${group.id}/invites/${revoked.invite.id}`);
    const single = await invite(owner, group.id, { maxUses: 1 });
    expect((await join(await createUser(), single.code)).status).toBe(200);
    const direct = await invite(owner, group.id, { email: (await createUser()).email });
    setClock(() => new Date(Date.now() + 2 * 3_600_000));

    const bodies: unknown[] = [];
    for (const code of [expired.code, revoked.code, single.code, direct.code, "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-A", "garbage"]) {
      for (const res of [await join(joiner, code), await preview(joiner, code)]) {
        expect(res.status, code).toBe(404);
        bodies.push((await res.json()).error);
      }
    }
    for (const e of bodies as { code: string; message: string }[]) expect(e).toMatchObject({ code: "INVALID_INVITE", message: "That invitation code is invalid or has expired." });
    expect(await db.groupMember.count({ where: { groupId: group.id, userId: joiner.id } })).toBe(0);
    expect((await join(joiner, "")).status).toBe(422); // an empty code is plain input validation
  });

  it("expires exactly at the configured time", async () => {
    const { owner, group } = await setup();
    const { code, invite: i } = await invite(owner, group.id, { expiresInHours: 2 });
    const exp = new Date(i.expiresAt).getTime();
    setClock(() => new Date(exp - 1));
    expect((await preview(await createUser(), code)).status).toBe(200);
    setClock(() => new Date(exp));
    expect((await preview(await createUser(), code)).status).toBe(404);
    expect((await (await client(t, owner).get(`/api/groups/${group.id}/invites`)).json()).items[0].status).toBe("EXPIRED");
  });

  it("enforces max uses", async () => {
    const { owner, group } = await setup();
    const { code, invite: i } = await invite(owner, group.id, { maxUses: 2 });
    expect((await join(await createUser(), code)).status).toBe(200);
    expect((await join(await createUser(), code)).status).toBe(200);
    expect((await join(await createUser(), code)).status).toBe(404);
    expect((await (await client(t, owner).get(`/api/groups/${group.id}/invites`)).json()).items.find((x: { id: string }) => x.id === i.id).status).toBe("USED_UP");
  });

  it("reports GROUP_FULL when the group has no room", async () => {
    const { owner, group } = await setup({ capacity: 3 });
    const { code } = await invite(owner, group.id);
    const res = await join(await createUser(), code);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("GROUP_FULL");
    expect(await db.groupMember.count({ where: { groupId: group.id } })).toBe(3);
  });

  it("limits how many groups one user can belong to", async () => {
    const { owner, group } = await setup();
    const { code } = await invite(owner, group.id);
    const joiner = await createUser();
    await withEnv({ GROUP_MAX_MEMBERSHIPS_PER_USER: "1" }, async () => {
      await seedGroup(joiner, { title: "Joiner's own" });
      const res = await join(joiner, code);
      expect(res.status).toBe(422);
    });
  });
});

describe("direct (e-mail) invitations", () => {
  it("binds the code to the invited account, notifies it in-app once, and works only for that user", async () => {
    const { owner, group } = await setup();
    const guest = await createUser();
    const res = await invite(owner, group.id, { email: guest.email.toUpperCase(), maxUses: 9 });
    expect(res.invite).toMatchObject({ maxUses: 1, forEmail: true });
    const notes = await db.notification.findMany({ where: { userId: guest.id, type: "group.invitation" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.link).toBe(`/join/${res.code}`);
    expect(notes[0]!.dedupeKey).toBe(`group-invite:${res.invite.id}:${guest.id}`);
    // someone else with the code can't use it
    expect((await join(await createUser(), res.code)).status).toBe(404);
    expect((await join(guest, res.code)).status).toBe(200);
  });

  it("never reveals whether an address has an account", async () => {
    const { owner, group } = await setup();
    const known = await createUser();
    const a = await invite(owner, group.id, { email: known.email });
    const b = await invite(owner, group.id, { email: `nobody-${randomUUID()}@example.test` });
    const shape = (r: typeof a) => ({ keys: Object.keys(r).sort(), inviteKeys: Object.keys(r.invite).sort(), forEmail: r.invite.forEmail, maxUses: r.invite.maxUses, status: r.invite.status, codeLen: r.code.length });
    expect(shape(a)).toEqual(shape(b));
    // the code for an unknown address can't be redeemed by anyone
    expect((await join(await createUser(), b.code)).status).toBe(404);
    expect(await db.notification.count({ where: { type: "group.invitation", dedupeKey: { startsWith: `group-invite:${b.invite.id}` } } })).toBe(0);
  });

  it("does not notify someone who is already a member", async () => {
    const { owner, member, group } = await setup();
    await invite(owner, group.id, { email: member.email });
    expect(await db.notification.count({ where: { userId: member.id, type: "group.invitation" } })).toBe(0);
  });
});

describe("brute-force protection", () => {
  it("throttles code guesses per user, counting failures and successes, for both preview and join", async () => {
    const { owner, group } = await setup();
    const { code } = await invite(owner, group.id, { maxUses: 50 });
    await withEnv({ INVITE_ATTEMPTS_PER_HOUR_USER: "4" }, async () => {
      const guesser = await createUser();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await join(guesser, `AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-${"ABCDEF"[i]}`)).status);
      expect(statuses).toEqual([404, 404, 404, 404, 429, 429]);
      // the budget is per user: the real code still works for someone else, and is also blocked for the throttled user
      expect((await join(guesser, code)).status).toBe(429);
      expect((await preview(guesser, code)).status).toBe(429);
      expect((await join(await createUser(), code)).status).toBe(200);
    });
  });

  it("throttles per IP across different accounts", async () => {
    await withEnv({ INVITE_ATTEMPTS_PER_HOUR_IP: "3" }, async () => {
      const sameIp = ip();
      const results: number[] = [];
      for (let i = 0; i < 5; i++) results.push((await join(await createUser(), "BBBBB-BBBBB-BBBBB-BBBBB-BBBBB-B", sameIp)).status);
      expect(results).toEqual([404, 404, 404, 429, 429]);
      expect((await join(await createUser(), "BBBBB-BBBBB-BBBBB-BBBBB-BBBBB-B", ip())).status).toBe(404); // another address is unaffected
    });
  });

  it("sends Retry-After with the 429", async () => {
    await withEnv({ INVITE_ATTEMPTS_PER_HOUR_USER: "1" }, async () => {
      const u = await createUser();
      await join(u, "nope");
      const res = await join(u, "nope");
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    });
  });
});

describe("concurrency", () => {
  it("N parallel joins into a group with C free seats admit exactly C and reject the rest with GROUP_FULL", async () => {
    const { owner, group } = await setup({ capacity: 6 }); // 3 seats taken (owner, admin, member) → 3 free
    const { code, invite: i } = await invite(owner, group.id, { maxUses: 50 });
    const users = await Promise.all(Array.from({ length: 12 }, () => createUser()));
    const results = await Promise.all(users.map((u) => join(u, code)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(statuses.filter((s) => s !== 200 && s !== 409)).toEqual([]);
    expect(await db.groupMember.count({ where: { groupId: group.id } })).toBe(6);
    expect((await db.groupInvite.findUniqueOrThrow({ where: { id: i.id } })).useCount).toBe(3);
  });

  it("parallel joins never exceed an invitation's max uses", async () => {
    const { owner, group } = await setup();
    const { code, invite: i } = await invite(owner, group.id, { maxUses: 2 });
    const users = await Promise.all(Array.from({ length: 8 }, () => createUser()));
    const statuses = (await Promise.all(users.map((u) => join(u, code)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 404)).toHaveLength(6);
    expect((await db.groupInvite.findUniqueOrThrow({ where: { id: i.id } })).useCount).toBe(2);
    expect(await db.groupMember.count({ where: { groupId: group.id } })).toBe(5);
  });

  it("the same user joining in parallel is admitted once and consumes one use", async () => {
    const { owner, group } = await setup();
    const { code, invite: i } = await invite(owner, group.id, { maxUses: 1 });
    const joiner = await createUser();
    const results = await Promise.all(Array.from({ length: 6 }, () => join(joiner, code)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.filter((b) => b.alreadyMember === false)).toHaveLength(1);
    expect(await db.groupMember.count({ where: { groupId: group.id, userId: joiner.id } })).toBe(1);
    expect((await db.groupInvite.findUniqueOrThrow({ where: { id: i.id } })).useCount).toBe(1);
    expect(await db.notification.count({ where: { userId: owner.id, type: "group.member_joined" } })).toBe(1);
  });

  it("parallel edits of capacity and joins keep members ≤ capacity", async () => {
    const { owner, group } = await setup({ capacity: 10 });
    const { code } = await invite(owner, group.id, { maxUses: 50 });
    const users = await Promise.all(Array.from({ length: 8 }, () => createUser()));
    await Promise.all([...users.map((u) => join(u, code)), client(t, owner).patch(`/api/groups/${group.id}`, { capacity: 6 })]);
    const [members, g] = await Promise.all([db.groupMember.count({ where: { groupId: group.id } }), db.group.findUniqueOrThrow({ where: { id: group.id } })]);
    expect(members).toBeLessThanOrEqual(g.capacity);
  });
});

describe("notification idempotency", () => {
  it("the same dedupe key is delivered once per user, no matter how many times it is sent", async () => {
    const [a, b] = [await createUser(), await createUser()];
    const input = { type: "group.exam_published", title: "T", body: "B", dedupeKey: `exam-published:${randomUUID()}` };
    expect(await notifyUsers([a.id, b.id], input)).toBe(2);
    expect(await notifyUsers([a.id, b.id, a.id], input)).toBe(0);
    expect(await Promise.all([notifyUsers([a.id], input), notifyUsers([a.id], input)])).toEqual([0, 0]);
    expect(await db.notification.count({ where: { type: "group.exam_published", userId: { in: [a.id, b.id] } } })).toBe(2);
    // a different event is delivered
    expect(await notifyUsers([a.id], { ...input, dedupeKey: `exam-published:${randomUUID()}` })).toBe(1);
  });
});
