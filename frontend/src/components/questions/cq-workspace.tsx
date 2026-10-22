"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  defaultPartMarks, DIFFICULTY_SETTING_LABEL, effectiveGrounding, forcedStimulus, hasSources, LANGUAGE_LABEL, LEVEL_LABEL, LEVELS, partLabel, resolveLimits, validateCqSettings,
  type CqMode, type CqSettings, type CqStructure, type DifficultySetting, type FieldErrors, type Grounding, type Language, type ModelRef, type QuestionLimitsResponse,
} from "@/lib/questions";
import { cn } from "@/lib/utils";
import type { Prefill } from "@/lib/prefill";
import { Field, FieldError, NumberInput, Segmented } from "./fields";
import { GenerationError, GenerationProgress, RecentRuns } from "./generation-ui";
import { ModelField } from "./model-field";
import { ReviewWorkspace } from "./review-workspace";
import { GroundingField, SourceFields, type SourceValue } from "./source-fields";
import { useGeneration } from "./use-generation";

type Stimulus = "required" | "optional" | "none";
type Form = {
  sources: SourceValue; mode: CqMode; structure: CqStructure; partCount: number; totalMarks: number; customMarks: number[] | null; stimulusChoice: Stimulus | null;
  count: number; difficulty: DifficultySetting; language: Language; groundingChoice: Grounding | null; override: ModelRef | null;
};

const INITIAL: Form = {
  sources: { topic: "", pastedText: "", documentIds: [], subject: "" }, mode: "QUESTIONS_ONLY", structure: "stimulus_4part", partCount: 3, totalMarks: 10, customMarks: null, stimulusChoice: null,
  count: 3, difficulty: "MEDIUM", language: "en", groundingChoice: null, override: null,
};

const MODES: { value: CqMode; title: string; text: string }[] = [
  { value: "QUESTIONS_ONLY", title: "Questions only", text: "Writes descriptive or creative questions. No model answers are generated." },
  { value: "WITH_ANSWERS", title: "Questions with answers", text: "Also writes a model answer for each part, backed by quotes from your sources. Where your sources don't cover a part, it says so instead of inventing one." },
];
const STRUCTURES: { value: CqStructure; label: string; hint: string }[] = [
  { value: "stimulus_4part", label: "Stimulus-based, 4 parts", hint: "A stimulus followed by four sub-questions: knowledge, comprehension, application and higher-order skills." },
  { value: "descriptive", label: "Descriptive / short answer", hint: "A single question, with an optional stimulus." },
  { value: "multipart", label: "Multi-part", hint: "A question split into 2–6 parts that you set the marks for." },
];

const effectiveStimulus = (f: Form): Stimulus => forcedStimulus(f.structure) ?? f.stimulusChoice ?? (f.structure === "descriptive" ? "none" : "optional");
const effectivePartCount = (f: Form) => (f.structure === "stimulus_4part" ? 4 : f.structure === "multipart" ? f.partCount : 0);
const effectiveMarks = (f: Form): number[] | undefined => {
  const n = effectivePartCount(f);
  return n ? (f.customMarks && f.customMarks.length === n ? f.customMarks : defaultPartMarks(f.structure, n, f.totalMarks)) : undefined;
};

export function toCqSettings(f: Form): CqSettings {
  const s = f.sources;
  const partMarks = effectiveMarks(f);
  return {
    ...(s.topic.trim() ? { topic: s.topic.trim() } : {}),
    ...(s.pastedText.trim() ? { pastedText: s.pastedText.trim() } : {}),
    ...(s.documentIds.length ? { documentIds: s.documentIds } : {}),
    ...(s.subject.trim() ? { subject: s.subject.trim() } : {}),
    mode: f.mode, structure: f.structure, ...(f.structure === "multipart" ? { partCount: f.partCount } : {}), ...(partMarks ? { partMarks } : {}),
    totalMarks: f.totalMarks, stimulus: effectiveStimulus(f), count: f.count, difficulty: f.difficulty, language: f.language,
    grounding: effectiveGrounding(f.groundingChoice, s), ...(f.override?.modelId ? { model: f.override } : {}),
  };
}

export function CqWorkspace({ limitsResponse, prefill }: { limitsResponse: QuestionLimitsResponse; prefill?: Prefill }) {
  const limits = resolveLimits(limitsResponse);
  const gen = useGeneration("CQ");
  const [form, setForm] = useState<Form>(() =>
    prefill
      ? { ...INITIAL, sources: { ...INITIAL.sources, topic: prefill.topic, subject: prefill.subject }, groundingChoice: prefill.grounding }
      : INITIAL,
  );
  const [shown, setShown] = useState(false);
  const [last, setLast] = useState<CqSettings | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const settings = toCqSettings(form);
  const local = shown ? validateCqSettings(settings, limits) : {};
  const errors: FieldErrors = { ...gen.error?.fields, ...local };
  const configured = limitsResponse.models.CQ;
  const noModel = !configured && !form.override?.modelId;
  const marks = effectiveMarks(form);
  const forced = forcedStimulus(form.structure);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setShown(true);
    const problems = validateCqSettings(settings, limits);
    if (Object.keys(problems).length) {
      document.getElementById(`cq-${Object.keys(problems)[0]}`)?.focus();
      return;
    }
    setLast(settings);
    gen.clearRun();
    void gen.start(settings);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
      <form onSubmit={submit} noValidate className="space-y-4" aria-label="CQ generation settings">
        <fieldset className="rounded-2xl border bg-card p-4 shadow-card">
          <legend className="px-1 text-sm font-semibold">Mode</legend>
          <div className="grid gap-2">
            {MODES.map((m) => (
              <div key={m.value}>
                <input id={`cq-mode-${m.value}`} type="radio" name="cq-mode" value={m.value} checked={form.mode === m.value} onChange={() => set("mode", m.value)} className="peer sr-only" aria-describedby={`cq-mode-${m.value}-d`} />
                <label htmlFor={`cq-mode-${m.value}`} className="flex min-h-11 cursor-pointer flex-col gap-1 rounded-xl border bg-background p-3 text-sm transition peer-checked:border-primary peer-checked:bg-accent peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50">
                  <span className="font-medium">{m.title}</span>
                  <span id={`cq-mode-${m.value}-d`} className="text-xs text-muted-foreground">{m.text}</span>
                </label>
              </div>
            ))}
          </div>
        </fieldset>

        <Card className="rounded-2xl shadow-card">
          <CardHeader>
            <CardTitle className="text-base">1. Where should the questions come from?</CardTitle>
            <CardDescription>Type a topic or subject, paste text, pick your documents — or combine them.</CardDescription>
          </CardHeader>
          <CardContent><SourceFields idPrefix="cq" value={form.sources} onChange={(v) => set("sources", v)} errors={errors} limits={limits} /></CardContent>
        </Card>

        <Card className="rounded-2xl shadow-card">
          <CardHeader><CardTitle className="text-base">2. Question structure</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Segmented legend="Structure" name="cq-structure" value={form.structure} onChange={(v) => setForm((f) => ({ ...f, structure: v, customMarks: null }))} options={STRUCTURES.map((s) => ({ value: s.value, label: s.label, hint: s.hint }))} />
              <p className="mt-1.5 text-xs text-muted-foreground">{STRUCTURES.find((s) => s.value === form.structure)?.hint} Pick what suits your subject and curriculum.</p>
            </div>
            {form.structure === "stimulus_4part" && (
              <div className="rounded-xl bg-accent/50 p-3 text-xs" lang={form.language}>
                <p className="mb-1 font-medium">Parts</p>
                <ol className="space-y-0.5">{LEVELS.map((l, i) => <li key={l}>{partLabel(i, form.language)}) {LEVEL_LABEL[form.language][l]}</li>)}</ol>
              </div>
            )}
            {form.structure === "multipart" && (
              <Field label="Number of parts" htmlFor="cq-partCount" error={errors.partCount} hint={`2 to ${limits.parts}.`}>
                <NumberInput id="cq-partCount" value={form.partCount} min={2} max={limits.parts} invalid={Boolean(errors.partCount)} onChange={(n) => setForm((f) => ({ ...f, partCount: n, customMarks: null }))} />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Total marks" htmlFor="cq-totalMarks" error={errors.totalMarks}>
                <NumberInput id="cq-totalMarks" value={form.totalMarks} min={1} max={100} step={0.5} invalid={Boolean(errors.totalMarks)} onChange={(n) => setForm((f) => ({ ...f, totalMarks: n, customMarks: null }))} />
              </Field>
              <Field label="Number of questions" htmlFor="cq-count" error={errors.count} hint={`Up to ${limits.cqMaxQuestions}.`}>
                <NumberInput id="cq-count" value={form.count} min={1} max={limits.cqMaxQuestions} invalid={Boolean(errors.count)} describedBy={errors.count ? "cq-count-err" : "cq-count-hint"} onChange={(n) => set("count", n)} />
              </Field>
            </div>
            {marks && (
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium">Marks per part</legend>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  {marks.map((m, i) => (
                    <NumberInput key={i} aria-label={`Marks for part ${partLabel(i, form.language)}`} value={m} min={0.5} step={0.5} invalid={Boolean(errors.partMarks)} onChange={(n) => set("customMarks", marks.map((x, j) => (j === i ? n : x)))} />
                  ))}
                </div>
                <FieldError>{errors.partMarks}</FieldError>
              </fieldset>
            )}
            <div>
              <Segmented legend="Stimulus" name="cq-stimulus" value={effectiveStimulus(form)} onChange={(v) => set("stimulusChoice", v)}
                options={[
                  { value: "required", label: "Required", disabled: false },
                  { value: "optional", label: "If helpful", disabled: Boolean(forced), disabledReason: "A 4-part CQ always has a stimulus." },
                  { value: "none", label: "None", disabled: Boolean(forced), disabledReason: "A 4-part CQ always has a stimulus." },
                ]} />
              {forced && <p className="mt-1 text-xs text-muted-foreground">A 4-part CQ always starts with a stimulus.</p>}
            </div>
            <Segmented legend="Difficulty" name="cq-difficulty" value={form.difficulty} onChange={(v) => set("difficulty", v)} options={(Object.keys(DIFFICULTY_SETTING_LABEL) as DifficultySetting[]).map((d) => ({ value: d, label: DIFFICULTY_SETTING_LABEL[d] }))} />
            <Segmented legend="Output language" name="cq-language" value={form.language} onChange={(v) => set("language", v)} options={(Object.keys(LANGUAGE_LABEL) as Language[]).map((l) => ({ value: l, label: LANGUAGE_LABEL[l] }))} />
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-card">
          <CardHeader><CardTitle className="text-base">3. Grounding and model</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <GroundingField idPrefix="cq" value={settings.grounding} onChange={(g) => set("groundingChoice", g)} hasSources={hasSources(settings)} error={errors.grounding} />
            {form.mode === "WITH_ANSWERS" && <p className={cn("rounded-xl bg-muted/50 p-3 text-xs text-muted-foreground")}>Answers follow this policy: with “Source only”, a part your sources can&apos;t answer is marked <strong>Insufficient evidence</strong> rather than answered from general knowledge.</p>}
            <ModelField configured={configured} task="CQ" override={form.override} onOverride={(m) => set("override", m)} />
          </CardContent>
        </Card>

        <Button type="submit" size="lg" className="h-11 w-full rounded-xl" disabled={gen.busy || noModel}>
          {gen.busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />} {gen.busy ? "Generating…" : "Generate CQs"}
        </Button>
        {noModel && <p className="text-center text-xs text-muted-foreground">Choose a model above to enable generation.</p>}
      </form>

      <div className="min-w-0 space-y-4">
        {gen.status && <GenerationProgress status={gen.status} onStop={gen.stop} />}
        {gen.stopped && !gen.busy && <p role="status" className="rounded-xl border bg-muted/40 p-3 text-sm">Generation stopped. Nothing was saved.</p>}
        {gen.error && <GenerationError error={gen.error} grounding={(last ?? settings).grounding} onDismiss={gen.clearError} onRetry={last ? () => void gen.start(last) : undefined} />}
        {gen.run && (
          <ReviewWorkspace key={gen.run.id} run={gen.run} limits={limits} withAnswers={(gen.run.settings as CqSettings).mode === "WITH_ANSWERS"} generating={gen.busy} title={form.sources.topic.trim() || "CQ set"}
            onRegenerateAll={() => { gen.clearRun(); void gen.start(last ?? settings); }} />
        )}
        {!gen.run && !gen.busy && !gen.error && !gen.stopped && (
          <div className="rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center">
            <span className="mx-auto mb-3 inline-flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground"><Sparkles className="size-5" aria-hidden /></span>
            <h2 className="text-base font-semibold">Your CQs will appear here</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">CQ sets are for study and practice, so there is no timer. Edit, save, copy, print or export them when you&apos;re happy.</p>
          </div>
        )}
        <RecentRuns kind="CQ" currentId={gen.run?.id} onOpen={(id) => void gen.open(id)} />
      </div>
    </div>
  );
}
