/** Whole days elapsed since `date` (minimum 1). Kept out of components so render stays pure. */
export function daysSince(date: Date, now: number = Date.now()): number {
  return Math.max(1, Math.ceil((now - date.getTime()) / 86_400_000));
}

export function daysAgo(days: number, now: number = Date.now()): Date {
  return new Date(now - days * 86_400_000);
}
