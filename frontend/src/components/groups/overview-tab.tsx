"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/questions/bank/bank-dialogs";
import { SwitchRow } from "@/components/questions/fields";
import { ApiError, apiSend } from "@/lib/api";
import { canLeave, describeGroupError, type GroupDetail } from "@/lib/groups";
import { useI18n } from "@/lib/i18n/client";

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "ERROR", "Something went wrong. Please try again."));

export function OverviewTab({ group }: { group: GroupDetail }) {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The switch shows the SERVER's value: it only flips after the request is confirmed.
  const privacy = useMutation({
    mutationFn: (show: boolean) => apiSend("PATCH", `/api/groups/${group.id}/me`, { showNameOnLeaderboard: show }),
    onSuccess: (_r, show) => {
      void qc.invalidateQueries({ queryKey: ["group", group.id] });
      toast.success(show ? t("Your name will show on leaderboards") : t("You'll appear as “Anonymous participant” to others"));
    },
    onError: (e) => toast.error(describeGroupError(asError(e), "generic", t)),
  });
  const leave = useMutation({
    mutationFn: () => apiSend("POST", `/api/groups/${group.id}/leave`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["groups"] });
      toast.success(t("You left the group"));
      router.push("/groups");
    },
    onError: (e) => { setError(describeGroupError(asError(e), "generic", t)); setLeaving(false); },
  });
  const shown = privacy.isPending ? (privacy.variables ?? group.showNameOnLeaderboard) : group.showNameOnLeaderboard;
  const pct = group.capacity ? Math.min(100, Math.round((group.memberCount / group.capacity) * 100)) : 0;

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
      <section className="rounded-2xl border bg-card p-5 shadow-card" aria-labelledby="ov-about">
        <h2 id="ov-about" className="text-base font-semibold">{t("About this group")}</h2>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{group.description || t("No description yet.")}</p>
        <div className="mt-5">
          <div className="flex items-center justify-between text-sm"><span className="font-medium">{t("Capacity")}</span><span className="text-muted-foreground">{t("{count} of {capacity}", { count: group.memberCount, capacity: group.capacity })}</span></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t("Group capacity used")} aria-valuemin={0} aria-valuemax={group.capacity} aria-valuenow={group.memberCount}><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
          {group.memberCount >= group.capacity && <p className="mt-2 text-xs text-muted-foreground">{t("The group is full: new people can't join until someone leaves or the capacity is raised.")}</p>}
        </div>
      </section>
      <section className="space-y-3 rounded-2xl border bg-card p-5 shadow-card" aria-labelledby="ov-privacy">
        <h2 id="ov-privacy" className="text-base font-semibold">{t("Your privacy")}</h2>
        <SwitchRow label={t("Show my name on leaderboards")} description={t("When off, other members see “Anonymous participant”. You always see your own name. Members never see your e-mail or anything outside this group's exams.")} checked={shown} onChange={(v) => privacy.mutate(v)} disabled={privacy.isPending} />
        {canLeave(group.role) ? (
          <>
            <Button variant="outline" className="rounded-xl" onClick={() => setLeaving(true)}><LogOut aria-hidden /> {t("Leave group")}</Button>
            {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          </>
        ) : <p className="text-xs text-muted-foreground">{t("You own this group, so you can't leave it. You can delete it in Settings.")}</p>}
      </section>
      <ConfirmDialog open={leaving} onOpenChange={setLeaving} title={t("Leave this group?")} description={t("You'll lose access to its exams and leaderboards, and your results will no longer appear to the group. You can rejoin with a new invitation.")} confirmLabel={t("Leave group")} pending={leave.isPending} onConfirm={() => leave.mutate()} />
    </div>
  );
}
