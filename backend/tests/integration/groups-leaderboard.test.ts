import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClock } from "../../src/lib/clock.js";
import { db } from "../../src/lib/db.js";
import { seedFinalResult, seedGroup, seedPublishedExam } from "../helpers/exam-fixtures.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => setClock(null));

type Item = { entryId: string; rank: number | null; displayName: string; isSelf: boolean; status: string; scoreCenti: number | null; maxCenti: number; percentBp: number | null; band: string | null; submittedAt: string | null };
type Board = {
  released: boolean; hidden?: boolean; releasesAt: string | null; policy?: string; items: Item[]; total: number; page: number; pageSize: number; myEntry: Item | null;
  stats: { participants: number; ranked: number; average: number | null; highest: number | null; lowest: number | null; median: number | null };
  distribution: { band: string; label: string; count: number }[];
  participants?: { total: number; submitted: number; timedOut: number; inProgress: number; notStarted: number; missed: number };
  myStatus?: string | null;
};
const board = async (u: TestUser, examId: string, qs = ""): Promise<Board> => {
  const res = await client(t, u).get(`/api/exams/${examId}/leaderboard${qs}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};

/** One exam worth 100 marks in total (1 question x 10000 centi-marks so a score in centi-marks equals the percentage in basis points). */
async function setup(opts: { members?: number; joinedAgoMs?: number; version?: Partial<Parameters<typeof seedPublishedExam>[0]> } = {}) {
  const owner = await createUser({ name: "Olivia Owner" });
  const people = await Promise.all(Array.from({ length: opts.members ?? 4 }, (_, i) => createUser({ name: `Member ${i + 1} Name` })));
  const joinedAt = new Date(Date.now() - (opts.joinedAgoMs ?? 0));
  const group = await seedGroup(owner, { capacity: 100, members: people.map((user) => ({ user, joinedAt })) });
  const seeded = await seedPublishedExam({ owner, group, questionCount: 1, marksCenti: 10000, ...opts.version });
  return { owner, people, group, ...seeded };
}
const score = (e: { version: { id: string; totalCenti: number; questionCount: number } }, user: TestUser, scoreCenti: number, extra: Record<string, unknown> = {}) =>
  seedFinalResult({ version: e.version, user, scoreCenti, ...extra });

describe("ranking", () => {
  it("uses competition ranking 1, 2, 2, 4 computed from scores, not list position", async () => {
    const e = await setup({ members: 5 });
    const [a, b, c, d, f] = e.people as [TestUser, TestUser, TestUser, TestUser, TestUser];
    // inserted out of order on purpose
    await score(e, c, 8000);
    await score(e, f, 5000);
    await score(e, a, 9000);
    await score(e, d, 7000);
    await score(e, b, 8000);
    const lb = await board(a, e.exam.id);
    expect(lb).toMatchObject({ released: true, policy: "COMPETITION_1224_BEST_ATTEMPT" });
    expect(lb.items.map((i) => i.rank)).toEqual([1, 2, 2, 4, 5]);
    expect(lb.items.map((i) => i.percentBp)).toEqual([9000, 8000, 8000, 7000, 5000]);
    expect(lb.items.map((i) => i.band)).toEqual(["EXCELLENT", "GOOD", "GOOD", "NEEDS_IMPROVEMENT", "VERY_BAD"]);
    expect(lb.items.every((i) => i.maxCenti === 10000)).toBe(true);
  });

  it("ties on a lower rank share it and the next rank skips accordingly (1, 1, 3, 3, 3, 6)", async () => {
    const e = await setup({ members: 6 });
    const s = [9000, 9000, 7000, 7000, 7000, 6000];
    for (const [i, u] of e.people.entries()) await score(e, u, s[i]!);
    expect((await board(e.people[0]!, e.exam.id)).items.map((i) => i.rank)).toEqual([1, 1, 3, 3, 3, 6]);
  });

  it("uses each participant's BEST attempt, and the best attempt's status", async () => {
    const e = await setup({ members: 2, version: { attemptLimit: 3 } });
    const [a, b] = e.people as [TestUser, TestUser];
    await score(e, a, 3000, { attemptNo: 1 });
    await score(e, a, 8000, { attemptNo: 2, status: "TIMED_OUT" });
    await score(e, a, 6000, { attemptNo: 3 });
    await score(e, b, 7000);
    const lb = await board(b, e.exam.id);
    expect(lb.items.map((i) => [i.rank, i.scoreCenti, i.status])).toEqual([[1, 8000, "TIMED_OUT"], [2, 7000, "SUBMITTED"]]);
    expect(lb.stats.participants).toBe(2); // one entry per person, not per attempt
  });

  it("distinguishes a zero score (ranked) from an unsubmitted or in-progress attempt (unranked), and missed after close", async () => {
    const e = await setup({ members: 4, version: { closesAt: new Date(Date.now() - 1000), opensAt: new Date(Date.now() - 3_600_000) } });
    const [zero, ok, running] = e.people as [TestUser, TestUser, TestUser, TestUser];
    await score(e, zero, 0);
    await score(e, ok, 4000);
    await db.examAttempt.create({ data: { examVersionId: e.version.id, userId: running.id, attemptNo: 1, startedAt: new Date(), deadlineAt: new Date(Date.now() + 3_600_000), questionOrder: [], optionOrder: {} } });
    const lb = await board(ok, e.exam.id);
    expect(lb.items.map((i) => [i.rank, i.scoreCenti, i.status])).toEqual([[1, 4000, "SUBMITTED"], [2, 0, "SUBMITTED"], [null, null, "IN_PROGRESS"], [null, null, "MISSED"]]);
    expect(lb.items[1]).toMatchObject({ percentBp: 0, band: "VERY_BAD" }); // a real zero
    expect(lb.items[2]).toMatchObject({ rank: null, percentBp: null, band: null, submittedAt: null });
    expect(lb.stats).toMatchObject({ participants: 4, ranked: 2, lowest: 0, highest: 4000 });
  });

  it("finalizes expired in-progress attempts (via the exams module) before reading, so they show as ranked TIMED_OUT, not IN_PROGRESS", async () => {
    const e = await setup({ members: 2 });
    await score(e, e.people[0]!, 5000);
    await db.examAttempt.create({ data: { examVersionId: e.version.id, userId: e.people[1]!.id, attemptNo: 1, startedAt: new Date(Date.now() - 7_200_000), deadlineAt: new Date(Date.now() - 3_600_000), questionOrder: [], optionOrder: {} } });
    const lb = await board(e.people[0]!, e.exam.id);
    expect(lb.items.map((i) => [i.rank, i.status, i.scoreCenti])).toEqual([[1, "SUBMITTED", 5000], [2, "TIMED_OUT", 0]]);
  });

  it("marks never-started participants NOT_STARTED while the exam is open", async () => {
    const e = await setup({ members: 2 });
    await score(e, e.people[0]!, 5000);
    const lb = await board(e.people[0]!, e.exam.id);
    expect(lb.items.map((i) => i.status)).toEqual(["SUBMITTED", "NOT_STARTED"]);
  });

  it("flags timed-out attempts but still ranks them, and shows submission time only for real submissions", async () => {
    const e = await setup({ members: 2 });
    await score(e, e.people[0]!, 6000, { status: "TIMED_OUT" });
    await score(e, e.people[1]!, 6000, { status: "SUBMITTED" });
    const lb = await board(e.people[0]!, e.exam.id);
    expect(lb.items.map((i) => [i.rank, i.status, i.submittedAt !== null])).toEqual(expect.arrayContaining([[1, "TIMED_OUT", false], [1, "SUBMITTED", true]]));
  });
});

describe("who is on the board", () => {
  it("covers current members except the author; removed members and ineligible late joiners drop off", async () => {
    const e = await setup({ members: 3, joinedAgoMs: 300_000, version: { lateJoinGroup: false, publishedAt: new Date(Date.now() - 60_000) } });
    const [a, b] = e.people as [TestUser, TestUser, TestUser];
    const late = await createUser();
    await db.groupMember.create({ data: { groupId: e.group.id, userId: late.id } }); // joined after publication
    await score(e, a, 9000);
    await score(e, b, 8000);
    await score(e, e.owner, 10000); // the author never ranks even if a row existed
    let lb = await board(a, e.exam.id);
    expect(lb.items.map((i) => i.scoreCenti)).toEqual([9000, 8000, null]);
    expect(lb.stats.participants).toBe(3);
    await db.groupMember.delete({ where: { groupId_userId: { groupId: e.group.id, userId: b.id } } });
    lb = await board(a, e.exam.id);
    expect(lb.items.map((i) => i.scoreCenti)).toEqual([9000, null]);
    expect(lb.items.find((i) => i.rank === 1)!.isSelf).toBe(true);
  });

  it("lets late joiners participate when the exam allows it", async () => {
    const e = await setup({ members: 1, version: { lateJoinGroup: true, publishedAt: new Date(Date.now() - 60_000) } });
    const late = await createUser();
    await db.groupMember.create({ data: { groupId: e.group.id, userId: late.id } });
    await score(e, late, 7000);
    expect((await board(late, e.exam.id)).items.map((i) => i.scoreCenti)).toEqual([7000, null]);
  });
});

describe("privacy and leakage", () => {
  it("shows 'Anonymous participant' for members who opted out (to everyone but themselves, staff included) and never leaks ids or e-mail", async () => {
    const e = await setup({ members: 3 });
    const [a, b, c] = e.people as [TestUser, TestUser, TestUser];
    for (const [u, name] of [[b, "Secretive Bea"], [c, "Open Carl"]] as const) {
      await db.user.update({ where: { id: u.id }, data: { name } });
      await db.userProfile.upsert({ where: { userId: u.id }, create: { userId: u.id, displayName: name }, update: { displayName: name } });
    }
    b.name = "Secretive Bea";
    c.name = "Open Carl";
    await db.groupMember.update({ where: { groupId_userId: { groupId: e.group.id, userId: b.id } }, data: { showNameOnLeaderboard: false } });
    await db.userProfile.upsert({ where: { userId: a.id }, create: { userId: a.id, displayName: "Aisha R." }, update: { displayName: "Aisha R." } });
    for (const u of [a, b, c]) await score(e, u, u === a ? 9000 : u === b ? 8000 : 7000);

    const asA = await (await client(t, a).get(`/api/exams/${e.exam.id}/leaderboard`)).text();
    const lbA = JSON.parse(asA) as Board;
    expect(lbA.items.map((i) => i.displayName)).toEqual(["Aisha R.", "Anonymous participant", c.name]);
    const asB = await board(b, e.exam.id);
    expect(asB.items.map((i) => [i.displayName, i.isSelf])).toEqual([["Aisha R.", false], [b.name, true], [c.name, false]]);
    expect(asB.myEntry).toMatchObject({ displayName: b.name, isSelf: true, rank: 2 });
    expect((await board(e.owner, e.exam.id)).items[1]!.displayName).toBe("Anonymous participant");

    for (const secret of [a.id, b.id, c.id, e.owner.id, a.email, b.email, c.email, e.owner.email, b.name]) expect(asA).not.toContain(secret);
    expect(Object.keys(lbA.items[0]!).sort()).toEqual(["band", "displayName", "entryId", "isSelf", "maxCenti", "percentBp", "rank", "scoreCenti", "status", "submittedAt"]);
    expect(new Set(lbA.items.map((i) => i.entryId)).size).toBe(3);
    expect((await board(b, e.exam.id)).items.find((i) => i.isSelf)!.entryId).toBe((await board(a, e.exam.id)).items.find((i) => i.rank === 2)!.entryId); // stable per participant
  });

  it("404s for outsiders, removed members, non-group exams, unknown ids and drafts; 401 without a session", async () => {
    const e = await setup({ members: 2 });
    const outsider = await createUser();
    expect((await client(t, outsider).get(`/api/exams/${e.exam.id}/leaderboard`)).status).toBe(404);
    expect((await client(t, outsider).get(`/api/exams/${e.exam.id}/participants`)).status).toBe(404);
    expect((await client(t).get(`/api/exams/${e.exam.id}/leaderboard`)).status).toBe(401);
    expect((await client(t, e.owner).get("/api/exams/does-not-exist/leaderboard")).status).toBe(404);
    const solo = await seedPublishedExam({ owner: e.owner });
    expect((await client(t, e.owner).get(`/api/exams/${solo.exam.id}/leaderboard`)).status).toBe(404);
    const draft = await db.exam.create({ data: { ownerId: e.owner.id, groupId: e.group.id, mode: "GROUP", title: "d", draft: {} } });
    expect((await client(t, e.owner).get(`/api/exams/${draft.id}/leaderboard`)).status).toBe(404);
    await db.groupMember.delete({ where: { groupId_userId: { groupId: e.group.id, userId: e.people[0]!.id } } });
    expect((await client(t, e.people[0]!).get(`/api/exams/${e.exam.id}/leaderboard`)).status).toBe(404);
  });

  it("can be hidden from ordinary members while staff keep seeing it", async () => {
    const e = await setup({ members: 2, version: { leaderboardVisible: false } });
    await score(e, e.people[0]!, 9000);
    const asMember = await board(e.people[0]!, e.exam.id);
    expect(asMember).toEqual({ released: true, hidden: true, releasesAt: null });
    expect((await board(e.owner, e.exam.id)).items).toHaveLength(2);
  });
});

describe("release gating", () => {
  it("AFTER_CLOSE: before closesAt + grace nobody sees scores or names-with-scores, only participation counts; afterwards the board opens", async () => {
    const closesAt = new Date(Date.now() + 3_600_000);
    const e = await setup({ members: 3, version: { releaseMode: "AFTER_CLOSE", closesAt, opensAt: new Date(Date.now() - 60_000) } });
    const [a, b] = e.people as [TestUser, TestUser, TestUser];
    await score(e, a, 9000);
    await score(e, b, 4000, { status: "TIMED_OUT" });
    await db.examAttempt.create({ data: { examVersionId: e.version.id, userId: e.people[2]!.id, attemptNo: 1, startedAt: new Date(), deadlineAt: new Date(closesAt.getTime() + 86_400_000), questionOrder: [], optionOrder: {} } });

    for (const viewer of [a, e.owner]) {
      const raw = await (await client(t, viewer).get(`/api/exams/${e.exam.id}/leaderboard`)).text();
      const lb = JSON.parse(raw) as Board;
      expect(lb).toMatchObject({ released: false, participants: { total: 3, submitted: 1, timedOut: 1, inProgress: 1, notStarted: 0, missed: 0 } });
      expect(lb.releasesAt).toBe(new Date(closesAt.getTime() + 5000).toISOString());
      for (const forbidden of ["scoreCenti", "percentBp", "rank", "items", "displayName", "distribution", "stats", String(9000)]) expect(raw, forbidden).not.toContain(forbidden);
    }
    expect((await board(a, e.exam.id)).myStatus).toBe("SUBMITTED");

    setClock(() => new Date(closesAt.getTime() + 4999)); // inside the grace window: still closed
    expect((await board(a, e.exam.id)).released).toBe(false);
    setClock(() => new Date(closesAt.getTime() + 5000));
    const open = await board(a, e.exam.id);
    expect(open.released).toBe(true);
    expect(open.items.map((i) => i.scoreCenti)).toEqual([9000, 4000, null]);
  });

  it("AT_TIME opens exactly at the configured instant", async () => {
    const releaseAt = new Date(Date.now() + 7_200_000);
    const e = await setup({ members: 1, version: { releaseMode: "AT_TIME", releaseAt } });
    await score(e, e.people[0]!, 5000);
    expect((await board(e.people[0]!, e.exam.id)).released).toBe(false);
    setClock(() => new Date(releaseAt.getTime() - 1));
    expect((await board(e.people[0]!, e.exam.id)).released).toBe(false);
    setClock(() => releaseAt);
    expect((await board(e.people[0]!, e.exam.id)).items).toHaveLength(1);
  });

  it("IMMEDIATE is released as results exist", async () => {
    const e = await setup({ members: 1 });
    await score(e, e.people[0]!, 5000);
    expect((await board(e.people[0]!, e.exam.id)).released).toBe(true);
  });

  it("the participants endpoint is staff-only, shows states without answers, and scores only after release", async () => {
    const closesAt = new Date(Date.now() + 3_600_000);
    const e = await setup({ members: 2, version: { releaseMode: "AFTER_CLOSE", closesAt } });
    await score(e, e.people[0]!, 8000);
    const get = (u: TestUser) => client(t, u).get(`/api/exams/${e.exam.id}/participants`);
    expect((await get(e.people[0]!)).status).toBe(404);
    const early = (await (await get(e.owner)).json()) as { released: boolean; counts: Record<string, number>; items: { displayName: string; status: string; scoreCenti: number | null; percentBp: number | null; band: string | null; attemptsUsed: number; memberId: string }[] };
    expect(early).toMatchObject({ released: false, counts: { total: 2, submitted: 1, notStarted: 1 } });
    expect(early.items.map((i) => [i.status, i.scoreCenti, i.percentBp, i.band, i.attemptsUsed])).toEqual([["SUBMITTED", null, null, null, 1], ["NOT_STARTED", null, null, null, 0]]);
    setClock(() => new Date(closesAt.getTime() + 10_000));
    const late = (await (await get(e.owner)).json()) as typeof early;
    expect(late.items[0]).toMatchObject({ scoreCenti: 8000, percentBp: 8000, band: "GOOD", displayName: e.people[0]!.name });
    // an admin of the group (not the author) is staff too
    const admin = await createUser();
    await db.groupMember.create({ data: { groupId: e.group.id, userId: admin.id, role: "ADMIN" } });
    expect((await get(admin)).status).toBe(200);
  });
});

describe("pagination, statistics and distribution", () => {
  it("paginates ranked first, keeps total/myEntry stable, and rejects bad page sizes", async () => {
    const e = await setup({ members: 7 });
    const s = [9500, 9000, 8000, 7500, 7000, 6000];
    for (const [i, u] of e.people.slice(0, 6).entries()) await score(e, u, s[i]!);
    const me = e.people[5]!; // lowest ranked
    const p1 = await board(me, e.exam.id, "?pageSize=3&page=1");
    const p2 = await board(me, e.exam.id, "?pageSize=3&page=2");
    const p3 = await board(me, e.exam.id, "?pageSize=3&page=3");
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([3, 3, 1]);
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6, null]);
    expect(p1.total).toBe(7);
    expect(p1.myEntry).toMatchObject({ rank: 6, isSelf: true }); // present even though off this page
    expect(p3.items[0]!.status).toBe("NOT_STARTED");
    expect((await client(t, me).get(`/api/exams/${e.exam.id}/leaderboard?pageSize=101`)).status).toBe(422);
    expect((await client(t, me).get(`/api/exams/${e.exam.id}/leaderboard?page=0`)).status).toBe(422);
    expect((await board(me, e.exam.id, "?page=99")).items).toEqual([]);
  });

  it("computes average, highest, lowest and median from finalized results only", async () => {
    const e = await setup({ members: 4 });
    for (const [i, v] of [9000, 8000, 6000, 3000].entries()) await score(e, e.people[i]!, v);
    const lb = await board(e.people[0]!, e.exam.id);
    expect(lb.stats).toEqual({ participants: 4, ranked: 4, average: 6500, highest: 9000, lowest: 3000, median: 7000 });
    const empty = await setup({ members: 2 });
    expect((await board(empty.people[0]!, empty.exam.id)).stats).toEqual({ participants: 2, ranked: 0, average: null, highest: null, lowest: null, median: null });
  });

  it("buckets scores into the five bands at the exact boundaries", async () => {
    const e = await setup({ members: 10 });
    const scores = [5999, 6000, 6999, 7000, 7999, 8000, 8999, 9000, 10000, 0];
    for (const [i, v] of scores.entries()) await score(e, e.people[i]!, v);
    const lb = await board(e.people[0]!, e.exam.id);
    expect(lb.distribution).toEqual([
      { band: "BELOW_60", label: "Below 60%", count: 2 }, // 5999 and the zero score
      { band: "60_70", label: "60% – below 70%", count: 2 },
      { band: "70_80", label: "70% – below 80%", count: 2 },
      { band: "80_90", label: "80% – below 90%", count: 2 },
      { band: "90_100", label: "90% – 100%", count: 2 },
    ]);
    expect(lb.distribution.reduce((n, d) => n + d.count, 0)).toBe(lb.stats.ranked);
    expect(lb.items.map((i) => i.band)).toEqual(["EXCELLENT", "EXCELLENT", "GOOD", "GOOD", "NEEDS_IMPROVEMENT", "NEEDS_IMPROVEMENT", "BAD", "BAD", "VERY_BAD", "VERY_BAD"]);
  });

  it("excludes unranked participants from the distribution", async () => {
    const e = await setup({ members: 3 });
    await score(e, e.people[0]!, 9500);
    expect((await board(e.people[0]!, e.exam.id)).distribution.map((d) => d.count)).toEqual([0, 0, 0, 0, 1]);
  });
});
