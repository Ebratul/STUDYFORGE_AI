"use client";

import { useState } from "react";
import { MailWarning } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/lib/i18n/client";

export function VerifyEmailBanner({ verified, email }: { verified: boolean; email: string }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  if (verified) return null;
  async function resend() {
    setPending(true);
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/verify-email?status=done" });
    setPending(false);
    if (error) toast.error(error.status === 429 ? t("Please wait a minute before requesting another email.") : t("Could not send the email. Email may not be configured on this server."));
    else toast.success(t("Verification email sent. Check your inbox."));
  }
  return (
    <Alert className="mb-6 border-warning/40 bg-warning-soft">
      <MailWarning aria-hidden />
      <AlertTitle>{t("Verify your email address")}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{t("We need to confirm {email} before account recovery can be trusted.", { email })}</span>
        <Button size="sm" variant="outline" onClick={resend} disabled={pending}>{pending ? t("Sending…") : t("Resend email")}</Button>
      </AlertDescription>
    </Alert>
  );
}
