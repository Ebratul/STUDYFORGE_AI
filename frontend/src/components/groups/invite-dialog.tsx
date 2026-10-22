"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, NumberInput } from "@/components/questions/fields";
import { ApiError, apiSend } from "@/lib/api";
import { describeGroupError, GROUP_FIELD, readInvite, ttlOptions, type CreatedInvite, type GroupLimits } from "@/lib/groups";
import { useI18n } from "@/lib/i18n/client";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const selectCls = "h-10 w-full rounded-xl border bg-background px-3 text-sm";

/** Creates an invitation. The server returns the code once; the caller shows it in a one-time panel. */
export function InviteDialog({ open, onOpenChange, groupId, limits, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; groupId: string; limits: GroupLimits; onCreated: (c: CreatedInvite) => void;
}) {
  const { t } = useI18n();
  const ttls = ttlOptions(limits.inviteMaxTtlHours);
  const [hours, setHours] = useState((ttls.find((p) => p.hours === limits.inviteDefaultTtlHours) ?? ttls[ttls.length - 1])?.hours ?? 24);
  const [maxUses, setMaxUses] = useState(Math.min(10, limits.inviteMaxUses));
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const direct = email.trim() !== "";
  const emailError = direct && (!EMAIL.test(email.trim()) || email.trim().length > GROUP_FIELD.email) ? t("Enter a valid e-mail address, or leave it empty for a shareable code.") : undefined;
  const usesError = !direct && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > limits.inviteMaxUses) ? t("Choose a whole number from 1 to {max}.", { max: limits.inviteMaxUses }) : undefined;

  const create = useMutation({
    mutationFn: async (): Promise<CreatedInvite> => {
      const body: Record<string, unknown> = { expiresInHours: hours, ...(direct ? { email: email.trim() } : { maxUses }) };
      const r = await apiSend<{ invite: unknown; code: string; link?: string }>("POST", `/api/groups/${groupId}/invites`, body);
      const link = typeof r.link === "string" && r.link ? (r.link.startsWith("/") ? `${window.location.origin}${r.link}` : r.link) : `${window.location.origin}/join/${encodeURIComponent(r.code)}`;
      return { invite: readInvite(r.invite), code: r.code, link };
    },
    onSuccess: (c) => { onCreated(c); onOpenChange(false); },
    onError: (err) => {
      if (err instanceof ApiError) {
        setServerErrors(err.fields);
        setError(Object.keys(err.fields).length ? null : describeGroupError(err, "generic", t));
      } else setError(t("Something went wrong. Please try again."));
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent>
        <form noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); setError(null); setServerErrors({}); if (!emailError && !usesError) create.mutate(); }} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("Create an invitation")}</DialogTitle>
            <DialogDescription>{t("Anyone with the code can join until it expires or runs out. You'll see the code once, right after creating it.")}</DialogDescription>
          </DialogHeader>
          <Field label={t("Expires after")} htmlFor="inv-ttl" error={serverErrors.expiresInHours}>
            <select id="inv-ttl" value={hours} onChange={(e) => setHours(Number(e.target.value))} className={selectCls}>
              {ttls.map((p) => <option key={p.hours} value={p.hours}>{t(p.label)}</option>)}
            </select>
          </Field>
          <Field label={t("E-mail of a specific person (optional)")} htmlFor="inv-email" hint={t("If they have an account they get an in-app notification with a single-use link. We never reveal whether an address has an account.")} error={(touched ? emailError : undefined) ?? serverErrors.email}>
            <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" className="h-10 rounded-xl" aria-invalid={(touched && emailError) ? true : undefined} />
          </Field>
          <Field label={t("How many people can use it")} htmlFor="inv-uses" hint={direct ? t("A personal invitation is single-use.") : t("Up to {max}.", { max: limits.inviteMaxUses })} error={(touched ? usesError : undefined) ?? serverErrors.maxUses}>
            <NumberInput id="inv-uses" value={direct ? 1 : maxUses} onChange={setMaxUses} min={1} max={limits.inviteMaxUses} disabled={direct} invalid={Boolean(touched && usesError)} />
          </Field>
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)} disabled={create.isPending}>{t("Cancel")}</Button>
            <Button type="submit" className="rounded-xl" disabled={create.isPending}>{create.isPending && <Loader2 className="animate-spin" aria-hidden />} {t("Create invitation")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
