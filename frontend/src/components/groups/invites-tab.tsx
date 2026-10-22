"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CheckCircle2, Clock, Plus, UserCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/questions/bank/bank-dialogs";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { describeGroupError, INVITE_STATUS_LABEL, inviteUsage, readInvite, readList, resolveGroupLimits, type CreatedInvite, type GroupDetail, type InviteStatus, type InviteView } from "@/lib/groups";
import { InviteCreatedPanel } from "./invite-created-panel";
import { InviteDialog } from "./invite-dialog";
import { useI18n } from "@/lib/i18n/client";

const ICON: Record<InviteStatus, typeof Clock> = { ACTIVE: CheckCircle2, EXPIRED: Clock, REVOKED: Ban, USED_UP: UserCheck };
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "ERROR", "Something went wrong. Please try again."));

export function InvitesTab({ group }: { group: GroupDetail }) {
  const { t, format } = useI18n();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [revoking, setRevoking] = useState<InviteView | null>(null);
  const limitsQ = useQuery({ queryKey: ["exam-limits"], queryFn: async () => resolveGroupLimits(await apiGet("/api/exams/limits")), retry: false });
  const invites = useQuery({ queryKey: ["group", group.id, "invites"], queryFn: async () => readList(await apiGet(`/api/groups/${group.id}/invites`), readInvite).items });
  const revoke = useMutation({
    mutationFn: (i: InviteView) => apiSend("DELETE", `/api/groups/${group.id}/invites/${encodeURIComponent(i.id)}`),
    onSuccess: () => { setRevoking(null); void qc.invalidateQueries({ queryKey: ["group", group.id, "invites"] }); toast.success(t("Invitation revoked")); },
    onError: (e) => { setRevoking(null); toast.error(describeGroupError(asError(e), "generic", t)); },
  });

  return (
    <div className="mt-4 space-y-4">
      {created && <InviteCreatedPanel created={created} onDismiss={() => setCreated(null)} />}
      <section className="rounded-2xl border bg-card shadow-card" aria-labelledby="inv-h">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
          <div><h2 id="inv-h" className="text-base font-semibold">{t("Invitations")}</h2><p className="text-xs text-muted-foreground">{t("Codes can't be shown again after creation; revoke any you no longer want to be usable.")}</p></div>
          <Button className="rounded-xl" onClick={() => setCreating(true)}><Plus aria-hidden /> {t("New invitation")}</Button>
        </div>
        {invites.isLoading && <div className="space-y-2 p-5"><Skeleton className="h-12 rounded-xl" /></div>}
        {invites.isError && <p role="alert" className="p-5 text-sm text-destructive">{describeGroupError(asError(invites.error), "generic", t)}</p>}
        {invites.data && invites.data.length === 0 && <p className="p-5 text-sm text-muted-foreground">{t("No invitations yet. Create one to bring people into the group.")}</p>}
        {invites.data && invites.data.length > 0 && (
          <ul className="divide-y" data-testid="invite-list">
            {invites.data.map((i) => {
              const Icon = ICON[i.status];
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3" data-testid="invite-row">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"><Icon className="size-3.5" aria-hidden /> {t(INVITE_STATUS_LABEL[i.status])}</span>
                      <span className="font-mono text-xs text-muted-foreground">…{i.codeHint}</span>
                      {i.forEmail && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><UserRound className="size-3.5" aria-hidden /> {t("One specific person")}</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{inviteUsage(i, t)} · {i.status === "EXPIRED" ? t("expired") : t("expires")} <time dateTime={i.expiresAt}>{format.dateTime(i.expiresAt)}</time></p>
                  </div>
                  {i.status === "ACTIVE" && <Button variant="outline" size="sm" className="rounded-xl" onClick={() => setRevoking(i)} aria-label={t("Revoke invitation ending {hint}", { hint: i.codeHint })}>{t("Revoke")}</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {creating && <InviteDialog open={creating} onOpenChange={setCreating} groupId={group.id} limits={limitsQ.data ?? resolveGroupLimits(null)} onCreated={(c) => { setCreated(c); void qc.invalidateQueries({ queryKey: ["group", group.id, "invites"] }); }} />}
      <ConfirmDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)} title={t("Revoke this invitation?")} description={t("Nobody will be able to join with it any more. People who already joined stay in the group.")} confirmLabel={t("Revoke invitation")} pending={revoke.isPending} onConfirm={() => revoking && revoke.mutate(revoking)} />
    </div>
  );
}
