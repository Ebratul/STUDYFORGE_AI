"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DIFFICULTY_SETTING_LABEL, effectiveGrounding, hasSources, LANGUAGE_LABEL, resolveLimits, validateMcqSettings,
  type DifficultySetting, type FieldErrors, type Grounding, type Language, type McqSettings, type ModelRef, type QuestionLimitsResponse,
} from "@/lib/questions";
import { Field, NumberInput, Segmented, SwitchRow } from "./fields";
import { GenerationError, GenerationProgress, RecentRuns } from "./generation-ui";
import { ModelField } from "./model-field";
import { ReviewWorkspace } from "./review-workspace";
import { GroundingField, SourceFields, type SourceValue } from "./source-fields";
import { useGeneration } from "./use-generation";

type Form = {
  sources: SourceValue;
  count: number; difficulty: DifficultySetting; language: Language; optionCount: number; marks: number; negativeMarks: number;
  includeExplanations: boolean; includeShortNotes: boolean; crossCheck: boolean;
  groundingChoice: Grounding | null; override: ModelRef | null;
};

const INITIAL: Form = {
  sources: { topic: "", pastedText: "", documentIds: [], subject: "" },
  count: 10, difficulty: "MIXED", language: "en", optionCount: 4, marks: 1, negativeMarks: 0,
  includeExplanations: true, includeShortNotes: true, crossCheck: true, groundingChoice: null, override: null,
};

export function toMcqSettings(f: Form): McqSettings {
  const s = f.sources;
  return {
    ...(s.topic.trim() ? { topic: s.topic.trim() } : {}),
    ...(s.pastedText.trim() ? { pastedText: s.pastedText.trim() } : {}),
    ...(s.documentIds.length ? { documentIds: s.documentIds } : {}),
    ...(s.subject.trim() ? { subject: s.subject.trim() } : {}),
    count: f.count, difficulty: f.difficulty, language: f.language, optionCount: f.optionCount, marks: f.marks, negativeMarks: f.negativeMarks,
    includeExplanations: f.includeExplanations, includeShortNotes: f.includeShortNotes, crossCheck: f.crossCheck,
    grounding: effectiveGrounding(f.groundingChoice, s),
    ...(f.override?.modelId ? { model: f.override } : {}),
  };
}

export function McqWorkspace({ limitsResponse }: { limitsResponse: QuestionLimitsResponse }) {
  const limits = resolveLimits(limitsResponse);
  const gen = useGeneration("MCQ");
  const [form, setForm] = useState<Form>(INITIAL);
  const [shown, setShown] = useState(false);
  const [last, setLast] = useState<McqSettings | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const settings = toMcqSettings(form);
  const local = shown ? validateMcqSettings(settings, limits) : {};
  const errors: FieldErrors = { ...gen.error?.fields, ...local };
  const grounding = settings.grounding;
  const configured = limitsResponse.models.MCQ;
  const noModel = !configured && !form.override?.modelId;

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setShown(true);
    const problems = validateMcqSettings(settings, limits);
    if (Object.keys(problems).length) {
      const first = Object.keys(problems)[0];
      document.getElementById(`mcq-${first}`)?.focus();
      return;
    }
    setLast(settings);
    gen.clearRun();
    void gen.start(settings);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
      <form onSubmit={submit} noValidate className="space-y-4" aria-label="MCQ generation settings">
        <Card className="rounded-2xl shadow-card">
          <CardHeader>
            <CardTitle className="text-base">1. Where should the questions come from?</CardTitle>
            <CardDescription>Type a topic, paste text, pick your documents — or combine them.</CardDescription>
          </CardHeader>
          <CardContent>
            <SourceFields idPrefix="mcq" value={form.sources} onChange={(v) => set("sources", v)} errors={errors} limits={limits} />
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-card">
          <CardHeader><CardTitle className="text-base">2. Question settings</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Number of questions" htmlFor="mcq-count" error={errors.count} hint={`Up to ${limits.mcqMaxQuestions}.`}>
                <NumberInput id="mcq-count" value={form.count} min={1} max={limits.mcqMaxQuestions} invalid={Boolean(errors.count)} describedBy={errors.count ? "mcq-count-err" : "mcq-count-hint"} onChange={(n) => set("count", n)} />
              </Field>
              <Field label="Answer options" htmlFor="mcq-optionCount" error={errors.optionCount} hint="2 to 6 per question.">
                <NumberInput id="mcq-optionCount" value={form.optionCount} min={2} max={6} invalid={Boolean(errors.optionCount)} describedBy={errors.optionCount ? "mcq-optionCount-err" : "mcq-optionCount-hint"} onChange={(n) => set("optionCount", n)} />
              </Field>
              <Field label="Marks per question" htmlFor="mcq-marks" error={errors.marks}>
                <NumberInput id="mcq-marks" value={form.marks} min={0.25} max={100} step={0.25} invalid={Boolean(errors.marks)} onChange={(n) => set("marks", n)} />
              </Field>
              <Field label="Negative marks (optional)" htmlFor="mcq-negativeMarks" error={errors.negativeMarks} hint="Saved for future exams; nothing is scored here.">
                <NumberInput id="mcq-negativeMarks" value={form.negativeMarks} min={0} max={100} step={0.25} invalid={Boolean(errors.negativeMarks)} describedBy={errors.negativeMarks ? "mcq-negativeMarks-err" : "mcq-negativeMarks-hint"} onChange={(n) => set("negativeMarks", n)} />
              </Field>
            </div>
            <Segmented legend="Difficulty" name="mcq-difficulty" value={form.difficulty} onChange={(v) => set("difficulty", v)}
              options={(Object.keys(DIFFICULTY_SETTING_LABEL) as DifficultySetting[]).map((d) => ({ value: d, label: DIFFICULTY_SETTING_LABEL[d] }))} />
            <Segmented legend="Output language" name="mcq-language" value={form.language} onChange={(v) => set("language", v)}
              options={(Object.keys(LANGUAGE_LABEL) as Language[]).map((l) => ({ value: l, label: LANGUAGE_LABEL[l] }))} />
            <div className="space-y-2">
              <SwitchRow label="Explanations" description="Why the answer is correct." checked={form.includeExplanations} onChange={(v) => set("includeExplanations", v)} />
              <SwitchRow label="Related short notes" description="A concise fact to revise with each question." checked={form.includeShortNotes} onChange={(v) => set("includeShortNotes", v)} />
              <SwitchRow label="Double-check answer keys" description="A second AI pass tries to answer each question blind and flags disagreements. Uses more of your quota." checked={form.crossCheck} onChange={(v) => set("crossCheck", v)} />
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-card">
          <CardHeader><CardTitle className="text-base">3. Grounding and model</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <GroundingField idPrefix="mcq" value={grounding} onChange={(g) => set("groundingChoice", g)} hasSources={hasSources(settings)} error={errors.grounding} />
            <ModelField configured={configured} task="MCQ" override={form.override} onOverride={(m) => set("override", m)} />
          </CardContent>
        </Card>

        <Button type="submit" size="lg" className="h-11 w-full rounded-xl" disabled={gen.busy || noModel}>
          {gen.busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />} {gen.busy ? "Generating…" : `Generate ${form.count > 0 && Number.isFinite(form.count) ? form.count : ""} MCQs`}
        </Button>
        {noModel && <p className="text-center text-xs text-muted-foreground">Choose a model above to enable generation.</p>}
      </form>

      <div className="min-w-0 space-y-4">
        {gen.status && <GenerationProgress status={gen.status} onStop={gen.stop} />}
        {gen.stopped && !gen.busy && <p role="status" className="rounded-xl border bg-muted/40 p-3 text-sm">Generation stopped. Nothing was saved.</p>}
        {gen.error && <GenerationError error={gen.error} grounding={(last ?? settings).grounding} onDismiss={gen.clearError} onRetry={last ? () => void gen.start(last) : undefined} />}
        {gen.run && (
          <ReviewWorkspace key={gen.run.id} run={gen.run} limits={limits} withAnswers generating={gen.busy} title={form.sources.topic.trim() || "MCQ set"}
            onRegenerateAll={() => { gen.clearRun(); void gen.start(last ?? settings); }} />
        )}
        {!gen.run && !gen.busy && !gen.error && !gen.stopped && (
          <div className="rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center">
            <span className="mx-auto mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Sparkles className="size-5" aria-hidden /></span>
            <h2 className="text-base font-semibold">Your questions will appear here</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Set up your sources and options, then generate. You can edit, regenerate, select and save the questions before they go anywhere.</p>
          </div>
        )}
        <RecentRuns kind="MCQ" currentId={gen.run?.id} onOpen={(id) => void gen.open(id)} />
      </div>
    </div>
  );
}
