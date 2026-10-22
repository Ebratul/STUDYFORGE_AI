import { describe, expect, it } from "vitest";
import { getAuth } from "../../src/auth/auth.js";
import { db } from "../../src/lib/db.js";
import { seedBankQuestions, seedFinalResult, seedGroup, seedPublishedExam } from "../helpers/exam-fixtures.js";
import { createUser, TEST_PASSWORD } from "../helpers/users.js";

describe("account deletion keeps the database consistent", () => {
  it("removes a participant's attempts/results and leaves the group, other members and the exam intact", async () => {
    const [owner, member, other] = await Promise.all([createUser(), createUser(), createUser()]);
    const group = await seedGroup(owner, { members: [{ user: member }, { user: other }] });
    const { version } = await seedPublishedExam({ owner, group, questionCount: 4 });
    await seedFinalResult({ version, user: member, scoreCenti: 300 });
    await seedFinalResult({ version, user: other, scoreCenti: 200 });
    await db.user.delete({ where: { id: member.id } });
    expect(await db.examResult.count({ where: { examVersionId: version.id } })).toBe(1);
    expect(await db.groupMember.count({ where: { groupId: group.id } })).toBe(2);
    expect(await db.examVersion.count({ where: { id: version.id } })).toBe(1);
  });

  it("deleting a user cascades their own questions, exams, groups and notifications without errors", async () => {
    const owner = await createUser();
    const qs = await seedBankQuestions(owner, 3);
    const group = await seedGroup(owner);
    await seedPublishedExam({ owner, group, questionCount: 2 });
    await seedPublishedExam({ owner, questionCount: 2 });
    await db.notification.create({ data: { userId: owner.id, type: "x", title: "t", body: "b" } });
    await expect(db.user.delete({ where: { id: owner.id } })).resolves.toBeTruthy();
    expect(await db.question.count({ where: { id: { in: qs.map((q) => q.id) } } })).toBe(0);
    expect(await db.group.count({ where: { id: group.id } })).toBe(0);
    expect(await db.exam.count({ where: { ownerId: owner.id } })).toBe(0);
  });

  it("dissolving a group by deleting its owner removes the group exams (documented behaviour) but never other users' accounts", async () => {
    const [owner, member] = await Promise.all([createUser(), createUser()]);
    const group = await seedGroup(owner, { members: [{ user: member }] });
    const { exam, version } = await seedPublishedExam({ owner, group });
    await seedFinalResult({ version, user: member, scoreCenti: 100 });
    await db.user.delete({ where: { id: owner.id } });
    expect(await db.exam.count({ where: { id: exam.id } })).toBe(0);
    expect(await db.user.count({ where: { id: member.id } })).toBe(1);
  });

  it("deleting the account through the auth API tells the members of the owner's groups first", async () => {
    const [owner, member] = await Promise.all([createUser(), createUser()]);
    const group = await seedGroup(owner, { title: "Evening batch", members: [{ user: member }] });
    await getAuth().api.deleteUser({ body: { password: TEST_PASSWORD }, headers: owner.headers });
    expect(await db.group.count({ where: { id: group.id } })).toBe(0);
    const n = await db.notification.findMany({ where: { userId: member.id, type: "group.dissolved" } });
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain("Evening batch");
  });
});
