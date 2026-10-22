/**
 * Types and pure helpers for exams (docs/PART4_SPEC.md). Everything here only FORMATS or ORGANISES server data:
 * scores, percentages, bands, ranks and deadlines are always computed by the server and rendered as received.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Wire types (mirror the spec; fields the spec leaves open are optional)
// ---------------------------------------------------------------------------------------------------------------------
export type ExamMode = "INDIVIDUAL" | "GROUP";
export type ExamStatus = "DRAFT" | "PUBLISHED" | "CANCELLED";
export type ReviewPolicy = "NONE" | "CORRECTNESS" | "FULL";
export type ReleaseMode = "IMMEDIATE" | "AFTER_CLOSE" | "AT_TIME";
export type LateStart = "CAP_AT_CLOSE" | "FULL_TIME_ONLY";
export type AttemptStatus = "IN_PROGRESS" | "SUBMITTED" | "TIMED_OUT";
import type { FeedbackBand } from "@/lib/bands";
import { EN, type I18n } from "@/lib/format-locale";
import { msg, type TFunction } from "@/lib/i18n/translate";
export { BAND_INFO, BAND_ORDER, bandLabel, type FeedbackBand } from "@/lib/bands";
export type Outcome = "CORRECT" | "INCORRECT" | "UNANSWERED";

export type ExamDraftInput = {
  title: string;
  description: string | null;
  questionIds: string[];
  marks: { perQuestion: number; overrides?: Record<string, number> };
  negativeMarking: { fraction: number };
  durationMinutes: number;
  attemptLimit: number;
  window: { opensAt: string | null; closesAt: string | null };
  lateStart: LateStart;
  lateJoinGroup: boolean;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  reviewPolicy: ReviewPolicy;
  release: { mode: ReleaseMode; at: string | null };
  leaderboardVisible: boolean;
  reminderMinutes: number | null;
};

export type MyAttempts = { used: number; limit: number; inProgressAttemptId: string | null; bestPercentBp: number | null };

export type ExamSummary = {
  id: string;
  title: string;
  description: string | null;
  mode: ExamMode;
  status: ExamStatus;
  group: { id: string; title: string } | null;
  questionCount: number;
  totalMarks: number | null;
  durationMinutes: number | null;
  opensAt: string | null;
  closesAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  myAttempts?: MyAttempts;
};

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

export type SelectedQuestion = {
  id: string;
  stem: string;
  topic?: string | null;
  options?: { id: string; text: string }[];
  correctOptionId?: string | null;
  position?: number;
  marks?: number;
};

export type CanStart = { allowed: boolean; reason?: string; code?: string; resumeAttemptId?: string };

/** Author's view of an exam (draft config, answer key visible to the author only). */
export type ExamManageView = ExamSummary & {
  draft: Partial<ExamDraftInput>;
  questions?: SelectedQuestion[];
  versions?: { version: number; publishedAt: string; snapshotHash?: string }[];
  currentVersion?: number;
  snapshotIntegrity?: "OK" | "MISMATCH" | string;
  canStart?: CanStart;
  attempts?: AttemptSummary[];
};

/** Participant's view (never any questions or keys). */
export type ExamTakeView = ExamSummary & {
  policies?: {
    attemptLimit?: number;
    shuffleQuestions?: boolean;
    shuffleOptions?: boolean;
    negativeMarkingFraction?: number;
    reviewPolicy?: ReviewPolicy;
    release?: { mode: ReleaseMode; at?: string | null; releasesAt?: string | null };
    lateStart?: LateStart;
  };
  canStart: CanStart;
  attempts?: AttemptSummary[];
  attemptLimit?: number;
  negativeMarking?: boolean;
};

export type PreviewIssue = { path: string; message: string; severity: "error" | "warning" };
export type ExamPreview = {
  issues: PreviewIssue[];
  totals: { questionCount: number; totalMarks: number; negativePerWrongRange?: [number, number] | { min: number; max: number } | null };
  questions: { position: number; stem: string; options: { id: string; text: string }[]; correctOptionId: string | null; marks: number; negativeMarks?: number; topic?: string | null }[];
};

export type AttemptQuestion = { id: string; position: number; stem: string; options: { id: string; text: string }[]; marks: number };
export type AttemptAnswerView = { optionId: string | null; marked: boolean; seq: number; savedAt: string };

export type AttemptView = {
  id: string;
  examId: string;
  examTitle: string;
  status: AttemptStatus;
  attemptNo: number;
  startedAt: string;
  deadlineAt: string;
  serverNow: string;
  remainingMs: number;
  totalMarks: number;
  negativeMarking: boolean;
  questions: AttemptQuestion[];
  answers: Record<string, AttemptAnswerView>;
};

export type AttemptSummary = {
  id: string;
  examId: string;
  examTitle: string;
  attemptNo: number;
  status: AttemptStatus;
  startedAt: string;
  finalizedAt: string | null;
  result: { released: boolean; scoreCenti?: number; maxCenti?: number; percentBp?: number; band?: FeedbackBand };
};

export type SaveItem = { questionId: string; optionId: string | null; marked?: boolean; seq: number };
export type SaveResponse = {
  saved: { questionId: string; seq: number; savedAt: string; stale?: boolean }[];
  serverNow: string;
  deadlineAt: string;
  remainingMs: number;
};

export type ResultReview = {
  position: number;
  questionId: string;
  stem: string;
  options: { id: string; text: string }[];
  selectedOptionId: string | null;
  outcome: Outcome;
  awardedCenti: number;
  correctOptionId?: string | null;
  explanation?: string | null;
  shortNote?: string | null;
  sources?: { documentName: string; page: number | null; section: string | null; quote: string }[] | null;
};

export type ResultView = {
  status: AttemptStatus;
  submittedAt: string | null;
  finalizedAt: string | null;
  release: { released: boolean; mode: ReleaseMode; releasesAt: string | null };
  score?: { scoreCenti: number; maxCenti: number; percentBp: number; correct: number; incorrect: number; unanswered: number; band: FeedbackBand; feedback?: string | { label?: string; message?: string } };
  topics?: { topic: string | null; questions: number; correct: number; incorrect: number; unanswered: number; percentBp: number }[];
  review?: ResultReview[];
  retry?: { allowed: boolean; attemptsLeft: number };
  exam?: { id: string; title: string };
};

export type ExamLimitsResponse = { limits?: Record<string, number>; fields?: Record<string, number> };
export type ExamLimits = {
  maxQuestions: number;
  maxDurationMinutes: number;
  maxAttemptLimit: number;
  graceSeconds: number;
  groupDefaultCapacity: number;
  groupMaxCapacity: number;
};
export function resolveExamLimits(r?: ExamLimitsResponse | null): ExamLimits {
  const l = r?.limits ?? {};
  return {
    maxQuestions: l.examMaxQuestions ?? 200,
    maxDurationMinutes: l.examMaxDurationMinutes ?? 360,
    maxAttemptLimit: l.examMaxAttemptLimit ?? 10,
    graceSeconds: l.examGraceSeconds ?? 5,
    groupDefaultCapacity: l.groupDefaultCapacity ?? 30,
    groupMaxCapacity: l.groupMaxCapacity ?? 500,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Formatting (centi-marks, basis points, durations, local time <-> UTC ISO)
// ---------------------------------------------------------------------------------------------------------------------
/** 250 -> "2.5", 300 -> "3", 25 -> "0.25". Pure formatting of a server integer. */
export function formatCenti(centi: number, i18n: I18n = EN): string {
  if (i18n.format.locale !== "en") return i18n.format.centi(centi);
  const sign = centi < 0 ? "-" : "";
  const abs = Math.abs(Math.round(centi));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  if (frac === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}
export const formatMarks = (marks: number, i18n: I18n = EN): string => (i18n.format.locale !== "en" ? i18n.format.marks(marks) : Number.isInteger(marks) ? String(marks) : String(Math.round(marks * 100) / 100));
/** 8750 -> "87.50%"; 10000 -> "100.00%". */
export function formatPercentBp(bp: number, i18n: I18n = EN): string {
  if (i18n.format.locale !== "en") return i18n.format.percentBp(bp);
  const whole = Math.floor(bp / 100);
  return `${whole}.${String(bp % 100).padStart(2, "0")}%`;
}
export function formatDuration(minutes: number, i18n: I18n = EN): string {
  const { t } = i18n;
  if (minutes < 60) return t("{minutes} min", { minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? t("{hours} h {minutes} min", { hours: h, minutes: m }) : t("{hours} h", { hours: h });
}
/** Countdown text: "9:05" or "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
/** "2026-10-23T14:30:00.000Z" -> "2026-10-23T20:30" in the browser's zone (for <input type=datetime-local>). */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** The inverse: a local date-time string becomes a UTC ISO string (null when empty or invalid). */
export function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function formatDateTime(iso: string | null | undefined, i18n: I18n = EN): string {
  return i18n.format.dateTime(iso);
}

// ---------------------------------------------------------------------------------------------------------------------
// Bands: labels and wording only. The band itself always comes from the server.
// ---------------------------------------------------------------------------------------------------------------------
/** The server may send feedback as text or as {label, message}. */
export const feedbackText = (f: string | { label?: string; message?: string } | undefined | null): string | null => (typeof f === "string" ? f : f?.message ?? null);

export const REVIEW_POLICY_TEXT: Record<ReviewPolicy, { label: string; hint: string }> = {
  NONE: { label: msg("Score only"), hint: msg("Participants see their score and nothing about individual questions.") },
  CORRECTNESS: { label: msg("Right / wrong"), hint: msg("Participants see which questions they got right or wrong, but not the correct answers.") },
  FULL: { label: msg("Full review"), hint: msg("Participants also see the correct answer, explanation and notes for every question.") },
};
export const RELEASE_TEXT: Record<ReleaseMode, { label: string; hint: string }> = {
  IMMEDIATE: { label: msg("Right after submitting"), hint: msg("Each participant sees their result as soon as they submit.") },
  AFTER_CLOSE: { label: msg("When the exam closes"), hint: msg("Everyone sees results at the same time, after the closing time. Needs a closing time.") },
  AT_TIME: { label: msg("At a set time"), hint: msg("Results are hidden until the time you choose (not before the closing time, if there is one).") },
};
export const LATE_START_TEXT: Record<LateStart, { label: string; hint: string }> = {
  CAP_AT_CLOSE: { label: msg("Late starters get less time"), hint: msg("You can start any time before the closing time, but the clock never runs past it.") },
  FULL_TIME_ONLY: { label: msg("Everyone gets the full time"), hint: msg("Starting is blocked once there isn't a full duration left before the closing time.") },
};

// ---------------------------------------------------------------------------------------------------------------------
// Draft defaults and advisory validation (the server is the authority and validates again)
// ---------------------------------------------------------------------------------------------------------------------
export const DEFAULT_DRAFT: ExamDraftInput = {
  title: "",
  description: null,
  questionIds: [],
  marks: { perQuestion: 1 },
  negativeMarking: { fraction: 0 },
  durationMinutes: 30,
  attemptLimit: 1,
  window: { opensAt: null, closesAt: null },
  lateStart: "CAP_AT_CLOSE",
  lateJoinGroup: true,
  shuffleQuestions: false,
  shuffleOptions: false,
  reviewPolicy: "FULL",
  release: { mode: "IMMEDIATE", at: null },
  leaderboardVisible: true,
  reminderMinutes: null,
};

/** Fills gaps (a brand-new draft may be `{}`) so the form always has a complete object. */
export function normalizeDraft(raw: Partial<ExamDraftInput> | null | undefined, base: { title?: string; description?: string | null } = {}): ExamDraftInput {
  const d = raw ?? {};
  return {
    ...DEFAULT_DRAFT,
    ...d,
    title: d.title ?? base.title ?? "",
    description: d.description ?? base.description ?? null,
    questionIds: d.questionIds ?? [],
    marks: { perQuestion: d.marks?.perQuestion ?? 1, ...(d.marks?.overrides && Object.keys(d.marks.overrides).length ? { overrides: d.marks.overrides } : {}) },
    negativeMarking: { fraction: d.negativeMarking?.fraction ?? 0 },
    window: { opensAt: d.window?.opensAt ?? null, closesAt: d.window?.closesAt ?? null },
    release: { mode: d.release?.mode ?? "IMMEDIATE", at: d.release?.at ?? null },
    reminderMinutes: d.reminderMinutes ?? null,
  };
}

/** What gets sent to PUT /draft: only finite numbers, overrides limited to selected questions. */
export function draftPayload(d: ExamDraftInput): ExamDraftInput {
  const selected = new Set(d.questionIds);
  const overrides = Object.fromEntries(Object.entries(d.marks.overrides ?? {}).filter(([id, m]) => selected.has(id) && Number.isFinite(m)));
  return {
    ...d,
    title: d.title.trim(),
    description: d.description?.trim() ? d.description.trim() : null,
    marks: { perQuestion: d.marks.perQuestion, ...(Object.keys(overrides).length ? { overrides } : {}) },
  };
}
/** True when a draft can be sent to the server without tripping over half-typed numbers. */
export function draftIsSendable(d: ExamDraftInput): boolean {
  const nums = [d.marks.perQuestion, d.negativeMarking.fraction, d.durationMinutes, d.attemptLimit, ...(d.reminderMinutes === null ? [] : [d.reminderMinutes])];
  return nums.every((n) => Number.isFinite(n)) && d.title.trim().length > 0;
}

export type DraftErrors = Record<string, string>;
export function validateDraftLocal(d: ExamDraftInput, limits: ExamLimits, mode: ExamMode, t: TFunction = EN.t): DraftErrors {
  const e: DraftErrors = {};
  if (!d.title.trim()) e.title = t("Give the exam a title.");
  if (d.title.length > 120) e.title = t("Use at most 120 characters.");
  if ((d.description ?? "").length > 1000) e.description = t("Use at most 1000 characters.");
  if (d.questionIds.length === 0) e.questionIds = t("Add at least one question.");
  if (d.questionIds.length > limits.maxQuestions) e.questionIds = t("An exam can have up to {max} questions.", { max: limits.maxQuestions });
  if (!Number.isFinite(d.marks.perQuestion) || d.marks.perQuestion < 0.25 || d.marks.perQuestion > 100) e["marks.perQuestion"] = t("Marks per question must be between 0.25 and 100.");
  for (const [id, m] of Object.entries(d.marks.overrides ?? {})) if (!Number.isFinite(m) || m < 0.25 || m > 100) e[`marks.overrides.${id}`] = t("Between 0.25 and 100.");
  if (!Number.isFinite(d.negativeMarking.fraction) || d.negativeMarking.fraction < 0 || d.negativeMarking.fraction > 1) e["negativeMarking.fraction"] = t("Use a fraction between 0 and 1.");
  if (!Number.isInteger(d.durationMinutes) || d.durationMinutes < 1 || d.durationMinutes > limits.maxDurationMinutes) e.durationMinutes = t("Between 1 and {max} minutes.", { max: limits.maxDurationMinutes });
  if (!Number.isInteger(d.attemptLimit) || d.attemptLimit < 1 || d.attemptLimit > limits.maxAttemptLimit) e.attemptLimit = t("Between 1 and {max}.", { max: limits.maxAttemptLimit });
  const { opensAt, closesAt } = d.window;
  if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) e["window.closesAt"] = t("The closing time must be after the opening time.");
  if (d.release.mode === "AFTER_CLOSE" && !closesAt) e["release.mode"] = t("Releasing when the exam closes needs a closing time.");
  if (d.release.mode === "AT_TIME") {
    if (!d.release.at) e["release.at"] = t("Choose when results are released.");
    else if (closesAt && new Date(d.release.at) < new Date(closesAt)) e["release.at"] = t("Results can't be released before the exam closes.");
  }
  if (d.lateStart === "FULL_TIME_ONLY" && closesAt) {
    const start = opensAt ? new Date(opensAt).getTime() : null;
    if (start !== null && new Date(closesAt).getTime() - start < d.durationMinutes * 60_000) e["window.closesAt"] = t("The window is shorter than the exam duration, so nobody could start.");
  }
  if (d.reminderMinutes !== null && (!Number.isInteger(d.reminderMinutes) || d.reminderMinutes < 1 || d.reminderMinutes > 10080)) e.reminderMinutes = t("Between 1 minute and 7 days (10080).");
  if (d.reminderMinutes !== null && !opensAt) e.reminderMinutes = t("A reminder needs an opening time.");
  void mode;
  return e;
}

/** Maps server `details.fields` paths (e.g. "questionIds.3", "window.closesAt") onto the wizard step they belong to. */
export function stepForField(path: string): "details" | "questions" | "rules" {
  if (path.startsWith("title") || path.startsWith("description")) return "details";
  if (path.startsWith("questionIds") || path.startsWith("questions")) return "questions";
  return "rules";
}

/** Server messages are keyed by dotted path; match the most specific one. */
export function fieldMessage(fields: Record<string, string>, key: string): string | undefined {
  if (fields[key]) return fields[key];
  const prefix = `${key}.`;
  const hit = Object.keys(fields).find((k) => k.startsWith(prefix));
  return hit ? fields[hit] : undefined;
}

export function moveId(ids: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return ids;
  const next = ids.slice();
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it!);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------------
// Countdown: derived only from the server's `remainingMs` plus elapsed MONOTONIC time (performance.now()).
// The device's wall clock (Date.now / new Date) is never compared with a server timestamp.
// ---------------------------------------------------------------------------------------------------------------------
export type ClockSync = { remainingMs: number; atMono: number };
export const syncClock = (remainingMs: number, monoNow: number): ClockSync => ({ remainingMs: Math.max(0, remainingMs), atMono: monoNow });
export const remainingFromSync = (s: ClockSync, monoNow: number): number => Math.max(0, s.remainingMs - Math.max(0, monoNow - s.atMono));

/** Milestones announced to screen readers (never every second). */
export const MILESTONES = [600_000, 300_000, 60_000, 30_000, 10_000] as const;
export function crossedMilestone(prevMs: number, nowMs: number): number | null {
  for (const m of MILESTONES) if (prevMs > m && nowMs <= m) return m;
  return null;
}
export function milestoneText(ms: number, t: TFunction = EN.t): string {
  if (ms >= 60_000) return t("{count, plural, one {# minute remaining} other {# minutes remaining}}", { count: ms / 60_000 });
  return t("{count, plural, one {# second remaining} other {# seconds remaining}}", { count: ms / 1000 });
}
export type TimerTone = "normal" | "warning" | "danger";
export const timerTone = (ms: number): TimerTone => (ms <= 60_000 ? "danger" : ms <= 300_000 ? "warning" : "normal");

// ---------------------------------------------------------------------------------------------------------------------
// Answer state and navigation helpers
// ---------------------------------------------------------------------------------------------------------------------
export type LocalAnswer = { optionId: string | null; marked: boolean; seq: number; confirmedSeq: number; savedAt: string | null };
export type NavState = "current" | "answered" | "marked" | "unanswered" | "answered-marked";

export function navState(a: LocalAnswer | undefined, isCurrent: boolean): NavState {
  if (isCurrent) return "current";
  const answered = Boolean(a?.optionId);
  if (answered && a?.marked) return "answered-marked";
  if (a?.marked) return "marked";
  return answered ? "answered" : "unanswered";
}
export const countAnswered = (qs: { id: string }[], m: Map<string, LocalAnswer>): number => qs.filter((q) => m.get(q.id)?.optionId).length;
export const countMarked = (qs: { id: string }[], m: Map<string, LocalAnswer>): number => qs.filter((q) => m.get(q.id)?.marked).length;
export const optionLetter = (i: number): string => String.fromCharCode(65 + i);

// ---------------------------------------------------------------------------------------------------------------------
// Autosave queue: pure logic with injected transport and timers (unit-tested; React only subscribes).
// "Saved" exists ONLY for a question whose latest local `seq` was confirmed by a server response.
// ---------------------------------------------------------------------------------------------------------------------
export type SaveStatus = "idle" | "saving" | "offline" | "expired" | "error";

export type SendResult = SaveResponse;
export class SaveFailure extends Error {
  constructor(public readonly kind: "network" | "expired" | "rejected", message: string) {
    super(message);
  }
}

export type QueueOptions = {
  initial: Record<string, AttemptAnswerView>;
  send: (items: SaveItem[]) => Promise<SendResult>;
  /** Called with every server response (re-sync the countdown from remainingMs). */
  onResponse?: (r: SendResult) => void;
  onChange?: () => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  debounceMs?: number;
  maxBatch?: number;
};

export const backoffDelay = (failures: number, jitter = 0.5): number => Math.round(Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1)) * (0.75 + 0.5 * jitter));

export class AutosaveQueue {
  readonly answers = new Map<string, LocalAnswer>();
  status: SaveStatus = "idle";
  failures = 0;
  lastError: string | null = null;
  /** Set when the server reported a stale item (another tab/device saved something newer): the caller should re-read the attempt. */
  needsResync = false;
  private inFlight = false;
  private cancelTimer: (() => void) | null = null;
  private readonly opts: Required<Pick<QueueOptions, "debounceMs" | "maxBatch">> & QueueOptions;

  constructor(opts: QueueOptions) {
    this.opts = { debounceMs: 400, maxBatch: 50, ...opts };
    for (const [id, a] of Object.entries(opts.initial)) this.answers.set(id, { optionId: a.optionId, marked: a.marked, seq: a.seq, confirmedSeq: a.seq, savedAt: a.savedAt });
  }

  private emit() {
    this.opts.onChange?.();
  }
  private schedule(fn: () => void, ms: number) {
    this.cancelTimer?.();
    const s = this.opts.schedule ?? ((f, t) => { const h = setTimeout(f, t); return () => clearTimeout(h); });
    this.cancelTimer = s(fn, ms);
  }

  /** Local edit: bumps this question's seq. Not "saved" until a response confirms it. */
  change(questionId: string, patch: { optionId?: string | null; marked?: boolean }) {
    if (this.status === "expired") return;
    const cur = this.answers.get(questionId) ?? { optionId: null, marked: false, seq: 0, confirmedSeq: 0, savedAt: null };
    this.answers.set(questionId, {
      ...cur,
      optionId: patch.optionId !== undefined ? patch.optionId : cur.optionId,
      marked: patch.marked !== undefined ? patch.marked : cur.marked,
      seq: cur.seq + 1,
    });
    this.emit();
    if (this.status !== "offline") this.schedule(() => void this.flush(), this.opts.debounceMs);
  }

  pendingItems(): SaveItem[] {
    const out: SaveItem[] = [];
    for (const [questionId, a] of this.answers) if (a.seq > a.confirmedSeq) out.push({ questionId, optionId: a.optionId, marked: a.marked, seq: a.seq });
    return out;
  }
  get pendingCount(): number {
    return this.pendingItems().length;
  }
  isSaved(questionId: string): boolean {
    const a = this.answers.get(questionId);
    return !a || a.seq === a.confirmedSeq;
  }

  /** Sends everything unconfirmed (in batches). Resolves when nothing is pending or a failure stops the loop. */
  async flush(): Promise<void> {
    if (this.inFlight || this.status === "expired") return;
    this.cancelTimer?.();
    this.inFlight = true;
    try {
      for (;;) {
        const batch = this.pendingItems().slice(0, this.opts.maxBatch);
        if (!batch.length) {
          if (this.status === "saving" || this.status === "offline" || this.status === "error") this.status = "idle";
          this.failures = 0;
          this.lastError = null;
          this.emit();
          return;
        }
        this.status = "saving";
        this.emit();
        let res: SendResult;
        try {
          res = await this.opts.send(batch);
        } catch (err) {
          this.handleFailure(err);
          return;
        }
        this.apply(res);
        this.opts.onResponse?.(res);
        this.failures = 0;
      }
    } finally {
      this.inFlight = false;
    }
  }

  private handleFailure(err: unknown) {
    const kind = err instanceof SaveFailure ? err.kind : "network";
    if (kind === "expired") {
      this.status = "expired";
      this.lastError = null;
    } else if (kind === "rejected") {
      this.status = "error";
      this.lastError = err instanceof Error ? err.message : msg("The server didn't accept the save.");
    } else {
      this.status = "offline";
      this.failures += 1;
      this.lastError = msg("Couldn't reach the server.");
      this.schedule(() => void this.flush(), backoffDelay(this.failures));
    }
    this.emit();
  }

  /** Records which items the server confirmed. A stale item counts as handled (the server holds something newer) and requests a re-sync. */
  apply(res: SendResult) {
    for (const s of res.saved) {
      const a = this.answers.get(s.questionId);
      if (!a) continue;
      if (s.seq > a.confirmedSeq) this.answers.set(s.questionId, { ...a, confirmedSeq: s.seq, savedAt: s.stale ? a.savedAt : s.savedAt });
      if (s.stale) this.needsResync = true;
    }
    this.emit();
  }

  /** Merges a fresh `GET /api/attempts/:id` after a reconnect: server answers with a higher seq win; local unconfirmed edits (higher seq) are kept. */
  mergeServer(server: Record<string, AttemptAnswerView>) {
    for (const [id, s] of Object.entries(server)) {
      const a = this.answers.get(id);
      if (!a || s.seq > a.seq) this.answers.set(id, { optionId: s.optionId, marked: s.marked, seq: s.seq, confirmedSeq: s.seq, savedAt: s.savedAt });
      else if (s.seq > a.confirmedSeq) this.answers.set(id, { ...a, confirmedSeq: s.seq, savedAt: s.savedAt });
    }
    this.needsResync = false;
    this.emit();
  }

  markExpired() {
    this.status = "expired";
    this.cancelTimer?.();
    this.emit();
  }
  /** Retry immediately (the "Retry now" button, or the browser coming back online). */
  retryNow() {
    if (this.status === "expired") return Promise.resolve();
    this.cancelTimer?.();
    return this.flush();
  }
  dispose() {
    this.cancelTimer?.();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------
export function describeExamError(code: string, message: string, t: TFunction = EN.t): { title: string; message: string } {
  const tm = (m: string) => (m ? t(m) : m);
  switch (code) {
    case "EXAM_NOT_OPEN": return { title: t("This exam hasn't opened yet"), message: tm(message) || t("Come back when the exam opens.") };
    case "EXAM_CLOSED": return { title: t("This exam is closed"), message: tm(message) || t("The exam is no longer accepting new attempts.") };
    case "ATTEMPT_LIMIT": return { title: t("No attempts left"), message: tm(message) || t("You've used all your attempts for this exam.") };
    case "ATTEMPT_EXPIRED": return { title: t("Time is up"), message: tm(message) || t("This attempt has ended. Answers saved before the deadline were kept.") };
    case "NOT_ELIGIBLE": return { title: t("You can't take this exam"), message: tm(message) || t("You're not eligible for this exam.") };
    case "RATE_LIMITED": return { title: t("Slow down a little"), message: t("Too many requests. Wait a moment and try again.") };
    case "CONFLICT": return { title: t("That changed in the meantime"), message: tm(message) || t("Reload and try again.") };
    case "NETWORK": return { title: t("Connection problem"), message: tm(message) };
    default: return { title: t("Something went wrong"), message: tm(message) || t("Please try again.") };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules in plain words (used by the preview and by the participant's view)
// ---------------------------------------------------------------------------------------------------------------------
export type RuleFacts = {
  durationMinutes: number | null;
  questionCount: number | null;
  totalMarks: number | null;
  attemptLimit: number | null;
  opensAt: string | null;
  closesAt: string | null;
  negativeFraction: number | null;
  shuffleQuestions: boolean | null;
  shuffleOptions: boolean | null;
  reviewPolicy: ReviewPolicy | null;
  release: { mode: ReleaseMode; at: string | null } | null;
  lateStart: LateStart | null;
};

export function factsFromDraft(d: ExamDraftInput, totals?: { questionCount?: number; totalMarks?: number }): RuleFacts {
  return {
    durationMinutes: d.durationMinutes, questionCount: totals?.questionCount ?? d.questionIds.length, totalMarks: totals?.totalMarks ?? null, attemptLimit: d.attemptLimit,
    opensAt: d.window.opensAt, closesAt: d.window.closesAt, negativeFraction: d.negativeMarking.fraction, shuffleQuestions: d.shuffleQuestions, shuffleOptions: d.shuffleOptions,
    reviewPolicy: d.reviewPolicy, release: d.release, lateStart: d.lateStart,
  };
}
export function factsFromTakeView(e: ExamTakeView): RuleFacts {
  const p = e.policies ?? {};
  return {
    durationMinutes: e.durationMinutes, questionCount: e.questionCount, totalMarks: e.totalMarks, attemptLimit: p.attemptLimit ?? e.myAttempts?.limit ?? null, opensAt: e.opensAt, closesAt: e.closesAt,
    negativeFraction: p.negativeMarkingFraction ?? null, shuffleQuestions: p.shuffleQuestions ?? null, shuffleOptions: p.shuffleOptions ?? null, reviewPolicy: p.reviewPolicy ?? null,
    release: p.release ? { mode: p.release.mode, at: p.release.at ?? p.release.releasesAt ?? null } : null, lateStart: p.lateStart ?? null,
  };
}

export function rulesInWords(f: RuleFacts, i18n: I18n = EN): string[] {
  const { t, format } = i18n;
  const out: string[] = [];
  if (f.questionCount !== null) out.push(f.totalMarks !== null ? t("{count, plural, one {# question} other {# questions}}, {marks} marks in total.", { count: f.questionCount, marks: formatMarks(f.totalMarks, i18n) }) : t("{count, plural, one {# question} other {# questions}}.", { count: f.questionCount }));
  if (f.durationMinutes !== null) out.push(t("You get {duration} once you start. The clock is kept by the server and keeps running if you close the page.", { duration: formatDuration(f.durationMinutes, i18n) }));
  if (f.attemptLimit !== null) out.push(f.attemptLimit === 1 ? t("One attempt.") : t("Up to {count} attempts; your best result counts for rankings.", { count: f.attemptLimit }));
  if (f.opensAt) out.push(t("Opens {when}.", { when: format.dateTime(f.opensAt) }));
  if (f.closesAt) {
    const when = format.dateTime(f.closesAt);
    out.push(f.lateStart === "CAP_AT_CLOSE" ? t("Closes {when} — if you start late, your time is cut short at closing.", { when }) : f.lateStart === "FULL_TIME_ONLY" ? t("Closes {when} — you can only start while a full duration is still left.", { when }) : t("Closes {when}.", { when }));
  }
  if (f.negativeFraction !== null) out.push(f.negativeFraction > 0 ? t("Wrong answers lose {percent}% of the question's marks. Unanswered questions score 0.", { percent: formatMarks(Math.round(f.negativeFraction * 10000) / 100, i18n) }) : t("No negative marking: a wrong answer scores 0."));
  if (f.shuffleQuestions || f.shuffleOptions) out.push(f.shuffleQuestions && f.shuffleOptions ? t("Questions and answer options appear in a different order for each person.") : f.shuffleQuestions ? t("Questions appear in a different order for each person.") : t("Answer options appear in a different order for each person."));
  if (f.reviewPolicy) out.push(t(REVIEW_POLICY_TEXT[f.reviewPolicy].hint));
  if (f.release) out.push(f.release.mode === "IMMEDIATE" ? t("Results appear as soon as you submit.") : f.release.mode === "AFTER_CLOSE" ? t("Results are released for everyone after the exam closes.") : f.release.at ? t("Results are released {when}.", { when: format.dateTime(f.release.at) }) : t("Results are released at a set time."));
  return out;
}
