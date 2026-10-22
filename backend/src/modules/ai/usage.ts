import { getEnv } from "../../config/env.js";
import { now as clockNow } from "../../lib/clock.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import type { SessionUser } from "../../auth/types.js";

const utcDayStart = () => {
  const d = new Date(clockNow());
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const utcMonthStart = () => {
  const d = clockNow();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};
const nextMonthStart = (from: Date) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

export type UsageWindow = { tokens: number; requests: number; tokenLimit: number; requestLimit: number; resetsAt: string };
export type DailyUsage = UsageWindow;

async function windowUsage(userId: string, since: Date, tokenLimit: number, requestLimit: number, resetsAt: Date): Promise<UsageWindow> {
  const rows = await db.usageRecord.groupBy({
    by: ["category"],
    where: { userId, createdAt: { gte: since }, category: { in: ["llm.tokens", "llm.requests"] } },
    _sum: { quantity: true },
  });
  const sum = (c: string) => Number(rows.find((r) => r.category === c)?._sum.quantity ?? 0);
  return { tokens: sum("llm.tokens"), requests: sum("llm.requests"), tokenLimit, requestLimit, resetsAt: resetsAt.toISOString() };
}

export async function getDailyUsage(userId: string): Promise<DailyUsage> {
  const env = getEnv();
  const since = utcDayStart();
  return windowUsage(userId, since, env.AI_DAILY_TOKEN_LIMIT, env.AI_DAILY_REQUEST_LIMIT, new Date(since.getTime() + 86_400_000));
}

export async function getMonthlyUsage(userId: string): Promise<UsageWindow> {
  const env = getEnv();
  const since = utcMonthStart();
  return windowUsage(userId, since, env.AI_MONTHLY_TOKEN_LIMIT, env.AI_MONTHLY_REQUEST_LIMIT, nextMonthStart(since));
}

export const USAGE_NOTE = "Tokens are what your provider reports. StudyForge does not know your provider's prices and shows no cost estimate.";

/** Daily + monthly windows and a 30-day breakdown by task (PART5_SPEC §8). `tokens` only count what providers reported. */
export async function getUsageOverview(userId: string) {
  const since = new Date(clockNow().getTime() - 30 * 86_400_000);
  const [daily, monthly, rows] = await Promise.all([
    getDailyUsage(userId),
    getMonthlyUsage(userId),
    db.$queryRaw<{ task: string | null; requests: bigint; tokens: bigint }[]>`
      SELECT "metadata"->>'task' AS "task",
             COALESCE(sum("quantity") FILTER (WHERE "category" = 'llm.requests'), 0) AS "requests",
             COALESCE(sum("quantity") FILTER (WHERE "category" = 'llm.tokens'), 0) AS "tokens"
      FROM "UsageRecord" WHERE "userId" = ${userId} AND "createdAt" >= ${since} AND "category" IN ('llm.requests', 'llm.tokens')
      GROUP BY 1 ORDER BY 3 DESC, 1`,
  ]);
  return { ...daily, daily, monthly, byTask: rows.map((r) => ({ task: r.task ?? "OTHER", requests: Number(r.requests), tokens: Number(r.tokens) })), note: USAGE_NOTE };
}

/** Pre-flight: refuse before spending the user's provider budget when platform limits (daily or monthly) are reached. */
export async function assertWithinQuota(user: Pick<SessionUser, "id">): Promise<void> {
  const [d, m] = await Promise.all([getDailyUsage(user.id), getMonthlyUsage(user.id)]);
  if (d.requestLimit > 0 && d.requests >= d.requestLimit)
    throw new AppError("QUOTA_EXCEEDED", "You've reached today's AI request limit. It resets at midnight UTC.", { resetsAt: d.resetsAt, window: "daily" });
  if (d.tokenLimit > 0 && d.tokens >= d.tokenLimit)
    throw new AppError("QUOTA_EXCEEDED", "You've reached today's AI token limit. It resets at midnight UTC.", { resetsAt: d.resetsAt, window: "daily" });
  if (m.requestLimit > 0 && m.requests >= m.requestLimit)
    throw new AppError("QUOTA_EXCEEDED", "You've reached this month's AI request limit. It resets on the 1st (UTC).", { resetsAt: m.resetsAt, window: "monthly" });
  if (m.tokenLimit > 0 && m.tokens >= m.tokenLimit)
    throw new AppError("QUOTA_EXCEEDED", "You've reached this month's AI token limit. It resets on the 1st (UTC).", { resetsAt: m.resetsAt, window: "monthly" });
}

export async function recordUsage(userId: string, input: { provider: string; model: string; task: string; promptTokens?: number | null; completionTokens?: number | null; /** provider calls made (default 1) */ requests?: number }) {
  const total = (input.promptTokens ?? 0) + (input.completionTokens ?? 0);
  const metadata = { provider: input.provider, model: input.model, task: input.task, promptTokens: input.promptTokens ?? null, completionTokens: input.completionTokens ?? null };
  await db.usageRecord.createMany({
    data: [
      { userId, category: "llm.requests", quantity: BigInt(Math.max(1, input.requests ?? 1)), metadata },
      ...(total > 0 ? [{ userId, category: "llm.tokens", quantity: BigInt(total), metadata }] : []),
    ],
  });
}
