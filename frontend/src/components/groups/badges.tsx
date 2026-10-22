"use client";

import { CheckCircle2, Clock, MinusCircle, PlayCircle, ShieldCheck, Crown, User, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABEL, type GroupRole } from "@/lib/groups";
import { statusChip } from "@/lib/leaderboard";
import type { MyExamStatus } from "@/lib/groups";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

const ROLE_ICON = { OWNER: Crown, ADMIN: ShieldCheck, MEMBER: User } as const;

/** Role is always spelled out in text; the icon is decoration. */
export function RoleBadge({ role, className }: { role: GroupRole; className?: string }) {
  const t = useT();
  const Icon = ROLE_ICON[role];
  return (
    <Badge variant={role === "MEMBER" ? "outline" : "secondary"} className={cn("rounded-full", className)}>
      <Icon aria-hidden /> {t(ROLE_LABEL[role])}
    </Badge>
  );
}

const TONE = {
  success: "bg-success-soft text-foreground border-success/40",
  warning: "bg-warning-soft text-foreground border-warning/50",
  info: "bg-info-soft text-foreground border-primary/30",
  muted: "bg-muted text-foreground border-border",
  danger: "bg-destructive/10 text-foreground border-destructive/40",
} as const;
const ICON = { check: CheckCircle2, clock: Clock, play: PlayCircle, minus: MinusCircle, x: XCircle } as const;

/** Participation status: label + icon + tone (never colour alone). */
export function StatusChip({ status, className }: { status: MyExamStatus; className?: string }) {
  const t = useT();
  const c = statusChip(status);
  const Icon = ICON[c.icon];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONE[c.tone], className)}>
      <Icon className="size-3.5" aria-hidden /> {t(c.label)}
    </span>
  );
}
