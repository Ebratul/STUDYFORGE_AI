import type { Prisma } from "../../generated/prisma/client.js";
import { db } from "../../lib/db.js";

export type JobRow = { id: string; type: string; payload: Prisma.JsonValue; attempts: number; maxAttempts: number };
type Tx = Pick<typeof db, "job">;

/** Thrown by a handler to request another attempt (with an optional delay). Anything else is permanent. */
export class RetryableJobError extends Error {
  constructor(message: string, public readonly delayMs?: number) {
    super(message);
    this.name = "RetryableJobError";
  }
}

/**
 * Creates a job. `dedupeKey` is UNIQUE while the job is pending/running (and cleared on completion),
 * so concurrent duplicate requests cannot create two active jobs: the loser gets `null`.
 */
export async function enqueue(
  tx: Tx,
  input: { type: string; payload: Prisma.InputJsonValue; dedupeKey?: string; maxAttempts?: number; runAt?: Date },
): Promise<string | null> {
  try {
    const job = await tx.job.create({
      data: { type: input.type, payload: input.payload, dedupeKey: input.dedupeKey, maxAttempts: input.maxAttempts ?? 3, runAt: input.runAt ?? new Date() },
      select: { id: true },
    });
    return job.id;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return null; // active job with this dedupeKey already exists
    throw err;
  }
}

/** Atomically claims the next due job (FOR UPDATE SKIP LOCKED): two workers can never run the same job. */
export async function claimNext(workerId: string): Promise<JobRow | null> {
  const rows = await db.$queryRaw<JobRow[]>`
    UPDATE "Job" SET "status" = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${workerId}, "attempts" = "attempts" + 1, "updatedAt" = now()
    WHERE "id" = (
      SELECT "id" FROM "Job" WHERE "status" = 'PENDING' AND "runAt" <= now()
      ORDER BY "runAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING "id", "type", "payload", "attempts", "maxAttempts"`;
  return rows[0] ?? null;
}

export async function markSucceeded(id: string) {
  await db.job.update({ where: { id }, data: { status: "SUCCEEDED", dedupeKey: null, lockedAt: null, lockedBy: null, lastError: null } });
}

export async function markFailed(id: string, error: string) {
  await db.job.update({ where: { id }, data: { status: "FAILED", dedupeKey: null, lockedAt: null, lockedBy: null, lastError: error.slice(0, 500) } });
}

export async function reschedule(id: string, delayMs: number, error: string) {
  await db.job.update({ where: { id }, data: { status: "PENDING", runAt: new Date(Date.now() + delayMs), lockedAt: null, lockedBy: null, lastError: error.slice(0, 500) } });
}

/** Recovers jobs whose worker died (lock older than `staleMs`). */
export async function reapStale(staleMs = 15 * 60 * 1000): Promise<number> {
  const { count } = await db.job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - staleMs) } },
    data: { status: "PENDING", lockedAt: null, lockedBy: null },
  });
  return count;
}
