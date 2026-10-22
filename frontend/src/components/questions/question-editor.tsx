"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  addOption, DIFFICULTY_LABEL, LEVEL_LABEL, LEVELS, moveItem, newId, optionLabel, partLabel, removeOption, sumMarks,
  type CqLevel, type Difficulty, type FieldErrors, type Limits, type QuestionContent,
} from "@/lib/questions";
import { Field, FieldError, NumberInput } from "./fields";
import { isInsufficient } from "@/lib/questions";

type EditorProps = {
  q: QuestionContent;
  onChange: (next: QuestionContent) => void;
  errors: FieldErrors;
  limits: Limits;
  idPrefix: string;
  /** CQ only: show model-answer boxes even where there is no answer yet (off for "questions only" sets). */
  withAnswers?: boolean;
};

const iconBtn = "min-h-11 min-w-11 sm:min-h-8 sm:min-w-8";
const nullable = (s: string) => (s === "" ? null : s);

function TagsInput({ tags, onChange, id, error }: { tags: string[]; onChange: (t: string[]) => void; id: string; error?: string }) {
  const [text, setText] = useState(tags.join(", "));
  return (
    <>
      <Input
        id={id}
        value={text}
        placeholder="comma, separated"
        className="h-10 rounded-xl"
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          onChange([...new Set(e.target.value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))]);
        }}
      />
      <FieldError>{error}</FieldError>
    </>
  );
}

/** Difficulty, subject, topic, tags and marks, shared by both editors. */
function MetaFields({ q, onChange, errors, idPrefix, marksEditable }: EditorProps & { marksEditable: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-difficulty`}>Difficulty</Label>
        <Select value={q.difficulty} onValueChange={(v) => onChange({ ...q, difficulty: v as Difficulty })}>
          <SelectTrigger id={`${idPrefix}-difficulty`} className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => <SelectItem key={d} value={d}>{DIFFICULTY_LABEL[d]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Field label="Subject" htmlFor={`${idPrefix}-subject`} error={errors.subject}>
        <Input id={`${idPrefix}-subject`} value={q.subject ?? ""} onChange={(e) => onChange({ ...q, subject: nullable(e.target.value) })} className="h-10 rounded-xl" />
      </Field>
      <Field label="Topic" htmlFor={`${idPrefix}-topic`} error={errors.topic}>
        <Input id={`${idPrefix}-topic`} value={q.topic ?? ""} onChange={(e) => onChange({ ...q, topic: nullable(e.target.value) })} className="h-10 rounded-xl" />
      </Field>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-tags`}>Tags</Label>
        <TagsInput id={`${idPrefix}-tags`} tags={q.tags} onChange={(tags) => onChange({ ...q, tags })} error={errors.tags} />
      </div>
      <Field label="Marks" htmlFor={`${idPrefix}-marks`} error={errors.marks}>
        <NumberInput id={`${idPrefix}-marks`} value={q.marks} min={0} max={100} step={0.25} disabled={!marksEditable} invalid={Boolean(errors.marks)} onChange={(marks) => onChange({ ...q, marks })} />
      </Field>
      {q.kind === "MCQ" && (
        <Field label="Negative marks" htmlFor={`${idPrefix}-neg`} error={errors.negativeMarks} hint="For future exams.">
          <NumberInput id={`${idPrefix}-neg`} value={q.negativeMarks} min={0} max={100} step={0.25} invalid={Boolean(errors.negativeMarks)} onChange={(negativeMarks) => onChange({ ...q, negativeMarks })} />
        </Field>
      )}
    </div>
  );
}

export function McqEditor(props: EditorProps) {
  const { q, onChange, errors, limits, idPrefix } = props;
  const lang = q.language;
  return (
    <div className="space-y-4" lang={lang}>
      <Field label="Question" htmlFor={`${idPrefix}-stem`} error={errors.stem}>
        <Textarea id={`${idPrefix}-stem`} value={q.stem} rows={3} onChange={(e) => onChange({ ...q, stem: e.target.value })} aria-invalid={errors.stem ? true : undefined} className="rounded-xl" />
      </Field>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">Options — select the correct one</legend>
        <ol className="space-y-2">
          {q.options.map((o, i) => {
            const label = optionLabel(i, lang);
            const err = errors[`option:${o.id}`];
            return (
              <li key={o.id}>
                <div className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`${idPrefix}-correct`}
                    checked={q.correctOptionId === o.id}
                    onChange={() => onChange({ ...q, correctOptionId: o.id })}
                    aria-label={`Option ${label} is the correct answer`}
                    className="size-5 shrink-0 accent-[var(--success)]"
                  />
                  <span className="w-5 shrink-0 text-center text-sm font-semibold" aria-hidden>{label}</span>
                  <Input value={o.text} onChange={(e) => onChange({ ...q, options: q.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })} aria-label={`Option ${label} text`} aria-invalid={err ? true : undefined} className="h-10 min-w-0 flex-1 rounded-xl" />
                  <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={i === 0} aria-label={`Move option ${label} up`} onClick={() => onChange({ ...q, options: moveItem(q.options, i, i - 1) })}><ArrowUp aria-hidden /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={i === q.options.length - 1} aria-label={`Move option ${label} down`} onClick={() => onChange({ ...q, options: moveItem(q.options, i, i + 1) })}><ArrowDown aria-hidden /></Button>
                  <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={q.options.length <= limits.minOptions} aria-label={`Remove option ${label}`} onClick={() => onChange(removeOption(q, o.id, limits.minOptions))}><Trash2 aria-hidden /></Button>
                </div>
                <FieldError>{err}</FieldError>
              </li>
            );
          })}
        </ol>
        <FieldError>{errors.options}</FieldError>
        <FieldError>{errors.correctOptionId}</FieldError>
        <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 rounded-full sm:min-h-8" disabled={q.options.length >= limits.maxOptions} onClick={() => onChange(addOption(q, limits.maxOptions))}><Plus aria-hidden /> Add option</Button>
      </fieldset>

      <Field label="Explanation" htmlFor={`${idPrefix}-explanation`} error={errors.explanation}>
        <Textarea id={`${idPrefix}-explanation`} value={q.explanation ?? ""} rows={2} onChange={(e) => onChange({ ...q, explanation: nullable(e.target.value) })} className="rounded-xl" />
      </Field>
      <Field label="Short note" htmlFor={`${idPrefix}-note`} error={errors.shortNote} hint="A concise related fact to revise.">
        <Textarea id={`${idPrefix}-note`} value={q.shortNote ?? ""} rows={2} onChange={(e) => onChange({ ...q, shortNote: nullable(e.target.value) })} className="rounded-xl" />
      </Field>
      <MetaFields {...props} marksEditable />
    </div>
  );
}

export function CqEditor(props: EditorProps) {
  const { q, onChange, errors, limits, idPrefix, withAnswers = true } = props;
  const lang = q.language;
  const setParts = (parts: QuestionContent["parts"]) => onChange({ ...q, parts, marks: parts.length ? sumMarks(parts) : q.marks });
  const patchPart = (id: string, patch: Partial<QuestionContent["parts"][number]>) => setParts(q.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const setAnswerText = (text: string, current: QuestionContent["answer"]) => (text === "" && !current ? null : { text, basis: "USER_PROVIDED" as const, sources: [] });

  return (
    <div className="space-y-4" lang={lang}>
      <Field label="Stimulus (optional)" htmlFor={`${idPrefix}-stimulus`} error={errors.stimulus}>
        <Textarea id={`${idPrefix}-stimulus`} value={q.stimulus ?? ""} rows={4} onChange={(e) => onChange({ ...q, stimulus: nullable(e.target.value) })} className="rounded-xl" />
      </Field>
      <Field label={q.parts.length ? "Lead-in" : "Question"} htmlFor={`${idPrefix}-stem`} error={errors.stem}>
        <Textarea id={`${idPrefix}-stem`} value={q.stem} rows={2} onChange={(e) => onChange({ ...q, stem: e.target.value })} aria-invalid={errors.stem ? true : undefined} className="rounded-xl" />
      </Field>

      {q.parts.length > 0 && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Parts</legend>
          <ol className="space-y-3">
            {q.parts.map((p, i) => {
              const label = p.label ?? partLabel(i, lang);
              const pid = `${idPrefix}-p${i}`;
              return (
                <li key={p.id} className="space-y-2 rounded-xl border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold" aria-hidden>{label}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={i === 0} aria-label={`Move part ${label} up`} onClick={() => setParts(moveItem(q.parts, i, i - 1))}><ArrowUp aria-hidden /></Button>
                      <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} disabled={i === q.parts.length - 1} aria-label={`Move part ${label} down`} onClick={() => setParts(moveItem(q.parts, i, i + 1))}><ArrowDown aria-hidden /></Button>
                      <Button type="button" variant="ghost" size="icon-sm" className={iconBtn} aria-label={`Remove part ${label}`} onClick={() => setParts(q.parts.filter((x) => x.id !== p.id))}><Trash2 aria-hidden /></Button>
                    </div>
                  </div>
                  <Field label={`Part ${label} question`} htmlFor={`${pid}-prompt`} error={errors[`part:${p.id}:prompt`]}>
                    <Textarea id={`${pid}-prompt`} value={p.prompt} rows={2} onChange={(e) => patchPart(p.id, { prompt: e.target.value })} className="rounded-xl" />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Marks" htmlFor={`${pid}-marks`} error={errors[`part:${p.id}:marks`]}>
                      <NumberInput id={`${pid}-marks`} value={p.marks} min={0} max={100} step={0.5} invalid={Boolean(errors[`part:${p.id}:marks`])} onChange={(marks) => patchPart(p.id, { marks })} />
                    </Field>
                    <div className="space-y-1.5">
                      <Label htmlFor={`${pid}-level`}>Level</Label>
                      <Select value={p.level ?? "NONE"} onValueChange={(v) => patchPart(p.id, { level: v === "NONE" ? null : (v as CqLevel) })}>
                        <SelectTrigger id={`${pid}-level`} className="h-10 w-full rounded-xl"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NONE">No level</SelectItem>
                          {LEVELS.map((l) => <SelectItem key={l} value={l}>{LEVEL_LABEL[lang][l]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {(withAnswers || p.answer) && <AnswerField id={`${pid}-answer`} label={`Part ${label} model answer`} answer={p.answer} error={errors[`part:${p.id}:answer`]} onText={(text) => patchPart(p.id, { answer: setAnswerText(text, p.answer) })} />}
                </li>
              );
            })}
          </ol>
          <FieldError>{errors.parts}</FieldError>
          <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 rounded-full sm:min-h-8" disabled={q.parts.length >= limits.parts}
            onClick={() => setParts([...q.parts, { id: newId("p"), label: partLabel(q.parts.length, lang), level: null, prompt: "", marks: 1, answer: null }])}>
            <Plus aria-hidden /> Add part
          </Button>
        </fieldset>
      )}
      {q.parts.length === 0 && (withAnswers || q.answer) && (
        <AnswerField id={`${idPrefix}-answer`} label="Model answer" answer={q.answer} error={errors.answer} onText={(text) => onChange({ ...q, answer: setAnswerText(text, q.answer) })} />
      )}
      <MetaFields {...props} marksEditable={q.parts.length === 0} />
    </div>
  );
}

function AnswerField({ id, label, answer, error, onText }: { id: string; label: string; answer: QuestionContent["answer"]; error?: string; onText: (t: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {isInsufficient(answer) && <p className="text-xs text-muted-foreground">Your sources didn&apos;t contain enough to answer this part, so none was written. You can write one yourself — it will be marked as written by you.</p>}
      <Textarea id={id} value={answer?.text ?? ""} rows={3} onChange={(e) => onText(e.target.value)} aria-invalid={error ? true : undefined} className="rounded-xl" />
      <FieldError>{error}</FieldError>
    </div>
  );
}
