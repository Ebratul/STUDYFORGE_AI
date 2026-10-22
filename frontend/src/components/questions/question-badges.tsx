import { AlertTriangle, BadgeCheck, Bot, BookOpenText, PencilLine, Sparkles, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BASIS_LABEL, LEVEL_LABEL, reviewReasonText, SUPPORT_LABEL, type AnswerObj, type CqLevel, type Language, type QuestionContent, type SourceRef } from "@/lib/questions";
import { cn } from "@/lib/utils";

const chip = "h-6 gap-1 rounded-full px-2 text-[11px] font-medium";

export function AiBadge() {
  return (
    <Badge variant="outline" className={cn(chip, "border-primary/30 bg-info-soft text-primary")} title="AI-generated questions can contain mistakes. Check every answer key before using them.">
      <Sparkles aria-hidden /> AI-generated — review before use
    </Badge>
  );
}

export function SupportBadge({ support }: { support: QuestionContent["sourceSupport"] }) {
  const s = SUPPORT_LABEL[support];
  const Icon = support === "SOURCE_QUOTED" ? BookOpenText : support === "NONE" ? UserRound : Bot;
  return (
    <Badge variant="outline" className={cn(chip, support === "SOURCE_QUOTED" ? "border-success/30 bg-success-soft text-success" : "text-muted-foreground")} title={s.hint}>
      <Icon aria-hidden /> {s.label}
    </Badge>
  );
}

export function EditedBadge() {
  return <Badge variant="outline" className={cn(chip, "text-muted-foreground")} title="You changed this question after it was generated, so the original source check no longer covers your changes."><PencilLine aria-hidden /> Edited</Badge>;
}

export function ReviewedBadge() {
  return <Badge variant="outline" className={cn(chip, "border-success/30 bg-success-soft text-success")}><BadgeCheck aria-hidden /> Reviewed</Badge>;
}

export function NeedsReview({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <div role="note" className="rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm" data-testid="needs-review">
      <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4 text-warning" aria-hidden /> Needs review</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-foreground/80">
        {reasons.map((r) => <li key={r}>{reviewReasonText(r)}</li>)}
      </ul>
    </div>
  );
}

export function LevelBadge({ level, language }: { level: CqLevel | null; language: Language }) {
  if (!level) return null;
  return <Badge variant="secondary" className={cn(chip, "font-normal")}>{LEVEL_LABEL[language][level]}</Badge>;
}

export function BasisBadge({ answer }: { answer: AnswerObj | null }) {
  if (!answer) return null;
  const b = BASIS_LABEL[answer.basis];
  const tone =
    answer.basis === "SOURCE_SUPPORTED" ? "border-success/30 bg-success-soft text-success"
    : answer.basis === "INSUFFICIENT_EVIDENCE" ? "border-warning/40 bg-warning-soft text-foreground"
    : "text-muted-foreground";
  return <Badge variant="outline" className={cn(chip, "h-auto whitespace-normal py-0.5 text-left", tone)} title={b.hint}>{b.label}</Badge>;
}

/** The quotes behind a question or answer. Quotes are verbatim text from the user's own source (or pasted text). */
export function EvidenceList({ sources, label = "Evidence from your sources" }: { sources: SourceRef[]; label?: string }) {
  if (!sources.length) return null;
  return (
    <details className="rounded-xl border bg-muted/30 px-3 py-2 text-sm">
      <summary className="min-h-8 cursor-pointer py-1 font-medium">{label} ({sources.length})</summary>
      <ul className="mt-2 space-y-2">
        {sources.map((s, i) => (
          <li key={`${s.documentName}-${i}`} className="rounded-lg border bg-card p-2.5">
            <blockquote className="border-l-2 border-primary/40 pl-2.5 text-foreground/90">“{s.quote}”</blockquote>
            <p className="mt-1 text-xs text-muted-foreground">
              {s.documentName}{s.page ? ` · page ${s.page}` : s.section ? ` · ${s.section}` : ""}{" "}
              {s.quoteVerified ? "· found word-for-word in the source" : "· excerpt (not verified word-for-word)"}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}
