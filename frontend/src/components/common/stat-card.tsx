import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatCard({ label, value, hint, icon: Icon, tone = "violet" }: { label: string; value: React.ReactNode; hint?: string; icon: LucideIcon; tone?: "violet" | "green" | "amber" | "blue" }) {
  const tones = {
    violet: "bg-accent text-accent-foreground",
    green: "bg-success-soft text-success",
    amber: "bg-warning-soft text-warning",
    blue: "bg-info-soft text-primary",
  } as const;
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border bg-card p-5 shadow-card">
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1.5 text-3xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <span className={cn("inline-flex size-11 shrink-0 items-center justify-center rounded-2xl", tones[tone])}><Icon className="size-5" aria-hidden /></span>
    </div>
  );
}
