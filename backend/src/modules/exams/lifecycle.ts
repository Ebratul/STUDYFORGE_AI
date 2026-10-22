import { finalizeExpiredAttempts } from "./attempts.js";

/**
 * Cross-module entry points owned by the exams module (see PART4_SPEC §5.4). The groups/leaderboard module calls these.
 */

/** Finalizes (idempotently) every expired in-progress attempt of one exam version, bounded. Returns how many were finalized. */
export async function finalizeExpiredForVersion(versionId: string, max = 200): Promise<number> {
  return finalizeExpiredAttempts({ versionId, max });
}
