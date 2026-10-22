import { getEnv } from "../../config/env.js";

export type ReleaseFields = { releaseMode: "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME"; closesAt: Date | null; releaseAt: Date | null };

/** The moment results become visible for a version (null = immediately on finalization). Evaluated from server time on every request. */
export function releaseTime(v: ReleaseFields, graceSeconds = getEnv().EXAM_GRACE_SECONDS): Date | null {
  if (v.releaseMode === "AFTER_CLOSE") return v.closesAt ? new Date(v.closesAt.getTime() + graceSeconds * 1000) : null;
  if (v.releaseMode === "AT_TIME") return v.releaseAt;
  return null;
}

/** True when scores/reviews of this version may be shown to participants (an IMMEDIATE exam is released once an attempt is finalized). */
export function isReleased(v: ReleaseFields, now: Date, graceSeconds = getEnv().EXAM_GRACE_SECONDS): boolean {
  if (v.releaseMode === "IMMEDIATE") return true;
  const at = releaseTime(v, graceSeconds);
  return at !== null && now.getTime() >= at.getTime();
}
