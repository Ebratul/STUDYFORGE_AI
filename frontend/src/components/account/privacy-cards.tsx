"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Download, Loader2, MonitorSmartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiSend } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { passwordSchema } from "@/lib/validation/password";
import { FormField, PasswordField } from "@/components/auth/form-field";
import { useFormat, useRich, useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";

const changeSchema = z
  .object({ currentPassword: z.string().min(1, msg("Enter your current password.")), newPassword: passwordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: msg("Passwords do not match.") })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ["newPassword"], message: msg("Choose a different password.") });

export function ChangePasswordCard() {
  const t = useT();
  const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<z.input<typeof changeSchema>>({
    resolver: zodResolver(changeSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirm: "" },
  });
  async function onSubmit(v: z.input<typeof changeSchema>) {
    const { error } = await authClient.changePassword({ currentPassword: v.currentPassword, newPassword: v.newPassword, revokeOtherSessions: true });
    if (error) {
      if (error.status === 429) toast.error(t("Too many attempts. Please wait a minute."));
      else setError("currentPassword", { message: msg("That password isn't correct.") });
      return;
    }
    toast.success(t("Password updated. Other devices were signed out."));
    reset();
  }
  return (
    <Card className="rounded-2xl shadow-card">
      <form onSubmit={handleSubmit(onSubmit)} noValidate aria-label={t("Change password")}>
        <CardHeader>
          <CardTitle>{t("Password")}</CardTitle>
          <CardDescription>{t("Changing your password signs you out everywhere else.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><PasswordField label={t("Current password")} autoComplete="current-password" error={errors.currentPassword?.message} {...register("currentPassword")} /></div>
          <PasswordField label={t("New password")} autoComplete="new-password" hint={t("At least 10 characters, with a letter and a number.")} error={errors.newPassword?.message} {...register("newPassword")} />
          <PasswordField label={t("Confirm new password")} autoComplete="new-password" error={errors.confirm?.message} {...register("confirm")} />
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" className="rounded-xl" disabled={isSubmitting}>{isSubmitting && <Loader2 className="animate-spin" aria-hidden />} {t("Update password")}</Button>
        </CardFooter>
      </form>
    </Card>
  );
}

type SessionRow = { id: string; userAgent: string | null; createdAt: string; expiresAt: string; current: boolean };

function describeAgent(ua: string | null, t: (m: string, v?: Record<string, string>) => string): string {
  if (!ua) return t("Unknown device");
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  return t("{browser} on {os}", { browser: browser === "Browser" ? t("Browser") : browser, os: os === "Unknown OS" ? t("Unknown OS") : os });
}

export function SessionsCard({ sessions }: { sessions: SessionRow[] }) {
  const t = useT();
  const format = useFormat();
  const router = useRouter();
  const [pending, start] = useTransition();
  const others = sessions.filter((s) => !s.current).length;
  function run(fn: () => Promise<unknown>, ok: string) {
    start(async () => {
      try {
        await fn();
        toast.success(ok);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("Something went wrong."));
      }
      router.refresh();
    });
  }
  return (
    <Card className="rounded-2xl shadow-card">
      <CardHeader>
        <CardTitle>{t("Active sessions")}</CardTitle>
        <CardDescription>{t("Devices currently signed in to your account.")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-xl border">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 p-3">
              <MonitorSmartphone className="size-5 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{describeAgent(s.userAgent, t)} {s.current && <Badge className="ml-1 rounded-full" variant="secondary">{t("This device")}</Badge>}</p>
                <p className="text-xs text-muted-foreground">{t("Signed in {when}", { when: format.dateTime(s.createdAt) })}</p>
              </div>
              {!s.current && (
                <Button size="sm" variant="outline" className="rounded-xl" disabled={pending} onClick={() => run(() => apiSend("DELETE", `/api/sessions/${s.id}`), t("Session revoked"))}>{t("Revoke")}</Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      {others > 0 && (
        <CardFooter className="justify-end">
          <Button variant="outline" className="rounded-xl" disabled={pending} onClick={() => run(() => apiSend("POST", "/api/sessions/revoke-others"), t("Other sessions signed out"))}>{t("Sign out all other devices")}</Button>
        </CardFooter>
      )}
    </Card>
  );
}

export function ExportCard() {
  const t = useT();
  return (
    <Card className="rounded-2xl shadow-card">
      <CardHeader>
        <CardTitle>{t("Your data")}</CardTitle>
        <CardDescription>{t("Download a JSON copy of your profile, preferences, notifications and account activity. Limited to 3 exports per hour.")}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button asChild variant="outline" className="rounded-xl"><a href="/api/account/export" download><Download aria-hidden /> {t("Export my data")}</a></Button>
      </CardFooter>
    </Card>
  );
}

export function DeleteAccountCard({ email }: { email: string }) {
  const t = useT();
  const rich = useRich();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = confirmEmail.trim().toLowerCase() === email.toLowerCase() && password.length > 0;

  async function onDelete() {
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.deleteUser({ password });
    setBusy(false);
    if (err) {
      setError(err.status === 429 ? t("Too many attempts. Please wait a minute.") : t("We couldn't delete the account. Check your password and try again."));
      return;
    }
    router.replace("/?deleted=1");
    router.refresh();
  }

  return (
    <Card className="rounded-2xl border-destructive/30 shadow-card">
      <CardHeader>
        <CardTitle className="text-destructive">{t("Delete account")}</CardTitle>
        <CardDescription>{t("Permanently deletes your account, profile, sessions and notifications. This cannot be undone. Stored files and generated content will be included as those features are added.")}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setConfirmEmail(""); setPassword(""); setError(null); } }}>
          <DialogTrigger asChild><Button variant="destructive" className="rounded-xl"><Trash2 aria-hidden /> {t("Delete my account")}</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("Delete your account?")}</DialogTitle>
              <DialogDescription>{t("This is permanent. Type your email address and enter your password to confirm.")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="confirm-email">{rich("Type {email}", { email: <span className="font-mono">{email}</span> })}</Label>
                <Input id="confirm-email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} autoComplete="off" className="h-10 rounded-xl" />
              </div>
              <FormField label={t("Password")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" error={error ?? undefined} />
            </div>
            <DialogFooter>
              <Button variant="outline" className="rounded-xl" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
              <Button variant="destructive" className="rounded-xl" disabled={!ready || busy} onClick={onDelete}>{busy && <Loader2 className="animate-spin" aria-hidden />} {t("Delete permanently")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  );
}
