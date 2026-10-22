import type { ApiError } from "@/lib/api";

/** Types and pure helpers for study groups (docs/PART4_SPEC.md §11). The server is the authority; role helpers here only decide what to *show*. */

export type GroupRole = "OWNER" | "ADMIN" | "MEMBER";
export const ROLE_LABEL: Record<GroupRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member" };

export type ExamParticipation = "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "TIMED_OUT" | "MISSED";
/** What the group exam list reports for the caller: a participation status, or a reason they can't take it. */
export type MyExamStatus = ExamParticipation | "AUTHOR" | "NOT_ELIGIBLE";

export type GroupSummary = {
  id: string; title: string; description: string | null; role: GroupRole; memberCount: number; capacity: number;
  /** Optional hints; rendered only when the API sends them. */
  nextExam?: { id: string; title: string; opensAt: string | null; closesAt: string | null } | null;
  lastExam?: { id: string; title: string; publishedAt: string | null } | null;
};

export type GroupDetail = {
  id: string; title: string; description: string | null; capacity: number; memberCount: number; createdAt: string | null; ownerName: string | null;
  role: GroupRole; showNameOnLeaderboard: boolean;
};

export type MemberView = { memberId: string; displayName: string; role: GroupRole; joinedAt: string; isSelf: boolean };
export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };

export type InviteStatus = "ACTIVE" | "EXPIRED" | "REVOKED" | "USED_UP";
export type InviteView = {
  id: string; status: InviteStatus; expiresAt: string; maxUses: number; useCount: number; codeHint: string; forEmail: boolean; createdAt: string | null;
};
export type CreatedInvite = { invite: InviteView; code: string; link: string };

export type GroupExamRow = {
  id: string; title: string; status: "PUBLISHED" | "CANCELLED" | "DRAFT"; questionCount: number | null; totalMarks: number | null; durationMinutes: number | null;
  opensAt: string | null; closesAt: string | null; publishedAt: string | null; participation: MyExamStatus | null; mine: boolean;
  authorName: string | null; leaderboardVisible: boolean;
  /** null = no result yet; released:false = finished but not released; released:true = score visible to me. */
  result: { released: false } | { released: true; percentBp: number | null } | null;
};

export type GroupLimits = {
  groupMaxCapacity: number; groupDefaultCapacity: number; inviteDefaultTtlHours: number; inviteMaxTtlHours: number; inviteMaxUses: number;
};
export const DEFAULT_GROUP_LIMITS: GroupLimits = { groupMaxCapacity: 500, groupDefaultCapacity: 30, inviteDefaultTtlHours: 168, inviteMaxTtlHours: 720, inviteMaxUses: 500 };
export const GROUP_FIELD = { title: 80, description: 500, email: 254 } as const;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
/** Reads the (camel-cased) limits from `GET /api/exams/limits`, falling back to the documented defaults for anything missing. */
export function resolveGroupLimits(raw: { limits?: Record<string, unknown> } | null | undefined): GroupLimits {
  const l = raw?.limits ?? {};
  return {
    groupMaxCapacity: num(l.groupMaxCapacity, DEFAULT_GROUP_LIMITS.groupMaxCapacity),
    groupDefaultCapacity: num(l.groupDefaultCapacity, DEFAULT_GROUP_LIMITS.groupDefaultCapacity),
    inviteDefaultTtlHours: num(l.inviteDefaultTtlHours, DEFAULT_GROUP_LIMITS.inviteDefaultTtlHours),
    inviteMaxTtlHours: num(l.inviteMaxTtlHours, DEFAULT_GROUP_LIMITS.inviteMaxTtlHours),
    inviteMaxUses: num(l.inviteMaxUses, DEFAULT_GROUP_LIMITS.inviteMaxUses),
  };
}

// ----------------------------------------------------------------------------------------------- tolerant response readers
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const nullableStr = (v: unknown) => (typeof v === "string" ? v : null);
const ROLES: GroupRole[] = ["OWNER", "ADMIN", "MEMBER"];
const asRole = (v: unknown): GroupRole => (ROLES.includes(v as GroupRole) ? (v as GroupRole) : "MEMBER");

export function readGroupSummary(raw: unknown): GroupSummary {
  const g = isRec(raw) ? raw : {};
  const me = isRec(g.me) ? g.me : {};
  const exam = (v: unknown) => (isRec(v) && typeof v.id === "string" ? v : null);
  const next = exam(g.nextExam);
  const last = exam(g.lastExam);
  return {
    id: str(g.id), title: str(g.title), description: nullableStr(g.description), role: asRole(g.role ?? g.myRole ?? me.role),
    memberCount: num(g.memberCount, 0), capacity: num(g.capacity, 0),
    nextExam: next ? { id: str(next.id), title: str(next.title), opensAt: nullableStr(next.opensAt), closesAt: nullableStr(next.closesAt) } : null,
    lastExam: last ? { id: str(last.id), title: str(last.title), publishedAt: nullableStr(last.publishedAt) } : null,
  };
}

export function readGroupDetail(raw: unknown): GroupDetail {
  const g = isRec(raw) ? raw : {};
  const me = isRec(g.me) ? g.me : {};
  const show = me.showNameOnLeaderboard ?? g.showNameOnLeaderboard;
  return {
    id: str(g.id), title: str(g.title), description: nullableStr(g.description), capacity: num(g.capacity, 0), memberCount: num(g.memberCount, 0), createdAt: nullableStr(g.createdAt), ownerName: nullableStr(g.ownerName),
    role: asRole(g.myRole ?? g.role ?? me.role), showNameOnLeaderboard: typeof show === "boolean" ? show : true,
  };
}

const PARTICIPATION: MyExamStatus[] = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "TIMED_OUT", "MISSED", "AUTHOR", "NOT_ELIGIBLE"];
export function readExamRow(raw: unknown): GroupExamRow {
  const e = isRec(raw) ? raw : {};
  const p = e.participation ?? e.myStatus ?? e.myParticipation;
  const status = ["PUBLISHED", "CANCELLED", "DRAFT"].includes(str(e.status)) ? (e.status as GroupExamRow["status"]) : "PUBLISHED";
  return {
    id: str(e.id), title: str(e.title), status, questionCount: typeof e.questionCount === "number" ? e.questionCount : null, totalMarks: typeof e.totalMarks === "number" ? e.totalMarks : null,
    durationMinutes: typeof e.durationMinutes === "number" ? e.durationMinutes : null, opensAt: nullableStr(e.opensAt), closesAt: nullableStr(e.closesAt), publishedAt: nullableStr(e.publishedAt),
    participation: PARTICIPATION.includes(p as MyExamStatus) ? (p as MyExamStatus) : null, mine: e.mine === true,
    authorName: nullableStr(e.authorName), leaderboardVisible: e.leaderboardVisible !== false,
    result: isRec(e.myResult) ? (e.myResult.released === true ? { released: true, percentBp: typeof e.myResult.percentBp === "number" ? e.myResult.percentBp : null } : { released: false }) : null,
  };
}

export function readList<T>(raw: unknown, read: (v: unknown) => T): Paged<T> {
  const r = isRec(raw) ? raw : {};
  const items = Array.isArray(r.items) ? r.items : Array.isArray(r.groups) ? r.groups : [];
  return { items: items.map(read), total: num(r.total, items.length), page: num(r.page, 1), pageSize: num(r.pageSize, items.length || 1) };
}

export function readInvite(raw: unknown): InviteView {
  const i = isRec(raw) ? raw : {};
  const status = ["ACTIVE", "EXPIRED", "REVOKED", "USED_UP"].includes(str(i.status)) ? (i.status as InviteStatus) : "ACTIVE";
  return {
    id: str(i.id), status, expiresAt: str(i.expiresAt), maxUses: num(i.maxUses, 1), useCount: num(i.useCount, 0), codeHint: str(i.codeHint), forEmail: i.forEmail === true, createdAt: nullableStr(i.createdAt),
  };
}

export const readMember = (raw: unknown): MemberView => {
  const m = isRec(raw) ? raw : {};
  return { memberId: str(m.memberId), displayName: str(m.displayName, "Member"), role: asRole(m.role), joinedAt: str(m.joinedAt), isSelf: m.isSelf === true };
};

// ----------------------------------------------------------------------------------------------- permissions (display only!)
/** Mirrors the permission matrix in the spec. The server enforces it; this only hides buttons that would be refused. */
export const canEditGroup = (r: GroupRole) => r === "OWNER";
export const canManageInvites = (r: GroupRole) => r === "OWNER" || r === "ADMIN";
export const canPublishGroupExam = (r: GroupRole) => r === "OWNER" || r === "ADMIN";
export const canChangeRoles = (r: GroupRole) => r === "OWNER";
export const canLeave = (r: GroupRole) => r !== "OWNER";
export function canRemoveMember(actor: GroupRole, target: GroupRole, isSelf: boolean): boolean {
  if (isSelf || target === "OWNER") return false;
  if (actor === "OWNER") return true;
  return actor === "ADMIN" && target === "MEMBER";
}

// ----------------------------------------------------------------------------------------------- invites
export const INVITE_STATUS_LABEL: Record<InviteStatus, string> = { ACTIVE: "Active", EXPIRED: "Expired", REVOKED: "Revoked", USED_UP: "Used up" };

export function inviteUsage(i: Pick<InviteView, "useCount" | "maxUses">): string {
  return `${i.useCount} of ${i.maxUses} ${i.maxUses === 1 ? "use" : "uses"}`;
}

/** Codes arrive grouped with dashes (kept as-is); an ungrouped code is split in blocks of four. Copy always uses the code exactly as issued. */
export function formatCode(code: string): string {
  const raw = code.trim();
  if (raw.includes("-")) return raw; // the server already groups codes with dashes
  return raw.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** Accepts what people paste: spaces, dashes and a whole invitation link. Case is left untouched (the server decides). */
export function normalizeCodeInput(value: string): string {
  let v = value.trim();
  const m = /\/join\/([^/?#\s]+)/.exec(v);
  if (m?.[1]) v = decodeURIComponentSafe(m[1]);
  else if (/%[0-9a-f]{2}/i.test(v)) v = decodeURIComponentSafe(v);
  return v.replace(/[\s-]+/g, "");
}
function decodeURIComponentSafe(s: string) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export const joinPath = (code: string) => `/join/${encodeURIComponent(code)}`;
export function inviteLink(code: string, origin: string): string {
  return `${origin.replace(/\/$/, "")}${joinPath(code)}`;
}

export const TTL_PRESETS: { hours: number; label: string }[] = [
  { hours: 1, label: "1 hour" }, { hours: 24, label: "1 day" }, { hours: 168, label: "7 days" }, { hours: 720, label: "30 days" },
];
export const ttlOptions = (max: number) => TTL_PRESETS.filter((p) => p.hours <= max);

export const PARTICIPATION_LABEL: Record<MyExamStatus, string> = {
  NOT_STARTED: "Not started", IN_PROGRESS: "In progress", SUBMITTED: "Submitted", TIMED_OUT: "Timed out", MISSED: "Missed", AUTHOR: "You published this", NOT_ELIGIBLE: "Not eligible",
};

export const examLink = (id: string) => `/exams/${encodeURIComponent(id)}`;
export const leaderboardLink = (id: string) => `/exams/${encodeURIComponent(id)}/leaderboard`;
export const newGroupExamLink = (groupId: string) => `/exams/new?mode=GROUP&groupId=${encodeURIComponent(groupId)}`;

// ----------------------------------------------------------------------------------------------- errors
export function groupFieldErrors(e: ApiError): Record<string, string> {
  return e.fields;
}

/** Plain-language message for a failed group/invite request. Raw server text is only used where it is already user-safe. */
export function describeGroupError(e: { code: string; message: string; details?: Record<string, unknown> }, ctx: "join" | "generic" = "generic"): string {
  const retry = typeof e.details?.retryAfterSec === "number" ? e.details.retryAfterSec : null;
  switch (e.code) {
    case "INVALID_INVITE": return "This invitation isn't valid. It may have expired, been revoked, already been used up, or be meant for someone else. Ask the group owner for a new one.";
    case "GROUP_FULL": return "This group is full, so you can't join right now. Ask the owner to make room.";
    case "RATE_LIMITED": return retry ? `Too many attempts. Please wait about ${retry >= 90 ? `${Math.ceil(retry / 60)} minutes` : `${retry} seconds`} and try again.` : "Too many attempts. Please wait a while and try again.";
    case "NOT_ELIGIBLE": return "You don't have permission to do that in this group.";
    case "NOT_FOUND": return ctx === "join" ? "We couldn't find that invitation." : "We couldn't find that. It may have been removed.";
    case "UNAUTHENTICATED": return "Your session has ended. Please sign in again.";
    case "NETWORK": return e.message;
    case "VALIDATION": return e.message || "Some details are invalid.";
    default: return e.message || "Something went wrong. Please try again.";
  }
}
