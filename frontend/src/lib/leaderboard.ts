import { PARTICIPATION_LABEL, type ExamParticipation, type MyExamStatus } from "@/lib/groups";

/** Types and pure helpers for the group-exam leaderboard (docs/PART4_SPEC.md §10). Ranks, scores and distribution are computed by the server; nothing here ranks or scores. */

import { BAND_LABEL, BAND_ORDER, type FeedbackBand } from "@/lib/bands";
import { EN, type I18n } from "@/lib/format-locale";
import { msg } from "@/lib/i18n/translate";
export { BAND_LABEL, type FeedbackBand };

export type DistributionBandId = "BELOW_60" | "60_70" | "70_80" | "80_90" | "90_100";
export type DistributionBand = { band: DistributionBandId; label: string; count: number };
export type LeaderboardEntry = {
  entryId: string; rank: number | null; displayName: string; isSelf: boolean; status: ExamParticipation;
  scoreCenti: number | null; maxCenti: number; percentBp: number | null; band: FeedbackBand | null; submittedAt: string | null;
};
export type LeaderboardStats = { participants: number; ranked: number; average: number | null; highest: number | null; lowest: number | null; median: number | null };
export type ParticipationCounts = { total: number; submitted: number; timedOut: number; inProgress: number; notStarted: number; missed: number };

export type LeaderboardNotReleased = { released: false; hidden: false; releasesAt: string | null; participants: ParticipationCounts; myStatus: MyExamStatus | null };
/** The author chose not to show the leaderboard to members. */
export type LeaderboardHidden = { released: boolean; hidden: true; releasesAt: string | null };
export type LeaderboardReleased = {
  released: true; hidden: false; policy: string; items: LeaderboardEntry[]; total: number; page: number; pageSize: number; stats: LeaderboardStats; distribution: DistributionBand[]; myEntry: LeaderboardEntry | null;
};
export type LeaderboardResponse = LeaderboardNotReleased | LeaderboardReleased | LeaderboardHidden;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const s = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const STATUSES: ExamParticipation[] = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "TIMED_OUT", "MISSED"];
const STATUSES_ALL: MyExamStatus[] = [...STATUSES, "AUTHOR", "NOT_ELIGIBLE"];
const BANDS = BAND_ORDER;

export function readEntry(raw: unknown): LeaderboardEntry {
  const e = isRec(raw) ? raw : {};
  return {
    entryId: s(e.entryId), rank: n(e.rank), displayName: s(e.displayName, "Participant"), isSelf: e.isSelf === true,
    status: STATUSES.includes(e.status as ExamParticipation) ? (e.status as ExamParticipation) : "NOT_STARTED",
    scoreCenti: n(e.scoreCenti), maxCenti: n(e.maxCenti) ?? 0, percentBp: n(e.percentBp), band: BANDS.includes(e.band as FeedbackBand) ? (e.band as FeedbackBand) : null,
    submittedAt: typeof e.submittedAt === "string" ? e.submittedAt : null,
  };
}

export function readLeaderboard(raw: unknown): LeaderboardResponse {
  const r = isRec(raw) ? raw : {};
  const releasesAt = typeof r.releasesAt === "string" ? r.releasesAt : null;
  if (r.hidden === true) return { released: r.released === true, hidden: true, releasesAt };
  if (r.released !== true) {
    const p = isRec(r.participants) ? r.participants : {};
    return {
      released: false, hidden: false, releasesAt, myStatus: STATUSES_ALL.includes(r.myStatus as MyExamStatus) ? (r.myStatus as MyExamStatus) : null,
      participants: { total: n(p.total) ?? 0, submitted: n(p.submitted) ?? 0, timedOut: n(p.timedOut) ?? 0, inProgress: n(p.inProgress) ?? 0, notStarted: n(p.notStarted) ?? 0, missed: n(p.missed) ?? 0 },
    };
  }
  const st = isRec(r.stats) ? r.stats : {};
  const items = Array.isArray(r.items) ? r.items.map(readEntry) : [];
  return {
    released: true, hidden: false, policy: s(r.policy), items, total: n(r.total) ?? items.length, page: n(r.page) ?? 1, pageSize: n(r.pageSize) ?? (items.length || 1),
    stats: { participants: n(st.participants) ?? 0, ranked: n(st.ranked) ?? 0, average: n(st.average), highest: n(st.highest), lowest: n(st.lowest), median: n(st.median) },
    distribution: readDistribution(r.distribution), myEntry: isRec(r.myEntry) ? readEntry(r.myEntry) : null,
  };
}

const DIST_ORDER: DistributionBandId[] = ["BELOW_60", "60_70", "70_80", "80_90", "90_100"];
const DIST_LABEL: Record<DistributionBandId, string> = { BELOW_60: msg("Below 60%"), "60_70": msg("60% – below 70%"), "70_80": msg("70% – below 80%"), "80_90": msg("80% – below 90%"), "90_100": msg("90% – 100%") };
/** Chart rows for the five percentage bands, in the fixed order, using the server's counts (missing bands show 0). */
export function readDistribution(raw: unknown): DistributionBand[] {
  const list = Array.isArray(raw) ? raw.filter(isRec) : [];
  return DIST_ORDER.map((band) => {
    const row = list.find((d) => d.band === band);
    return { band, label: s(row?.label) || DIST_LABEL[band], count: n(row?.count) ?? 0 };
  });
}
export const distributionTotal = (d: DistributionBand[]) => d.reduce((a, b) => a + b.count, 0);
/** Short axis labels, in percent ("<60", "60–70" …), so five bars fit on a phone. */
export const SHORT_BAND: Record<DistributionBandId, string> = { BELOW_60: "<60", "60_70": "60–70", "70_80": "70–80", "80_90": "80–90", "90_100": "90–100" };

// ----------------------------------------------------------------------------------------------- formatting
export function formatPercent(percentBp: number | null | undefined, i18n: I18n = EN): string {
  return typeof percentBp === "number" ? i18n.format.percentBp(percentBp) : "—";
}
export function formatMarks(centi: number | null | undefined, i18n: I18n = EN): string {
  if (typeof centi !== "number") return "—";
  const v = centi / 100;
  if (i18n.format.locale !== "en") return i18n.format.number(v, { maximumFractionDigits: 2 });
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "");
}
export function formatScore(e: Pick<LeaderboardEntry, "scoreCenti" | "maxCenti">, i18n: I18n = EN): string {
  return e.scoreCenti === null ? "—" : `${formatMarks(e.scoreCenti, i18n)} / ${formatMarks(e.maxCenti, i18n)}`;
}

/** Rank exactly as the server sent it (ties show the same number; the next one skips). Unranked rows show an en dash. */
export const rankText = (rank: number | null, i18n: I18n = EN) => (rank === null ? "—" : i18n.format.locale === "en" ? String(rank) : i18n.format.number(rank));
export const isMedalRank = (rank: number | null) => rank !== null && rank >= 1 && rank <= 3;
export const rankAriaLabel = (rank: number | null, t: I18n["t"] = EN.t) => (rank === null ? t("Not ranked") : t("Rank {n}", { n: rank }));

export type StatusChip = { label: string; tone: "success" | "warning" | "muted" | "info" | "danger"; icon: "check" | "clock" | "play" | "minus" | "x" };
export function statusChip(status: MyExamStatus): StatusChip {
  switch (status) {
    case "AUTHOR": return { label: PARTICIPATION_LABEL.AUTHOR, tone: "info", icon: "check" };
    case "NOT_ELIGIBLE": return { label: PARTICIPATION_LABEL.NOT_ELIGIBLE, tone: "muted", icon: "minus" };
    case "SUBMITTED": return { label: PARTICIPATION_LABEL.SUBMITTED, tone: "success", icon: "check" };
    case "TIMED_OUT": return { label: PARTICIPATION_LABEL.TIMED_OUT, tone: "warning", icon: "clock" };
    case "IN_PROGRESS": return { label: PARTICIPATION_LABEL.IN_PROGRESS, tone: "info", icon: "play" };
    case "MISSED": return { label: PARTICIPATION_LABEL.MISSED, tone: "danger", icon: "x" };
    default: return { label: PARTICIPATION_LABEL.NOT_STARTED, tone: "muted", icon: "minus" };
  }
}
/** A finalized attempt that scored exactly zero is different from "not started" / "in progress": it has a rank and a score. */
export const isFinalized = (e: Pick<LeaderboardEntry, "status">) => e.status === "SUBMITTED" || e.status === "TIMED_OUT";
export const isZeroScore = (e: Pick<LeaderboardEntry, "status" | "scoreCenti">) => isFinalized(e) && e.scoreCenti === 0;

/** Text alternative to the chart (for the table and the figure's aria-label). */
export function distributionSummary(d: DistributionBand[], { t, format }: I18n = EN): string {
  const total = distributionTotal(d);
  if (total === 0) return t("No scores yet.");
  return `${t("Score distribution of {count, plural, one {# ranked participant} other {# ranked participants}}", { count: total })}: ${d.map((b) => `${t(b.label)}: ${format.number(b.count)}`).join("; ")}.`;
}

export type ParticipantRow = { displayName: string; status: ExamParticipation; scoreCenti: number | null; maxCenti: number | null; percentBp: number | null; isSelf: boolean };
export function readParticipants(raw: unknown): { items: ParticipantRow[]; total: number } {
  const r = isRec(raw) ? raw : {};
  const items = (Array.isArray(r.items) ? r.items : []).map((x): ParticipantRow => {
    const e = isRec(x) ? x : {};
    return {
      displayName: s(e.displayName, "Participant"), status: STATUSES.includes(e.status as ExamParticipation) ? (e.status as ExamParticipation) : "NOT_STARTED",
      scoreCenti: n(e.scoreCenti), maxCenti: n(e.maxCenti), percentBp: n(e.percentBp), isSelf: e.isSelf === true,
    };
  });
  return { items, total: n(r.total) ?? items.length };
}
