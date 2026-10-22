import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setClock } from "../../src/lib/clock.js";
import { db } from "../../src/lib/db.js";
import { seedGradedResult, seedGroup, seedPublishedExam } from "../helpers/exam-fixtures.js";
import { client, makeApp, type TestApp } from "../helpers/http.js";
import { createUser, type TestUser } from "../helpers/users.js";

let t: TestApp;
beforeEach(() => {
  t = makeApp();
});
afterEach(() => setClock(null));

type Topics = { released: boolean; hidden?: boolean; releasesAt: string | null; topics?: { topic: string; questions: number; participants: number; accuracyBp: number }[]; completion?: Record<string, number> };
const topics = async (u: TestUser, examId: string): Promise<Topics> => {
  const res = await client(t, u).get(`/api/exams/${examId}/topics`);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
};

const T = ["Cells", "Cells", "Energy", "Energy"];
type O = "CORRECT" | "INCORRECT" | "UNANSWERED";
async function setup(members: number, version: Record<string, unknown> = {}) {
  const owner = await createUser({ name: "Olivia Owner" });
  const people = await Promise.all(Array.from({ length: members }, (_, i) => createUser({ name: `Member ${i + 1} Name` })));
  const group = await seedGroup(owner, { capacity: 50, members: people.map((user) => ({ user })) });
  const e = await seedPublishedExam({ owner, group, questionCount: 4, topics: T, ...version });
  return { owner, people, group, ...e };
}
const grade = (e: Awaited<ReturnType<typeof setup>>, u: TestUser, outcomes: O[]) => seedGradedResult({ version: e.version, questions: e.questions, user: u, outcomes });

describe("group topic analytics", () => {
  it("aggregates topic accuracy over current participants and reports completion", async () => {
    const e = await setup(4);
    await grade(e, e.people[0]!, ["CORRECT", "CORRECT", "INCORRECT", "INCORRECT"]);
    await grade(e, e.people[1]!, ["CORRECT", "INCORRECT", "INCORRECT", "CORRECT"]);
    await grade(e, e.people[2]!, ["INCORRECT", "INCORRECT", "UNANSWERED", "CORRECT"]);
    const r = await topics(e.people[3]!, e.exam.id); // the 4th member hasn't taken it
    expect(r.released).toBe(true);
    expect(r.topics).toEqual([
      { topic: "Energy", questions: 6, participants: 3, accuracyBp: 3333 },
      { topic: "Cells", questions: 6, participants: 3, accuracyBp: 5000 },
    ]);
    expect(r.completion).toEqual({ eligible: 4, submitted: 3, timedOut: 0, inProgress: 0, notStarted: 1, missed: 0 });
  });

  it("uses each participant's best attempt, like the leaderboard", async () => {
    const e = await setup(3, { attemptLimit: 3 });
    for (const p of e.people) await grade(e, p, ["INCORRECT", "INCORRECT", "INCORRECT", "INCORRECT"]);
    await seedGradedResult({ version: e.version, questions: e.questions, user: e.people[0]!, outcomes: ["CORRECT", "CORRECT", "CORRECT", "CORRECT"], attemptNo: 2 });
    const r = await topics(e.people[1]!, e.exam.id);
    expect(r.topics!.find((x) => x.topic === "Cells")).toMatchObject({ participants: 3, questions: 6, accuracyBp: 3333 });
  });

  it("omits topics with fewer than 3 participants and never returns per-user rows", async () => {
    const e = await setup(3);
    await grade(e, e.people[0]!, ["CORRECT", "CORRECT", "CORRECT", "CORRECT"]);
    await grade(e, e.people[1]!, ["CORRECT", "CORRECT", "CORRECT", "CORRECT"]);
    const small = await topics(e.people[2]!, e.exam.id);
    expect(small.topics).toEqual([]);
    expect(small.completion).toMatchObject({ submitted: 2, notStarted: 1 });
    await grade(e, e.people[2]!, ["CORRECT", "INCORRECT", "CORRECT", "CORRECT"]);
    const full = await topics(e.people[2]!, e.exam.id);
    expect(full.topics).toHaveLength(2);
    const raw = JSON.stringify(full);
    for (const p of [...e.people, e.owner]) expect(raw).not.toContain(p.id);
    expect(raw).not.toMatch(/displayName|email|entryId/);
  });

  it("excludes the author and removed members", async () => {
    const e = await setup(3);
    for (const p of e.people) await grade(e, p, ["CORRECT", "CORRECT", "CORRECT", "CORRECT"]);
    await db.groupMember.delete({ where: { groupId_userId: { groupId: e.group.id, userId: e.people[2]!.id } } });
    const r = await topics(e.people[0]!, e.exam.id);
    expect(r.topics).toEqual([]); // only 2 current participants remain
    expect(r.completion!.eligible).toBe(2);
  });

  it("is unavailable to outsiders and for non-group exams (404), and requires auth", async () => {
    const e = await setup(3);
    const outsider = await createUser();
    expect((await client(t, outsider).get(`/api/exams/${e.exam.id}/topics`)).status).toBe(404);
    expect((await client(t).get(`/api/exams/${e.exam.id}/topics`)).status).toBe(401);
    const solo = await seedPublishedExam({ owner: outsider, questionCount: 2 });
    expect((await client(t, outsider).get(`/api/exams/${solo.exam.id}/topics`)).status).toBe(404);
    expect((await client(t, outsider).get("/api/exams/does-not-exist/topics")).status).toBe(404);
  });

  it("stays closed until the release time: no topics before, topics after (completion is visible earlier)", async () => {
    const releaseAt = new Date(Date.now() + 3_600_000);
    const e = await setup(3, { releaseMode: "AT_TIME", releaseAt });
    for (const p of e.people) await grade(e, p, ["CORRECT", "INCORRECT", "CORRECT", "CORRECT"]);
    const before = await topics(e.people[0]!, e.exam.id);
    expect(before).toMatchObject({ released: false, topics: [], completion: { submitted: 3 } });
    expect((await topics(e.owner, e.exam.id)).topics).toEqual([]); // staff don't get early access either
    setClock(() => new Date(releaseAt.getTime() + 1000));
    expect((await topics(e.people[0]!, e.exam.id)).topics).toHaveLength(2);
    expect((await topics(e.owner, e.exam.id)).topics).toHaveLength(2);
  });

  it("respects a hidden leaderboard: members get nothing, staff keep the aggregates", async () => {
    const e = await setup(3, { leaderboardVisible: false });
    for (const p of e.people) await grade(e, p, ["CORRECT", "CORRECT", "CORRECT", "CORRECT"]);
    expect(await topics(e.people[0]!, e.exam.id)).toMatchObject({ released: true, hidden: true });
    expect((await topics(e.people[0]!, e.exam.id)).topics).toBeUndefined();
    expect((await topics(e.owner, e.exam.id)).topics).toHaveLength(2);
  });
});
