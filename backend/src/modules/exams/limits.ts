import { getEnv } from "../../config/env.js";

/** Field limits (constants) and exam/group limits (env). Exposed by GET /api/exams/limits; the frontend never hard-codes them. */
export const EXAM_FIELDS = {
  title: 120,
  description: 1000,
  marksMin: 0.25,
  marksMax: 100,
  reminderMinutesMax: 10_080,
  optionsMin: 2,
  optionsMax: 6,
  groupTitle: 80,
  groupDescription: 500,
} as const;

export function examLimits() {
  const e = getEnv();
  // Keys are the camel-cased environment variable names (PART4_SPEC §9).
  return {
    examMaxQuestions: e.EXAM_MAX_QUESTIONS,
    examMaxDurationMinutes: e.EXAM_MAX_DURATION_MINUTES,
    examMaxAttemptLimit: e.EXAM_MAX_ATTEMPT_LIMIT,
    examMaxDraftsPerUser: e.EXAM_MAX_DRAFTS_PER_USER,
    examGraceSeconds: e.EXAM_GRACE_SECONDS,
    examSweepIntervalSeconds: e.EXAM_SWEEP_INTERVAL_SECONDS,
    groupMaxOwnedPerUser: e.GROUP_MAX_OWNED_PER_USER,
    groupMaxMembershipsPerUser: e.GROUP_MAX_MEMBERSHIPS_PER_USER,
    groupMaxCapacity: e.GROUP_MAX_CAPACITY,
    groupDefaultCapacity: e.GROUP_DEFAULT_CAPACITY,
    inviteDefaultTtlHours: e.INVITE_DEFAULT_TTL_HOURS,
    inviteMaxTtlHours: e.INVITE_MAX_TTL_HOURS,
    inviteMaxUses: e.INVITE_MAX_USES,
    inviteMaxActivePerGroup: e.INVITE_MAX_ACTIVE_PER_GROUP,
  } as const;
}
