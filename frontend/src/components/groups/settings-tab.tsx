"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, NumberInput } from "@/components/questions/fields";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { describeGroupError, GROUP_FIELD, resolveGroupLimits, type GroupDetail } from "@/lib/groups";
import { useI18n } from "@/lib/i18n/client";

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "ERROR", "Something went wrong. Please try again."));

export function SettingsTab({ group }: { group: GroupDetail }) {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const limits = useQuery({ queryKey: ["exam-limits"], queryFn: async () => resolveGroupLimits(await apiGet("/api/exams/limits")), retry: false }).data ?? resolveGroupLimits(null);
  const [title, setTitle] = useState(group.title);
  const [description, setDescription] = useState(group.description ?? "");
  const [capacity, setCapacity] = useState(group.capacity);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");

  const titleError = !title.trim() ? t("Give the group a name.") : title.trim().length > GROUP_FIELD.title ? t("Use at most {max} characters.", { max: GROUP_FIELD.title }) : undefined;
  const capError = !Number.isInteger(capacity) || capacity < Math.max(2, group.memberCount) || capacity > limits.groupMaxCapacity
    ? t("Choose a whole number from {min} (current members) to {max}.", { min: Math.max(2, group.memberCount), max: limits.groupMaxCapacity }) : undefined;
  const descError = description.length > GROUP_FIELD.description ? t("Use at most {max} characters.", { max: GROUP_FIELD.description }) : undefined;
  const dirty = title.trim() !== group.title || (description.trim() || null) !== group.description || capacity !== group.capacity;

  const save = useMutation({
    mutationFn: () => apiSend("PATCH", `/api/groups/${group.id}`, { title: title.trim(), description: description.trim() || null, capacity }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["group", group.id] }); void qc.invalidateQueries({ queryKey: ["groups"] }); toast.success(t("Group updated")); },
    onError: (e) => { const err = asError(e); setServerErrors(err.fields); setError(Object.keys(err.fields).length ? null : describeGroupError(err, "generic", t)); },
  });
  const del = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/groups/${group.id}`, { confirmTitle: group.title }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["groups"] }); toast.success(t("Group deleted")); router.push("/groups"); },
    onError: (e) => { setDeleting(false); setError(describeGroupError(asError(e), "generic", t)); },
  });

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <form noValidate className="space-y-4 rounded-2xl border bg-card p-5 shadow-card" onSubmit={(e) => { e.preventDefault(); setTouched(true); setError(null); setServerErrors({}); if (!titleError && !capError && !descError) save.mutate(); }} aria-labelledby="set-h">
        <h2 id="set-h" className="text-base font-semibold">{t("Group details")}</h2>
        <Field label={t("Group name")} htmlFor="set-title" error={(touched ? titleError : undefined) ?? serverErrors.title}><Input id="set-title" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" className="h-10 rounded-xl" /></Field>
        <Field label={t("Description")} htmlFor="set-desc" error={descError ?? serverErrors.description}><Textarea id="set-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="rounded-xl" /></Field>
        <Field label={t("Member capacity")} htmlFor="set-cap" hint={t("Can't be lower than the number of current members.")} error={(touched ? capError : undefined) ?? serverErrors.capacity}><NumberInput id="set-cap" value={capacity} onChange={setCapacity} min={Math.max(2, group.memberCount)} max={limits.groupMaxCapacity} invalid={Boolean(touched && capError)} /></Field>
        {error && !deleting && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
        <Button type="submit" className="rounded-xl" disabled={save.isPending || !dirty}>{save.isPending && <Loader2 className="animate-spin" aria-hidden />} {t("Save changes")}</Button>
      </form>
      <section className="space-y-3 rounded-2xl border border-destructive/30 bg-card p-5 shadow-card" aria-labelledby="del-h">
        <h2 id="del-h" className="text-base font-semibold">{t("Delete this group")}</h2>
        <p className="text-sm text-muted-foreground">{t("Deleting removes every member, invitation, group exam, attempt and result for this group. This can't be undone.")}</p>
        <Button variant="destructive" className="rounded-xl" onClick={() => { setTyped(""); setDeleting(true); }}><Trash2 aria-hidden /> {t("Delete group…")}</Button>
      </section>
      <Dialog open={deleting} onOpenChange={(o) => !del.isPending && setDeleting(o)}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); if (typed === group.title) del.mutate(); }} className="space-y-4">
            <DialogHeader><DialogTitle>{t("Delete “{title}”?", { title: group.title })}</DialogTitle><DialogDescription>{t("Type the group name to confirm. All of its exams and results will be permanently deleted.")}</DialogDescription></DialogHeader>
            <Field label={t("Group name")} htmlFor="del-confirm"><Input id="del-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="h-10 rounded-xl" /></Field>
            {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => setDeleting(false)} disabled={del.isPending}>{t("Cancel")}</Button>
              <Button type="submit" variant="destructive" className="rounded-xl" disabled={typed !== group.title || del.isPending}>{del.isPending && <Loader2 className="animate-spin" aria-hidden />} {t("Delete group")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
