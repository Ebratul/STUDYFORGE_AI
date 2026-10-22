import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.js";
import { claimNext, enqueue, reapStale, RetryableJobError } from "../../src/modules/jobs/queue.js";
import { runDueJobs } from "../../src/modules/jobs/worker.js";

const type = () => `t-${randomUUID()}`;

describe("job queue", () => {
  it("claims each due job exactly once under concurrency (SKIP LOCKED)", async () => {
    const ty = type();
    for (let i = 0; i < 20; i++) await enqueue(db, { type: ty, payload: { i } });
    // other test files may leave due jobs; drain everything of other types first by claiming only ours below
    const claimed = (await Promise.all(Array.from({ length: 40 }, (_, i) => claimNext(`w${i}`)))).filter(Boolean);
    const ours = claimed.filter((j) => j!.type === ty);
    expect(new Set(ours.map((j) => j!.id)).size).toBe(ours.length); // no job handed to two workers
    for (const j of claimed) await db.job.update({ where: { id: j!.id }, data: { status: "SUCCEEDED" } });
  });

  it("dedupeKey prevents a second active job and is released on completion", async () => {
    const ty = type();
    const key = `k-${randomUUID()}`;
    const first = await enqueue(db, { type: ty, payload: {}, dedupeKey: key });
    expect(first).toBeTruthy();
    expect(await enqueue(db, { type: ty, payload: {}, dedupeKey: key })).toBeNull();
    // concurrent duplicate creation: exactly one wins
    const key2 = `k-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => enqueue(db, { type: ty, payload: {}, dedupeKey: key2 })));
    expect(results.filter(Boolean)).toHaveLength(1);

    await runDueJobs({ [ty]: async () => undefined });
    expect(await enqueue(db, { type: ty, payload: {}, dedupeKey: key })).toBeTruthy();
    await runDueJobs({ [ty]: async () => undefined });
  });

  it("retries retryable errors with backoff up to maxAttempts, and fails permanent errors immediately", async () => {
    const retry = type();
    const perm = type();
    const r = (await enqueue(db, { type: retry, payload: {}, maxAttempts: 2 }))!;
    const p = (await enqueue(db, { type: perm, payload: {}, maxAttempts: 5 }))!;
    const handlers = {
      [retry]: async () => {
        throw new RetryableJobError("later", 60_000);
      },
      [perm]: async () => {
        throw new Error("boom sk-abcdefghijklmnopqrstuvwx");
      },
    };
    await runDueJobs(handlers);
    const afterFirst = await db.job.findUniqueOrThrow({ where: { id: r } });
    expect(afterFirst.status).toBe("PENDING");
    expect(afterFirst.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    const failed = await db.job.findUniqueOrThrow({ where: { id: p } });
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(failed.lastError).not.toContain("sk-abcdef"); // secrets are redacted from stored errors

    await db.job.update({ where: { id: r }, data: { runAt: new Date() } });
    await runDueJobs(handlers);
    expect((await db.job.findUniqueOrThrow({ where: { id: r } })).status).toBe("FAILED"); // attempts exhausted
  });

  it("recovers jobs abandoned by a dead worker", async () => {
    const ty = type();
    const id = (await enqueue(db, { type: ty, payload: {} }))!;
    await db.job.update({ where: { id }, data: { status: "RUNNING", lockedAt: new Date(Date.now() - 30 * 60_000), lockedBy: "dead-worker" } });
    expect(await reapStale()).toBeGreaterThanOrEqual(1);
    expect(await db.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PENDING", lockedBy: null });
    await runDueJobs({ [ty]: async () => undefined });
  });

  it("unknown job types fail instead of looping", async () => {
    const id = (await enqueue(db, { type: type(), payload: {} }))!;
    await runDueJobs({});
    expect((await db.job.findUniqueOrThrow({ where: { id } })).status).toBe("FAILED");
  });
});
