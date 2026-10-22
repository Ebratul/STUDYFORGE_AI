"use client";

import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, HelpCircle, ShieldCheck, ShieldHalf, User, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { HEALTH_LABEL, ROLE_SHORT, pageCount, type AdminRole, type HealthState } from "@/lib/admin";
import { cn } from "@/lib/utils";

/** Role is spelled out in text; the icon is decoration. */
export function AdminRoleBadge({ role, className }: { role: AdminRole; className?: string }) {
  const Icon = role === "ADMIN" ? ShieldCheck : role === "SUPPORT" ? ShieldHalf : User;
  return (
    <Badge variant={role === "USER" ? "outline" : "secondary"} className={cn("rounded-full", className)} data-testid="role-badge">
      <Icon aria-hidden /> {ROLE_SHORT[role]}
    </Badge>
  );
}

const TONE = {
  ok: "bg-success-soft text-foreground border-success/40",
  degraded: "bg-warning-soft text-foreground border-warning/50",
  down: "bg-destructive/10 text-foreground border-destructive/40",
  idle: "bg-muted text-foreground border-border",
  unknown: "bg-muted text-foreground border-border",
} as const;
const ICON = { ok: CheckCircle2, degraded: AlertTriangle, down: XCircle, idle: CircleDashed, unknown: HelpCircle } as const;

/** Operational state: icon + word + tone. Colour is never the only signal. */
export function HealthChip({ state, label, className }: { state: HealthState; label?: string; className?: string }) {
  const Icon = ICON[state];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONE[state], className)} data-state={state}>
      <Icon className="size-3.5" aria-hidden /> {label ?? HEALTH_LABEL[state]}
    </span>
  );
}

const CHIP = {
  success: "bg-success-soft text-foreground border-success/40",
  warning: "bg-warning-soft text-foreground border-warning/50",
  muted: "bg-muted text-foreground border-border",
  danger: "bg-destructive/10 text-foreground border-destructive/40",
} as const;
export function Chip({ tone = "muted", children, className }: { tone?: keyof typeof CHIP; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", CHIP[tone], className)}>{children}</span>;
}

export function Pager({ page, total, pageSize, onPage, label }: { page: number; total: number; pageSize: number; onPage: (p: number) => void; label: string }) {
  const pages = pageCount(total, pageSize);
  return (
    <nav aria-label={`${label} pagination`} className="flex items-center justify-between gap-3 border-t px-5 py-3">
      <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft aria-hidden /> Previous</Button>
      <p className="text-sm text-muted-foreground" aria-live="polite">Page {page} of {pages}</p>
      <Button variant="outline" size="sm" className="rounded-xl" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next <ChevronRight aria-hidden /></Button>
    </nav>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 rounded-xl" />)}
    </div>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return <p role="alert" className="p-5 text-sm text-destructive">{message}</p>;
}

export function Panel({ title, description, actions, children, id, className }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode; id: string; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn("rounded-2xl border bg-card shadow-card", className)}>
      <div className="flex flex-col gap-2 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
