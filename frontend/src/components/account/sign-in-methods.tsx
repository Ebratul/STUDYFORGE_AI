"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { GoogleIcon } from "@/components/auth/google-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";
import { googleErrorFor } from "@/lib/google-auth";
import { useFormat, useT } from "@/lib/i18n/client";

export type SignInMethods = { hasPassword: boolean; googleAvailable: boolean; google: { id: string; linkedAt: string } | null };

/**
 * Lists how the account can sign in and lets the signed-in owner connect or disconnect Google.
 * Connecting is always an explicit, authenticated action (the server never links a Google sign-in to an existing account by e-mail alone).
 */
export function SignInMethodsCard({ methods, email }: { methods: SignInMethods; email: string }) {
  const t = useT();
  const format = useFormat();
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState<"link" | "unlink" | "password" | null>(null);
  const onlyMethod = !methods.hasPassword && methods.google !== null;
  const linked = params.get("linked");
  const errorCode = params.get("error");

  // Result of the redirect back from Google (shown once, then removed from the address bar).
  useEffect(() => {
    if (linked !== "google" && !errorCode) return;
    if (linked === "google") toast.success(t("Google is now connected. You can use it to sign in."));
    else {
      const e = googleErrorFor(errorCode);
      if (e) (e.tone === "info" ? toast.info : toast.error)(t(e.message));
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("linked");
    url.searchParams.delete("error");
    url.searchParams.delete("error_description");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [linked, errorCode, t]);

  function failure(status: number | undefined, code: string | undefined) {
    if (status === 429) return t("Too many attempts. Please wait a minute and try again.");
    if (code === "SESSION_NOT_FRESH") return t("For your security, sign out and sign in again, then retry.");
    return t("Something went wrong.");
  }

  // A Google-only account gets a password the same way a forgotten one is reset: a link e-mailed to the account's address.
  async function setPassword() {
    setBusy("password");
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(null);
    if (error?.status === 429) toast.error(t("Too many requests. Please wait a minute and try again."));
    else toast.success(t("If email delivery is set up, a link to choose a password is on its way. It expires in one hour."));
  }

  async function connect() {
    setBusy("link");
    try {
      const { error } = await authClient.linkSocial({ provider: "google", callbackURL: "/settings/privacy?linked=google", errorCallbackURL: "/settings/privacy" });
      if (error) {
        setBusy(null);
        toast.error(failure(error.status, error.code));
      }
    } catch {
      setBusy(null);
      toast.error(t("Something went wrong."));
    }
  }

  async function disconnect() {
    if (!methods.google) return;
    setBusy("unlink");
    const { error } = await authClient.unlinkAccount({ accountId: methods.google.id });
    setBusy(null);
    if (error) {
      toast.error(error.code === "FAILED_TO_UNLINK_LAST_ACCOUNT" ? t("Google is your only way to sign in. Set a password before disconnecting it.") : failure(error.status, error.code));
      return;
    }
    toast.success(t("Google was disconnected."));
    router.refresh();
  }

  return (
    <Card className="rounded-2xl shadow-card">
      <CardHeader>
        <CardTitle>{t("Sign-in methods")}</CardTitle>
        <CardDescription>{t("How you can sign in to StudyForge. Your exams, documents and groups stay the same whichever you use.")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-xl border">
          <li className="flex flex-wrap items-center gap-3 p-3">
            <KeyRound className="size-5 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t("Email and password")}</p>
              <p className="text-xs text-muted-foreground">{methods.hasPassword ? t("A password is set for this account.") : t("No password is set. You sign in with Google.")}</p>
            </div>
            {!methods.hasPassword && (
              <Button size="sm" variant="outline" className="rounded-xl" disabled={busy !== null} onClick={setPassword}>
                {busy === "password" && <Loader2 className="animate-spin" aria-hidden />} {t("Email me a link to set one")}
              </Button>
            )}
          </li>
          {(methods.google || methods.googleAvailable) && (
            <li className="flex flex-wrap items-center gap-3 p-3">
              <GoogleIcon />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Google {methods.google && <Badge className="ml-1 rounded-full" variant="secondary">{t("Connected")}</Badge>}</p>
                <p className="text-xs text-muted-foreground">
                  {methods.google ? t("Connected {when}", { when: format.dateTime(methods.google.linkedAt) }) : t("Connect the Google account that uses your StudyForge email address.")}
                </p>
              </div>
              {methods.google ? (
                <Button size="sm" variant="outline" className="rounded-xl" disabled={busy !== null || onlyMethod} aria-describedby={onlyMethod ? "google-only-hint" : undefined} onClick={disconnect}>
                  {busy === "unlink" && <Loader2 className="animate-spin" aria-hidden />} {t("Disconnect")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="rounded-xl" disabled={busy !== null} onClick={connect}>
                  {busy === "link" && <Loader2 className="animate-spin" aria-hidden />} {t("Connect Google")}
                </Button>
              )}
              {onlyMethod && <p id="google-only-hint" className="basis-full text-xs text-muted-foreground">{t("Google is your only way to sign in. Set a password before disconnecting it.")}</p>}
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}
