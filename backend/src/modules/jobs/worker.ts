import { randomUUID } from "node:crypto";
import { getEnv } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { redactString } from "../../lib/redact.js";
import { claimNext, markFailed, markSucceeded, reapStale, reschedule, RetryableJobError, type JobRow } from "./queue.js";

export type JobHandler = (job: JobRow, signal: AbortSignal) => Promise<void>;
export type Handlers = Record<string, JobHandler>;

const backoff = (attempt: number) => Math.min(5 * 60_000, 5_000 * 2 ** (attempt - 1));

/** Runs one claimed job and records the outcome. Never throws. */
export async function runJob(job: JobRow, handlers: Handlers, signal: AbortSignal): Promise<void> {
  const handler = handlers[job.type];
  if (!handler) return markFailed(job.id, `No handler for job type ${job.type}`);
  try {
    await handler(job, signal);
    await markSucceeded(job.id);
  } catch (err) {
    const message = redactString(err instanceof Error ? err.message : "Unknown error");
    if (err instanceof RetryableJobError && job.attempts < job.maxAttempts) {
      logger.warn("job.retry", { jobId: job.id, type: job.type, attempt: job.attempts });
      await reschedule(job.id, err.delayMs ?? backoff(job.attempts), message);
    } else {
      logger.error("job.failed", { jobId: job.id, type: job.type, attempts: job.attempts, err });
      await markFailed(job.id, message);
    }
  }
}

/** Drains due jobs (used by tests and by the polling loop). Returns how many ran. */
export async function runDueJobs(handlers: Handlers, workerId = randomUUID(), max = 100): Promise<number> {
  let n = 0;
  const signal = new AbortController().signal;
  while (n < max) {
    const job = await claimNext(workerId);
    if (!job) break;
    await runJob(job, handlers, signal);
    n++;
  }
  return n;
}

export function startWorker(handlers: Handlers): () => Promise<void> {
  const env = getEnv();
  const workerId = `w-${randomUUID().slice(0, 8)}`;
  const abort = new AbortController();
  let stopped = false;
  const active = new Set<Promise<void>>();
  let lastReap = 0;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      if (Date.now() - lastReap > 60_000) {
        lastReap = Date.now();
        await reapStale();
      }
      while (!stopped && active.size < env.JOB_CONCURRENCY) {
        const job = await claimNext(workerId);
        if (!job) break;
        const p: Promise<void> = runJob(job, handlers, abort.signal).finally(() => active.delete(p));
        active.add(p);
      }
    } catch (err) {
      logger.error("worker.tick_failed", { err });
    }
    if (!stopped) timer = setTimeout(tick, env.JOB_POLL_INTERVAL_MS);
  }

  let timer: NodeJS.Timeout = setTimeout(tick, 0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    abort.abort();
    await Promise.allSettled([...active]);
  };
}
