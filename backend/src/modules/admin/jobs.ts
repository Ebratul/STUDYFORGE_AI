import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { flushMetrics, purgeOldMetrics } from "../../lib/metrics.js";
import { enqueue } from "../jobs/queue.js";
import type { Handlers } from "../jobs/worker.js";
import { HEARTBEAT_INTERVAL_SECONDS } from "./service.js";

/** One pass: heartbeat (proves a worker is alive), flush this process's counters, purge expired metric buckets. */
export async function heartbeatOnce(): Promise<{ purged: number }> {
  const at = clockNow();
  await db.serviceHeartbeat.upsert({ where: { name: "worker" }, create: { name: "worker", beatAt: at }, update: { beatAt: at } });
  await flushMetrics();
  return { purged: await purgeOldMetrics(getEnv().METRICS_RETENTION_DAYS) };
}

const other = (slot: string) => (slot === "a" ? "b" : "a");

/** Starts the heartbeat chain once at server start if none is queued. */
export async function ensureOpsScheduled(): Promise<void> {
  const active = await db.job.findFirst({ where: { type: "ops.heartbeat", status: { in: ["PENDING", "RUNNING"] } }, select: { id: true } });
  if (active) return;
  await enqueue(db, { type: "ops.heartbeat", payload: { slot: "a" }, dedupeKey: "ops-heartbeat-a", maxAttempts: 3 });
}

export function opsHandlers(): Handlers {
  return {
    // Re-schedules itself in `finally` (alternating dedupe slots: a running job still holds its own key).
    "ops.heartbeat": async (job) => {
      const slot = (job.payload as { slot?: string }).slot === "b" ? "b" : "a";
      try {
        await heartbeatOnce();
      } catch (err) {
        logger.error("ops.heartbeat_failed", { err });
      } finally {
        await enqueue(db, { type: "ops.heartbeat", payload: { slot: other(slot) }, dedupeKey: `ops-heartbeat-${other(slot)}`, maxAttempts: 3, runAt: new Date(Date.now() + HEARTBEAT_INTERVAL_SECONDS * 1000) });
      }
    },
  };
}
