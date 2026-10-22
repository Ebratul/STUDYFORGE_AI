import { afterEach, describe, expect, it } from "vitest";
import { setClock } from "../../src/lib/clock.js";
import { db } from "../../src/lib/db.js";
import { accuracyBp, dataLevel, releasedResultCount, strongTopics, userTopicStats, weakTopics } from "../../src/modules/analytics/stats.js";
import { seedFinalResult, seedPublishedExam } from "../helpers/exam-fixtures.js";
import { createUser } from "../helpers/users.js";

afterEach(() => setClock(null));

describe("analytics stats (shared source of truth)", () => {
  it("rounds accuracy half up in basis points", () => {
    expect(accuracyBp(1, 3)).toBe(3333);
    expect(accuracyBp(2, 3)).toBe(6667);
    expect(accuracyBp(0, 5)).toBe(0);
    expect(accuracyBp(0, 0)).toBe(0);
    expect(accuracyBp(7, 8)).toBe(8750);
  });

  it("derives data levels, weak and strong topics only from enough answers", () => {
    const t = (topic: string, correct: number, total: number) => ({ topic, questions: total, correct, incorrect: total - correct, unanswered: 0, accuracyBp: accuracyBp(correct, total), sufficient: total >= 3 });
    expect(dataLevel(0, [])).toBe("NONE");
    expect(dataLevel(2, [t("A", 5, 10)])).toBe("INITIAL");
    expect(dataLevel(3, [t("A", 1, 4)])).toBe("INITIAL"); // 4 answered < 5
    expect(dataLevel(3, [t("A", 1, 5)])).toBe("BASED_ON_HISTORY");
    const topics = [t("Few", 0, 2), t("Weak", 2, 5), t("Edge", 7, 10), t("Strong", 9, 10)];
    expect(weakTopics(topics).map((x) => x.topic)).toEqual(["Weak"]); // "Few" is not enough data, "Edge" is exactly 70 %
    expect(strongTopics(topics).map((x) => x.topic)).toEqual(["Strong"]);
  });

  it("counts only released results, per user, grouped by topic", async () => {
    const [u, other] = [await createUser(), await createUser()];
    const { version, questions } = await seedPublishedExam({ owner: u, questionCount: 4 });
    const attempt = await seedFinalResult({ version, user: u, scoreCenti: 200 });
    const result = await db.examResult.findUniqueOrThrow({ where: { attemptId: attempt.id } });
    // items: Topic A = q0,q2 (correct, incorrect); Topic B = q1,q3 (correct, unanswered)
    const outcomes = ["CORRECT", "CORRECT", "INCORRECT", "UNANSWERED"] as const;
    await db.examResultItem.createMany({ data: questions.map((q, i) => ({ resultId: result.id, examQuestionId: q.id, selectedOptionId: null, outcome: outcomes[i]!, awardedCenti: outcomes[i] === "CORRECT" ? 100 : 0 })) });
    const stats = await userTopicStats(u.id);
    expect(stats.find((s) => s.topic === "Topic A")).toMatchObject({ questions: 2, correct: 1, incorrect: 1, unanswered: 0, accuracyBp: 5000, sufficient: false });
    expect(stats.find((s) => s.topic === "Topic B")).toMatchObject({ questions: 2, correct: 1, unanswered: 1 });
    expect(await userTopicStats(other.id)).toEqual([]);
    expect(await releasedResultCount(u.id)).toBe(1);

    // a result whose release time hasn't come is invisible to every analytic
    const later = new Date(Date.now() + 3_600_000);
    const held = await seedPublishedExam({ owner: u, questionCount: 2, releaseMode: "AT_TIME", releaseAt: later });
    const a2 = await seedFinalResult({ version: held.version, user: u, scoreCenti: 100 });
    const r2 = await db.examResult.findUniqueOrThrow({ where: { attemptId: a2.id } });
    await db.examResultItem.createMany({ data: held.questions.map((q) => ({ resultId: r2.id, examQuestionId: q.id, outcome: "CORRECT" as const, awardedCenti: 100 })) });
    expect(await releasedResultCount(u.id)).toBe(1);
    setClock(() => new Date(later.getTime() + 1000));
    expect(await releasedResultCount(u.id)).toBe(2);
    expect((await userTopicStats(u.id)).reduce((n, s) => n + s.questions, 0)).toBe(6);
  });
});
