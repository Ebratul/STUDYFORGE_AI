import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  canChangeRoles, canEditGroup, canLeave, canManageInvites, canPublishGroupExam, canRemoveMember, describeGroupError, formatCode, inviteLink, inviteUsage, joinPath, newGroupExamLink,
  normalizeCodeInput, readExamRow, readGroupDetail, readGroupSummary, readInvite, readList, readMember, resolveGroupLimits, ttlOptions, INVITE_STATUS_LABEL, leaderboardLink,
} from "@/lib/groups";
import {
  distributionSummary, distributionTotal, formatMarks, formatPercent, formatScore, isFinalized, isMedalRank, isZeroScore, rankAriaLabel, rankText, readDistribution, readEntry, readLeaderboard,
  readParticipants, statusChip,
} from "@/lib/leaderboard";

describe("role helpers (display only; the server enforces the matrix)", () => {
  it("matches the permission matrix", () => {
    expect([canEditGroup("OWNER"), canEditGroup("ADMIN"), canEditGroup("MEMBER")]).toEqual([true, false, false]);
    expect([canManageInvites("OWNER"), canManageInvites("ADMIN"), canManageInvites("MEMBER")]).toEqual([true, true, false]);
    expect([canPublishGroupExam("OWNER"), canPublishGroupExam("ADMIN"), canPublishGroupExam("MEMBER")]).toEqual([true, true, false]);
    expect([canChangeRoles("OWNER"), canChangeRoles("ADMIN")]).toEqual([true, false]);
    expect([canLeave("OWNER"), canLeave("ADMIN"), canLeave("MEMBER")]).toEqual([false, true, true]);
  });
  it("removal: owner removes anyone but the owner; admin removes members only; nobody removes themselves here", () => {
    expect(canRemoveMember("OWNER", "ADMIN", false)).toBe(true);
    expect(canRemoveMember("OWNER", "MEMBER", false)).toBe(true);
    expect(canRemoveMember("OWNER", "OWNER", false)).toBe(false);
    expect(canRemoveMember("ADMIN", "MEMBER", false)).toBe(true);
    expect(canRemoveMember("ADMIN", "ADMIN", false)).toBe(false);
    expect(canRemoveMember("ADMIN", "OWNER", false)).toBe(false);
    expect(canRemoveMember("MEMBER", "MEMBER", false)).toBe(false);
    expect(canRemoveMember("OWNER", "MEMBER", true)).toBe(false);
  });
});

describe("invitations", () => {
  it("labels statuses and usage", () => {
    expect(INVITE_STATUS_LABEL).toEqual({ ACTIVE: "Active", EXPIRED: "Expired", REVOKED: "Revoked", USED_UP: "Used up" });
    expect(inviteUsage({ useCount: 0, maxUses: 1 })).toBe("0 of 1 use");
    expect(inviteUsage({ useCount: 3, maxUses: 10 })).toBe("3 of 10 uses");
  });
  it("groups codes for reading but copies the raw code", () => {
    expect(formatCode("ABCDEFGHJKLMNPQRSTUVWXYZ23")).toBe("ABCD EFGH JKLM NPQR STUV WXYZ 23");
    expect(formatCode("ABCDE-FGHJK-LMNPQ")).toBe("ABCDE-FGHJK-LMNPQ"); // already grouped by the server
    expect(formatCode("ABCD")).toBe("ABCD");
    expect(formatCode("ABCD EFGH")).toBe("ABCD EFGH");
  });
  it("normalises pasted input: spaces, dashes, whole links, encoded text; case is preserved", () => {
    expect(normalizeCodeInput("  ABCD EFGH-JKLM  ")).toBe("ABCDEFGHJKLM");
    expect(normalizeCodeInput("https://studyforge.example/join/AbCdEfGhJkLm?x=1")).toBe("AbCdEfGhJkLm");
    expect(normalizeCodeInput("/join/ABCD%20EFGH")).toBe("ABCDEFGH");
    expect(normalizeCodeInput("ABCD%20EFGH")).toBe("ABCDEFGH");
  });
  it("builds links safely", () => {
    expect(joinPath("AB/C D")).toBe("/join/AB%2FC%20D");
    expect(inviteLink("ABC", "https://app.example/")).toBe("https://app.example/join/ABC");
    expect(newGroupExamLink("g 1")).toBe("/exams/new?mode=GROUP&groupId=g%201");
    expect(leaderboardLink("e1")).toBe("/exams/e1/leaderboard");
  });
  it("offers only expiry presets within the server maximum", () => {
    expect(ttlOptions(720).map((t) => t.hours)).toEqual([1, 24, 168, 720]);
    expect(ttlOptions(48).map((t) => t.hours)).toEqual([1, 24]);
  });
});

describe("tolerant response readers", () => {
  it("reads limits with documented fallbacks", () => {
    expect(resolveGroupLimits(null)).toMatchObject({ groupMaxCapacity: 500, groupDefaultCapacity: 30, inviteMaxTtlHours: 720 });
    expect(resolveGroupLimits({ limits: { groupMaxCapacity: 50, inviteMaxUses: "x" } })).toMatchObject({ groupMaxCapacity: 50, inviteMaxUses: 500 });
  });
  it("reads group summaries/details whichever shape carries the caller's role", () => {
    expect(readGroupSummary({ id: "g", title: "T", role: "ADMIN", memberCount: 3, capacity: 10 })).toMatchObject({ id: "g", role: "ADMIN", memberCount: 3, nextExam: null });
    expect(readGroupDetail({ id: "g", title: "T", myRole: "OWNER", memberCount: 1, capacity: 5, me: { showNameOnLeaderboard: false } })).toMatchObject({ role: "OWNER", showNameOnLeaderboard: false });
    expect(readGroupDetail({ id: "g", title: "T", me: { role: "MEMBER" } })).toMatchObject({ role: "MEMBER", showNameOnLeaderboard: true });
    expect(readGroupDetail(null).role).toBe("MEMBER"); // unknown role is the least-privileged one
  });
  it("reads lists, members, invites and exam rows", () => {
    expect(readList({ items: [{ id: "a" }], total: 7, page: 2, pageSize: 5 }, readInvite)).toMatchObject({ total: 7, page: 2, pageSize: 5 });
    expect(readList({ groups: [{ id: "g" }] }, readGroupSummary).items).toHaveLength(1);
    expect(readMember({ memberId: "m", displayName: "Rina", role: "ADMIN", joinedAt: "2026-01-01T00:00:00Z", isSelf: true })).toMatchObject({ memberId: "m", role: "ADMIN", isSelf: true });
    expect(readInvite({ id: "i", status: "BOGUS", maxUses: 2 }).status).toBe("ACTIVE");
    expect(readExamRow({ id: "e", title: "X", myStatus: "TIMED_OUT" }).participation).toBe("TIMED_OUT");
    expect(readExamRow({ id: "e", title: "X", participation: "nonsense" }).participation).toBeNull();
    expect(readExamRow({ id: "e", title: "X", myStatus: "AUTHOR", myResult: null }).participation).toBe("AUTHOR");
    expect(readExamRow({ id: "e", title: "X", myStatus: "SUBMITTED", myResult: { released: false } }).result).toEqual({ released: false });
    expect(readExamRow({ id: "e", title: "X", myStatus: "SUBMITTED", myResult: { released: true, percentBp: 8500 } }).result).toEqual({ released: true, percentBp: 8500 });
    expect(readExamRow({ id: "e", title: "X", leaderboardVisible: false }).leaderboardVisible).toBe(false);
  });
});

describe("error messages", () => {
  const e = (code: string, message = "server text", details?: Record<string, unknown>) => ({ code, message, details });
  it("never says why an invitation failed", () => {
    const m = describeGroupError(e("INVALID_INVITE"), "join");
    expect(m).toMatch(/isn.t valid/);
    expect(m).toMatch(/expired, been revoked, already been used up, or be meant for someone else/);
  });
  it("explains full groups, rate limits and permissions", () => {
    expect(describeGroupError(e("GROUP_FULL"))).toMatch(/full/);
    expect(describeGroupError(e("RATE_LIMITED", "", { retryAfterSec: 30 }))).toMatch(/30 seconds/);
    expect(describeGroupError(e("RATE_LIMITED", "", { retryAfterSec: 600 }))).toMatch(/10 minutes/);
    expect(describeGroupError(e("RATE_LIMITED"))).toMatch(/wait a while/);
    expect(describeGroupError(e("NOT_ELIGIBLE"))).toMatch(/permission/);
    expect(describeGroupError(e("CONFLICT", "Already done."))).toBe("Already done.");
    expect(describeGroupError(new ApiError(409, "CONFLICT", "That name is taken."))).toBe("That name is taken.");
  });
});

describe("leaderboard formatting and ranks", () => {
  it("formats marks (centi-marks) and percentages (basis points) with fixed rounding", () => {
    expect(formatMarks(1000)).toBe("10");
    expect(formatMarks(750)).toBe("7.5");
    expect(formatMarks(725)).toBe("7.25");
    expect(formatMarks(null)).toBe("—");
    expect(formatPercent(8750)).toBe("87.50%");
    expect(formatPercent(0)).toBe("0.00%");
    expect(formatPercent(null)).toBe("—");
    expect(formatScore({ scoreCenti: 750, maxCenti: 1000 })).toBe("7.5 / 10");
    expect(formatScore({ scoreCenti: null, maxCenti: 1000 })).toBe("—");
  });
  it("shows the server's rank as received: ties repeat, the next rank skips, unranked is a dash", () => {
    const ranks = [1, 2, 2, 4, null].map((r) => rankText(r));
    expect(ranks).toEqual(["1", "2", "2", "4", "—"]);
    expect([1, 2, 3, 4, null].map(isMedalRank)).toEqual([true, true, true, false, false]);
    expect(rankAriaLabel(2)).toBe("Rank 2");
    expect(rankAriaLabel(null)).toBe("Not ranked");
  });
  it("maps every participation status to a distinct label and tone", () => {
    const chips = (["SUBMITTED", "TIMED_OUT", "IN_PROGRESS", "NOT_STARTED", "MISSED"] as const).map(statusChip);
    expect(new Set(chips.map((c) => c.label)).size).toBe(5);
    expect(chips.map((c) => c.label)).toEqual(["Submitted", "Timed out", "In progress", "Not started", "Missed"]);
    expect(new Set(chips.map((c) => c.icon)).size).toBe(5); // icon + text + tone, never colour alone
  });
  it("distinguishes a finalized zero from not-started and in-progress", () => {
    const base = { scoreCenti: 0 as number | null };
    expect(isZeroScore({ ...base, status: "SUBMITTED" })).toBe(true);
    expect(isZeroScore({ ...base, status: "TIMED_OUT" })).toBe(true);
    expect(isZeroScore({ scoreCenti: null, status: "NOT_STARTED" })).toBe(false);
    expect(isZeroScore({ scoreCenti: null, status: "IN_PROGRESS" })).toBe(false);
    expect(isZeroScore({ scoreCenti: 100, status: "SUBMITTED" })).toBe(false);
    expect(isFinalized({ status: "TIMED_OUT" })).toBe(true);
    expect(isFinalized({ status: "IN_PROGRESS" })).toBe(false);
  });
});

describe("distribution chart data", () => {
  it("always yields the five bands in order with the server's counts and zero for missing ones", () => {
    const d = readDistribution([{ band: "90_100", label: "90% – 100%", count: 2 }, { band: "BELOW_60", label: "Below 60%", count: 5 }, { band: "garbage", count: 9 }]);
    expect(d.map((b) => b.band)).toEqual(["BELOW_60", "60_70", "70_80", "80_90", "90_100"]);
    expect(d.map((b) => b.count)).toEqual([5, 0, 0, 0, 2]);
    expect(distributionTotal(d)).toBe(7);
    expect(readDistribution(undefined).every((b) => b.count === 0)).toBe(true);
  });
  it("has a text alternative", () => {
    expect(distributionSummary(readDistribution([]))).toBe("No scores yet.");
    expect(distributionSummary(readDistribution([{ band: "70_80", count: 1 }]))).toContain("1 ranked participant: Below 60%: 0; 60% – below 70%: 0; 70% – below 80%: 1");
  });
});

describe("leaderboard readers", () => {
  it("reads the not-released response without any scores", () => {
    const r = readLeaderboard({ released: false, releasesAt: "2026-12-01T10:00:00Z", participants: { total: 4, submitted: 1, timedOut: 1, inProgress: 1, notStarted: 1 }, items: [{ rank: 1, scoreCenti: 999 }] });
    expect(r).toEqual({ released: false, hidden: false, releasesAt: "2026-12-01T10:00:00Z", myStatus: null, participants: { total: 4, submitted: 1, timedOut: 1, inProgress: 1, notStarted: 1, missed: 0 } });
    expect(readLeaderboard({ released: false, myStatus: "IN_PROGRESS", participants: { total: 1, missed: 2 } })).toMatchObject({ myStatus: "IN_PROGRESS", participants: { missed: 2 } });
    expect(readLeaderboard({ released: false, hidden: true, releasesAt: null })).toEqual({ released: false, hidden: true, releasesAt: null });
  });
  it("treats anything that isn't explicitly released as not released", () => {
    expect(readLeaderboard({ items: [{ rank: 1 }] }).released).toBe(false);
    expect(readLeaderboard(null).released).toBe(false);
  });
  it("reads released entries and never invents ranks", () => {
    const r = readLeaderboard({
      released: true, policy: "COMPETITION_1224_BEST_ATTEMPT", total: 3, page: 1, pageSize: 25,
      items: [
        { entryId: "a", rank: 1, displayName: "Rina", status: "SUBMITTED", scoreCenti: 1000, maxCenti: 1000, percentBp: 10000, band: "EXCELLENT", submittedAt: "2026-01-01T00:00:00Z" },
        { entryId: "b", rank: 1, displayName: "Anonymous participant", status: "TIMED_OUT", scoreCenti: 1000, maxCenti: 1000, percentBp: 10000, band: "EXCELLENT", submittedAt: null },
        { entryId: "c", rank: null, displayName: "Sam", isSelf: true, status: "IN_PROGRESS", scoreCenti: null, maxCenti: 1000, percentBp: null, band: null },
      ],
      stats: { participants: 3, ranked: 2, average: 10000, highest: 10000, lowest: 10000 }, distribution: [],
    });
    if (r.hidden || !r.released) throw new Error("expected released");
    expect(r.items.map((i) => i.rank)).toEqual([1, 1, null]);
    expect(r.items[2]).toMatchObject({ isSelf: true, status: "IN_PROGRESS", scoreCenti: null });
    expect(r.stats).toMatchObject({ ranked: 2, median: null });
    expect(readEntry({ status: "WHATEVER" }).status).toBe("NOT_STARTED");
  });
  it("reads staff participation lists", () => {
    expect(readParticipants({ items: [{ displayName: "A", status: "SUBMITTED", percentBp: 5000 }, { displayName: "B", status: "?" }], total: 2 })).toMatchObject({ total: 2, items: [{ status: "SUBMITTED" }, { status: "NOT_STARTED" }] });
    expect(readParticipants(null)).toEqual({ items: [], total: 0 });
  });
});
