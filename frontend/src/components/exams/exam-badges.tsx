import { Ban, CheckCircle2, FileEdit, User, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ExamStatus } from "@/lib/exams";
import { cn } from "@/lib/utils";

const chip = "h-6 gap-1 rounded-full px-2 text-[11px] font-medium";

export function StatusBadge({ status }: { status: ExamStatus }) {
  if (status === "DRAFT") return <Badge variant="outline" className={cn(chip, "text-muted-foreground")}><FileEdit aria-hidden /> Draft</Badge>;
  if (status === "CANCELLED") return <Badge variant="outline" className={cn(chip, "border-destructive/40 text-destructive")}><Ban aria-hidden /> Cancelled</Badge>;
  return <Badge variant="outline" className={cn(chip, "border-success/40 bg-success-soft text-success")}><CheckCircle2 aria-hidden /> Published</Badge>;
}

export function ModeBadge({ mode, group }: { mode: "INDIVIDUAL" | "GROUP"; group: { title: string } | null }) {
  return mode === "GROUP"
    ? <Badge variant="secondary" className={cn(chip, "font-normal")}><Users aria-hidden /> {group?.title ?? "Group exam"}</Badge>
    : <Badge variant="secondary" className={cn(chip, "font-normal")}><User aria-hidden /> Individual</Badge>;
}
