"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, CloudCheck, CloudOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/questions/fields";
import { ApiError, apiSend } from "@/lib/api";
import {
  describeExamError, fieldMessage, normalizeDraft, resolveExamLimits, stepForField, validateDraftLocal,
  type ExamDraftInput, type ExamLimitsResponse, type ExamManageView, type SelectedQuestion,
} from "@/lib/exams";
import { PreviewStep } from "./wizard-preview";
import { QuestionsStep } from "./wizard-questions";
import { RulesStep } from "./wizard-rules";
import { useDraftSave, type DraftSaveStatus } from "./use-draft-save";
import { StatusBadge, ModeBadge } from "./exam-badges";
import { cn } from "@/lib/utils";

type Step = "details" | "questions" | "rules" | "preview";
const STEPS: { id: Step; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "questions", label: "Questions" },
  { id: "rules", label: "Rules" },
  { id: "preview", label: "Preview & publish" },
];

const SAVE_TEXT: Record<DraftSaveStatus, string> = { saved: "Draft saved", saving: "Saving draft…", unsaved: "Unsaved changes", rejected: "Not saved — see the highlighted fields", incomplete: "Fill in the highlighted fields to save" };

export function ExamWizard({ exam, limitsResponse, initialStep }: { exam: ExamManageView; limitsResponse: ExamLimitsResponse | null; initialStep: string | null }) {
  const router = useRouter();
  const limits = resolveExamLimits(limitsResponse);
  const [step, setStepState] = useState<Step>(STEPS.some((s) => s.id === initialStep) ? (initialStep as Step) : "details");
  const [draft, setDraftState] = useState<ExamDraftInput>(() => normalizeDraft(exam.draft, { title: exam.title, description: exam.description }));
  const [qmap, setQmapState] = useState<Record<string, SelectedQuestion>>(() => Object.fromEntries((exam.questions ?? []).map((q) => [q.id, q])));
  const [publishing, setPublishing] = useState(false);
  const [publishFields, setPublishFields] = useState<Record<string, string>>({});
  const [publishError, setPublishError] = useState<string | null>(null);

  const save = useDraftSave(exam.id, draft, true);
  const local = useMemo(() => validateDraftLocal(draft, limits, exam.mode), [draft, limits, exam.mode]);
  const errors = useMemo(() => ({ ...local, ...Object.fromEntries(Object.entries(save.serverFields).map(([k, v]) => [k, v])) }), [local, save.serverFields]);

  const setDraft = useCallback((fn: (d: ExamDraftInput) => ExamDraftInput) => { setDraftState(fn); setPublishFields({}); }, []);
  const setQmap = useCallback((fn: (m: Record<string, SelectedQuestion>) => Record<string, SelectedQuestion>) => setQmapState(fn), []);
  const setStep = useCallback((s: Step) => {
    setStepState(s);
    const url = new URL(window.location.href);
    url.searchParams.set("step", s);
    window.history.replaceState(null, "", url);
    window.scrollTo({ top: 0 });
  }, []);

  // Don't lose edits when the tab closes before the debounce fires.
  useEffect(() => {
    if (save.status === "saved") return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save.status]);

  async function publish() {
    setPublishError(null);
    setPublishFields({});
    setPublishing(true);
    try {
      if (!(await save.flush())) throw new ApiError(422, "VALIDATION", "The draft couldn't be saved. Fix the highlighted fields first.");
      await apiSend("POST", `/api/exams/${exam.id}/publish`, {});
      router.push(`/exams/${exam.id}?published=1`);
    } catch (err) {
      setPublishing(false);
      if (err instanceof ApiError) {
        setPublishFields(err.fields);
        const first = Object.keys(err.fields)[0];
        setPublishError(first ? "Some settings need attention before this can be published." : `${describeExamError(err.code, err.message).title}. ${err.message}`);
      } else setPublishError("Couldn't reach the server. Please try again.");
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const blockedNext = step === "details" && Boolean(local.title);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{draft.title.trim() || "Untitled exam"}</h1>
          <StatusBadge status="DRAFT" /><ModeBadge mode={exam.mode} group={exam.group} />
        </div>
        <p role="status" aria-live="polite" className={cn("inline-flex items-center gap-1.5 text-xs", save.status === "rejected" ? "text-destructive" : "text-muted-foreground")} data-testid="draft-status">
          {save.status === "saving" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : save.status === "saved" ? <CloudCheck className="size-3.5 text-success" aria-hidden /> : <CloudOff className="size-3.5" aria-hidden />}
          {SAVE_TEXT[save.status]}
        </p>
      </div>

      <nav aria-label="Exam steps" className="mb-6">
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STEPS.map((s, i) => {
            const done = i < stepIndex;
            const hasError = Object.keys(errors).some((k) => stepForField(k) === s.id);
            return (
              <li key={s.id}>
                <button type="button" onClick={() => setStep(s.id)} aria-current={s.id === step ? "step" : undefined}
                  className={cn("flex w-full items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-left text-sm font-medium outline-none transition focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none", s.id === step && "border-primary bg-accent text-accent-foreground")}>
                  <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold", s.id === step ? "border-primary bg-primary text-primary-foreground" : done ? "border-success/50 bg-success-soft text-success" : "bg-muted text-muted-foreground")}>{done ? <Check className="size-3.5" aria-hidden /> : i + 1}</span>
                  <span className="min-w-0 truncate">{s.label}</span>
                  {hasError && s.id !== "preview" && <span className="ml-auto size-2 shrink-0 rounded-full bg-destructive" aria-label="has problems" />}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === "details" && (
        <section className="mx-auto max-w-2xl space-y-5 rounded-2xl border bg-card p-5 shadow-card sm:p-7" aria-label="Exam details">
          <Field label="Title" htmlFor="w-title" error={fieldMessage(errors, "title")}>
            <Input id="w-title" value={draft.title} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} aria-invalid={Boolean(errors.title) || undefined} aria-describedby={errors.title ? "w-title-err" : undefined} className="h-10 rounded-xl" />
          </Field>
          <Field label="Description (optional)" htmlFor="w-desc" hint="Shown to participants before they start." error={fieldMessage(errors, "description")}>
            <Textarea id="w-desc" value={draft.description ?? ""} maxLength={1000} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} className="min-h-24 rounded-xl" />
          </Field>
          <p className="text-sm text-muted-foreground">{exam.mode === "GROUP" ? `This is a group exam for “${exam.group?.title ?? "your group"}”. Everyone in the group gets the same questions.` : "This is an individual exam: only you can take it."}</p>
        </section>
      )}
      {step === "questions" && <QuestionsStep draft={draft} setDraft={setDraft} qmap={qmap} setQmap={setQmap} limits={limits} errors={errors} />}
      {step === "rules" && <RulesStep draft={draft} setDraft={setDraft} limits={limits} errors={errors} mode={exam.mode} />}
      {step === "preview" && (
        <PreviewStep examId={exam.id} draft={draft} ready={save.status === "saved"} flush={save.flush} onPublish={() => void publish()} publishing={publishing} publishFields={publishFields} publishError={publishError} goto={(s) => setStep(s)} />
      )}

      <div className="mt-6 flex items-center justify-between">
        <Button variant="outline" className="rounded-xl" disabled={stepIndex === 0} onClick={() => setStep(STEPS[stepIndex - 1]!.id)}><ChevronLeft aria-hidden /> Back</Button>
        {stepIndex < STEPS.length - 1 && (
          <Button className="rounded-xl" disabled={blockedNext} onClick={() => setStep(STEPS[stepIndex + 1]!.id)} data-testid="wizard-next">{STEPS[stepIndex + 1]!.label} <ChevronRight aria-hidden /></Button>
        )}
      </div>
    </div>
  );
}
