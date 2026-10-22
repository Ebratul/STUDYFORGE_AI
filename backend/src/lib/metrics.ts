import { now as clockNow } from "./clock.js";
import { db } from "./db.js";
import { getEnv } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Operational counters (PART5_SPEC §9). In-memory increments, flushed to the hourly `MetricBucket` table.
 * Labels are coarse and fixed-vocabulary by construction: no user ids, no path parameters, no content.
 */

const counters = new Map<string, number>();
const SEP = "\u0000";
const HOUR_MS = 3_600_000;

export const hourStart = (d: Date): Date => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);

/** Keeps labels to a small, safe alphabet (defence against accidental ids/content ending up in a label). */
export function cleanLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_.:|/-]/g, "_").slice(0, 80);
}

export function incr(name: string, label = "", n = 1): void {
  const key = [hourStart(clockNow()).getTime(), cleanLabel(name), cleanLabel(label)].join(SEP);
  counters.set(key, (counters.get(key) ?? 0) + n);
}

const ROUTE_GROUPS = new Set(["auth", "me", "profile", "preferences", "notifications", "sessions", "account", "dashboard", "admin", "ai", "conversations", "documents", "questions", "collections", "generation", "export", "exams", "attempts", "groups", "analysis", "assistant", "analytics"]);

/** `/api/questions/abc123` -> `questions`. Unknown first segments collapse to `other` (bounded cardinality). */
export function routeGroup(path: string): string {
  const seg = path.split("/")[2] ?? "";
  return ROUTE_GROUPS.has(seg) ? seg : "other";
}

export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

export function recordRequest(path: string, status: number): void {
  if (path === "/api/health" || path === "/api/ready") return;
  incr("api.request", `${routeGroup(path)}|${statusClass(status)}`);
}

export function recordBlock(kind: "rate_limit" | "quota", path: string): void {
  incr(`block.${kind}`, routeGroup(path));
}

/** Outcome of one call to the AI service for a user-selected provider. `code` is the normalised error code (never provider text). */
export function recordProviderEvent(provider: string, task: string, ok: boolean, code?: string | null): void {
  const base = `${provider.toLowerCase()}|${task.toLowerCase()}`;
  incr("provider.call", ok ? `${base}|ok` : `${base}|error|${code ?? "UNKNOWN"}`);
}

/** Writes the pending counters (additively) and clears them. On failure the counts are put back for the next attempt. */
export async function flushMetrics(): Promise<number> {
  if (!counters.size) return 0;
  const batch = [...counters.entries()];
  counters.clear();
  let written = 0;
  try {
    for (const [key, count] of batch) {
      const [bucketMs, name, label] = key.split(SEP) as [string, string, string];
      await db.$executeRaw`
        INSERT INTO "MetricBucket" ("bucket", "name", "label", "count") VALUES (${new Date(Number(bucketMs))}, ${name}, ${label}, ${count})
        ON CONFLICT ("bucket", "name", "label") DO UPDATE SET "count" = "MetricBucket"."count" + EXCLUDED."count"`;
      written++;
    }
  } catch (err) {
    for (const [key, count] of batch.slice(written)) counters.set(key, (counters.get(key) ?? 0) + count);
    logger.warn("metrics.flush_failed", { err });
  }
  return written;
}

export async function purgeOldMetrics(days = getEnv().METRICS_RETENTION_DAYS): Promise<number> {
  const { count } = await db.metricBucket.deleteMany({ where: { bucket: { lt: new Date(clockNow().getTime() - days * 86_400_000) } } });
  return count;
}

let timer: NodeJS.Timeout | undefined;
export function startMetricsFlusher(): void {
  if (timer) return;
  timer = setInterval(() => void flushMetrics(), getEnv().METRICS_FLUSH_SECONDS * 1000);
  timer.unref();
}
export async function stopMetricsFlusher(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await flushMetrics();
}

/** Test helper. */
export function resetMetricsForTests(): void {
  counters.clear();
}
