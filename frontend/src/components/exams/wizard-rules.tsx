"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Field, NumberInput, Segmented, SwitchRow } from "@/components/questions/fields";
import {
  isoToLocalInput, LATE_START_TEXT, localInputToIso, RELEASE_TEXT, REVIEW_POLICY_TEXT,
  type ExamDraftInput, type ExamLimits, type ExamMode, type LateStart, type ReleaseMode, type ReviewPolicy,
} from "@/lib/exams";
import { useT } from "@/lib/i18n/client";

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-card sm:p-5">
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function DateTimeField({ label, id, value, onChange, error, hint }: { label: string; id: string; value: string | null; onChange: (iso: string | null) => void; error?: string | undefined; hint?: string }) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <Input id={id} type="datetime-local" value={isoToLocalInput(value)} onChange={(e) => onChange(localInputToIso(e.target.value))} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-err` : hint ? `${id}-hint` : undefined} className="h-10 rounded-xl" />
    </Field>
  );
}

export function RulesStep({ draft, setDraft, limits, errors, mode }: { draft: ExamDraftInput; setDraft: (fn: (d: ExamDraftInput) => ExamDraftInput) => void; limits: ExamLimits; errors: Record<string, string>; mode: ExamMode }) {
  const t = useT();
  const uid = useId();
  const set = (patch: Partial<ExamDraftInput>) => setDraft((d) => ({ ...d, ...patch }));
  const hasClose = Boolean(draft.window.closesAt);
  const hasOpen = Boolean(draft.window.opensAt);
  const negativePct = Math.round(draft.negativeMarking.fraction * 10000) / 100;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <Card title={t("Marks and scoring")} description={t("Scores are calculated by the server from your answer key — never by the browser.")}>
          <Field label={t("Marks per question")} htmlFor={`${uid}-marks`} error={errors["marks.perQuestion"]} hint={t("Individual questions can get their own marks in the Questions step.")}>
            <NumberInput id={`${uid}-marks`} value={draft.marks.perQuestion} onChange={(v) => setDraft((d) => ({ ...d, marks: { ...d.marks, perQuestion: v } }))} min={0.25} max={100} step={0.25} invalid={Boolean(errors["marks.perQuestion"])} describedBy={errors["marks.perQuestion"] ? `${uid}-marks-err` : undefined} />
          </Field>
          <Field label={t("Negative marking: lose this % of a question's marks for a wrong answer")} htmlFor={`${uid}-neg`} error={errors["negativeMarking.fraction"]} hint={negativePct === 0 ? t("0 = no negative marking. Unanswered questions always score 0. A total score never goes below 0.") : t("A wrong answer loses {pct}% of its marks. Unanswered questions score 0 and the total never goes below 0.", { pct: negativePct })}>
            <NumberInput id={`${uid}-neg`} value={negativePct} onChange={(v) => setDraft((d) => ({ ...d, negativeMarking: { fraction: Number.isFinite(v) ? Math.round(v * 100) / 10000 : Number.NaN } }))} min={0} max={100} step={5} invalid={Boolean(errors["negativeMarking.fraction"])} describedBy={errors["negativeMarking.fraction"] ? `${uid}-neg-err` : `${uid}-neg-hint`} />
          </Field>
        </Card>

        <Card title={t("Time and attempts")}>
          <Field label={t("Duration (minutes)")} htmlFor={`${uid}-dur`} error={errors.durationMinutes} hint={t("Up to {max} minutes. The server keeps the clock.", { max: limits.maxDurationMinutes })}>
            <NumberInput id={`${uid}-dur`} value={draft.durationMinutes} onChange={(v) => set({ durationMinutes: v })} min={1} max={limits.maxDurationMinutes} invalid={Boolean(errors.durationMinutes)} describedBy={errors.durationMinutes ? `${uid}-dur-err` : `${uid}-dur-hint`} />
          </Field>
          <Field label={t("Attempts allowed per person")} htmlFor={`${uid}-att`} error={errors.attemptLimit} hint={t("1 to {max}. With several attempts, the best one counts for rankings.", { max: limits.maxAttemptLimit })}>
            <NumberInput id={`${uid}-att`} value={draft.attemptLimit} onChange={(v) => set({ attemptLimit: v })} min={1} max={limits.maxAttemptLimit} invalid={Boolean(errors.attemptLimit)} describedBy={errors.attemptLimit ? `${uid}-att-err` : `${uid}-att-hint`} />
          </Field>
        </Card>

        <Card title={t("Availability window (optional)")} description={t("Without a window the exam can be started any time until you cancel it. Times are in your local time zone.")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <DateTimeField label={t("Opens")} id={`${uid}-open`} value={draft.window.opensAt} onChange={(v) => setDraft((d) => ({ ...d, window: { ...d.window, opensAt: v } }))} error={errors["window.opensAt"]} />
            <DateTimeField label={t("Closes")} id={`${uid}-close`} value={draft.window.closesAt} onChange={(v) => setDraft((d) => ({ ...d, window: { ...d.window, closesAt: v } }))} error={errors["window.closesAt"]} />
          </div>
          {hasClose && (
            <Segmented<LateStart> legend={t("If someone starts late")} name={`${uid}-late`} value={draft.lateStart} onChange={(v) => set({ lateStart: v })}
              options={(Object.keys(LATE_START_TEXT) as LateStart[]).map((k) => ({ value: k, label: t(LATE_START_TEXT[k].label), hint: t(LATE_START_TEXT[k].hint) }))} />
          )}
          {hasClose && <p className="text-xs text-muted-foreground">{t(LATE_START_TEXT[draft.lateStart].hint)}</p>}
          {hasOpen && (
            <Field label={t("Reminder (minutes before it opens, optional)")} htmlFor={`${uid}-rem`} error={errors.reminderMinutes} hint={t("Participants get an in-app notification. No e-mail is sent.")}>
              <NumberInput id={`${uid}-rem`} value={draft.reminderMinutes ?? Number.NaN} onChange={(v) => set({ reminderMinutes: Number.isNaN(v) ? null : v })} min={1} max={10080} invalid={Boolean(errors.reminderMinutes)} />
            </Field>
          )}
        </Card>
      </div>

      <div className="space-y-5">
        <Card title={t("Order")} description={t("Each person gets their own order, derived from the published exam — the questions and answers are identical for everyone.")}>
          <SwitchRow label={t("Shuffle the order of questions")} checked={draft.shuffleQuestions} onChange={(v) => set({ shuffleQuestions: v })} />
          <SwitchRow label={t("Shuffle the order of answer options")} checked={draft.shuffleOptions} onChange={(v) => set({ shuffleOptions: v })} />
        </Card>

        <Card title={t("After the exam")}>
          <Segmented<ReviewPolicy> legend={t("What participants can review")} name={`${uid}-review`} value={draft.reviewPolicy} onChange={(v) => set({ reviewPolicy: v })}
            options={(Object.keys(REVIEW_POLICY_TEXT) as ReviewPolicy[]).map((k) => ({ value: k, label: t(REVIEW_POLICY_TEXT[k].label), hint: t(REVIEW_POLICY_TEXT[k].hint) }))} />
          <p className="text-xs text-muted-foreground">{t(REVIEW_POLICY_TEXT[draft.reviewPolicy].hint)}</p>
          <Segmented<ReleaseMode> legend={t("When results are released")} name={`${uid}-release`} value={draft.release.mode} onChange={(v) => setDraft((d) => ({ ...d, release: { mode: v, at: v === "AT_TIME" ? d.release.at : null } }))}
            options={(Object.keys(RELEASE_TEXT) as ReleaseMode[]).map((k) => ({ value: k, label: t(RELEASE_TEXT[k].label), hint: t(RELEASE_TEXT[k].hint), disabled: k === "AFTER_CLOSE" && !hasClose, disabledReason: t("Set a closing time first.") }))} />
          <p className="text-xs text-muted-foreground">{t(RELEASE_TEXT[draft.release.mode].hint)}</p>
          {errors["release.mode"] && <p role="alert" className="text-xs font-medium text-destructive">{t(errors["release.mode"])}</p>}
          {draft.release.mode === "AT_TIME" && <DateTimeField label={t("Release time")} id={`${uid}-relat`} value={draft.release.at} onChange={(v) => setDraft((d) => ({ ...d, release: { ...d.release, at: v } }))} error={errors["release.at"]} />}
          {mode === "GROUP" && draft.release.mode === "IMMEDIATE" && draft.reviewPolicy === "FULL" && (
            <p role="note" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-xs">{t("With immediate release and a full review, people who finish early can see the correct answers while others are still taking the exam. Consider releasing after the exam closes.")}</p>
          )}
        </Card>

        {mode === "GROUP" && (
          <Card title={t("Group settings")}>
            <SwitchRow label={t("Members who join after publication can take it")} description={t("Off: only people who are already in the group when you publish are eligible.")} checked={draft.lateJoinGroup} onChange={(v) => set({ lateJoinGroup: v })} />
            <SwitchRow label={t("Show the leaderboard to members")} description={t("When off, only you and group admins see rankings (after results are released).")} checked={draft.leaderboardVisible} onChange={(v) => set({ leaderboardVisible: v })} />
          </Card>
        )}
      </div>
    </div>
  );
}
