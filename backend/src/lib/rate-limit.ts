import { db } from "./db.js";
import { Errors } from "./errors.js";

export type RateLimitRule = { key: string; limit: number; windowSec: number };
export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSec: number };

/**
 * Fixed-window limiter backed by PostgreSQL (single atomic upsert, safe under concurrency).
 * This is the integration point: a Redis implementation can replace the body without touching callers.
 */
export async function checkRateLimit({ key, limit, windowSec }: RateLimitRule): Promise<RateLimitResult> {
  const rows = await db.$queryRaw<{ count: number; elapsed: number }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "windowStart")
    VALUES (${key}, 1, now())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${windowSec})
                     THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "windowStart" = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${windowSec})
                           THEN now() ELSE "RateLimitBucket"."windowStart" END
    RETURNING "count", EXTRACT(EPOCH FROM (now() - "windowStart"))::float8 AS elapsed`;
  const row = rows[0];
  if (!row) return { allowed: true, remaining: limit, retryAfterSec: 0 };
  const count = Number(row.count);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSec: Math.max(1, Math.ceil(windowSec - Number(row.elapsed))),
  };
}

export async function enforceRateLimit(rule: RateLimitRule): Promise<void> {
  const result = await checkRateLimit(rule);
  if (!result.allowed) throw Errors.rateLimited(result.retryAfterSec);
}

/** Housekeeping: drop expired buckets. Safe to call from a cron/worker later. */
export async function purgeExpiredBuckets(olderThanSec = 3600): Promise<number> {
  const { count } = await db.rateLimitBucket.deleteMany({
    where: { windowStart: { lt: new Date(Date.now() - olderThanSec * 1000) } },
  });
  return count;
}
