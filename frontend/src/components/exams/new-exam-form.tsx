"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, User, Users } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiSend } from "@/lib/api";
import { Field, Segmented } from "@/components/questions/fields";
import { describeExamError, type ExamMode, type ExamSummary } from "@/lib/exams";
import { useManageableGroups } from "./use-my-groups";
import { useT } from "@/lib/i18n/client";

export function NewExamForm({ initialGroupId }: { initialGroupId?: string | null }) {
  const t = useT();
  const router = useRouter();
  const groups = useManageableGroups();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<ExamMode>(initialGroupId ? "GROUP" : "INDIVIDUAL");
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const available = groups.data ?? [];
  const noGroups = !groups.isLoading && available.length === 0;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const local: Record<string, string> = {};
    if (!title.trim()) local.title = t("Give the exam a title.");
    if (mode === "GROUP" && !groupId) local.groupId = t("Choose the group this exam is for.");
    setFields(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const res = await apiSend<{ exam: ExamSummary }>("POST", "/api/exams", { title: title.trim(), description: description.trim() || null, mode, ...(mode === "GROUP" ? { groupId } : {}) });
      router.push(`/exams/${res.exam.id}/edit?step=questions`);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        setFields(err.fields);
        setError(Object.keys(err.fields).length ? null : `${describeExamError(err.code, err.message, t).title}. ${t(err.message)}`);
      } else setError(t("Couldn't reach the server."));
    }
  }

  return (
    <form onSubmit={create} noValidate className="mx-auto max-w-2xl space-y-5 rounded-2xl border bg-card p-5 shadow-card sm:p-7" aria-label={t("New exam")}>
      <div>
        <h2 className="text-lg font-semibold">{t("Exam details")}</h2>
        <p className="text-sm text-muted-foreground">{t("Step 1 of 4. You'll pick questions and set the rules next; everything is saved as a draft until you publish.")}</p>
      </div>
      <Field label={t("Title")} htmlFor="exam-title" error={fields.title}>
        <Input id="exam-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-invalid={Boolean(fields.title) || undefined} aria-describedby={fields.title ? "exam-title-err" : undefined} className="h-10 rounded-xl" placeholder={t("e.g. Cell biology — chapter test")} />
      </Field>
      <Field label={t("Description (optional)")} htmlFor="exam-desc" hint={t("Shown to participants before they start.")} error={fields.description}>
        <Textarea id="exam-desc" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} className="min-h-20 rounded-xl" />
      </Field>
      <Segmented<ExamMode>
        legend={t("Who takes this exam?")}
        name="exam-mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: "INDIVIDUAL", label: t("Just me (practice)"), hint: t("A self-assessment you can take yourself.") },
          { value: "GROUP", label: t("A group"), hint: t("Everyone in the group takes the same questions."), disabled: noGroups, disabledReason: t("You need to own or administer a group first.") },
        ]}
      />
      {mode === "INDIVIDUAL"
        ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><User className="size-4" aria-hidden /> {t("An individual exam is taken by you. Results are private.")}</p>
        : (
          <Field label={t("Group")} htmlFor="exam-group" error={fields.groupId}>
            <select id="exam-group" value={groupId} onChange={(e) => setGroupId(e.target.value)} className="h-10 w-full rounded-xl border bg-background px-3 text-sm" aria-invalid={Boolean(fields.groupId) || undefined}>
              <option value="">{t("Choose a group…")}</option>
              {available.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
            </select>
          </Field>
        )}
      {noGroups && <p className="flex items-start gap-2 text-xs text-muted-foreground"><Users className="mt-0.5 size-3.5" aria-hidden /> {t("Group exams need a group you own or administer.")} <Link href="/groups" className="text-primary underline">{t("Create or manage groups")}</Link>.</p>}
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex justify-end">
        <Button type="submit" className="rounded-xl" disabled={busy}>{busy ? <><Loader2 className="animate-spin" aria-hidden /> {t("Creating…")}</> : t("Continue to questions")}</Button>
      </div>
    </form>
  );
}
