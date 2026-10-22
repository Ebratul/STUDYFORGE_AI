import { getEnv } from "../../config/env.js";
import { db } from "../../lib/db.js";
import { AppError } from "../../lib/errors.js";
import type { SessionUser } from "../../auth/types.js";

const utcDayStart = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

export type DailyUsage = { tokens: number; requests: number; tokenLimit: number; requestLimit: number; resetsAt: string };

export async function getDailyUsage(userId: string): Promise<DailyUsage> {
  const env = getEnv();
  const since = utcDayStart();
  const rows = await db.usageRecord.groupBy({
    by: ["category"],
    where: { userId, createdAt: { gte: since }, category: { in: ["llm.tokens", "llm.requests"] } },
    _sum: { quantity: true },
  });
  const sum = (c: string) => Number(rows.find((r) => r.category === c)?._sum.quantity ?? 0);
  return {
    tokens: sum("llm.tokens"),
    requests: sum("llm.requests"),
    tokenLimit: env.AI_DAILY_TOKEN_LIMIT,
    requestLimit: env.AI_DAILY_REQUEST_LIMIT,
    resetsAt: new Date(since.getTime() + 86_400_000).toISOString(),
  };
}

/** Pre-flight: refuse before spending the user's provider budget when platform limits are reached. */
export async function assertWithinQuota(user: SessionUser): Promise<void> {
  const u = await getDailyUsage(user.id);
  if (u.requestLimit > 0 && u.requests >= u.requestLimit)
    throw new AppError("QUOTA_EXCEEDED", "You've reached today's AI request limit. It resets at midnight UTC.", { resetsAt: u.resetsAt });
  if (u.tokenLimit > 0 && u.tokens >= u.tokenLimit)
    throw new AppError("QUOTA_EXCEEDED", "You've reached today's AI token limit. It resets at midnight UTC.", { resetsAt: u.resetsAt });
}

export async function recordUsage(userId: string, input: { provider: string; model: string; task: string; promptTokens?: number | null; completionTokens?: number | null }) {
  const total = (input.promptTokens ?? 0) + (input.completionTokens ?? 0);
  const metadata = { provider: input.provider, model: input.model, task: input.task, promptTokens: input.promptTokens ?? null, completionTokens: input.completionTokens ?? null };
  await db.usageRecord.createMany({
    data: [
      { userId, category: "llm.requests", quantity: 1n, metadata },
      ...(total > 0 ? [{ userId, category: "llm.tokens", quantity: BigInt(total), metadata }] : []),
    ],
  });
}
