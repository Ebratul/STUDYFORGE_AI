"use client";

import { useState } from "react";
import { MailWarning } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function VerifyEmailBanner({ verified, email }: { verified: boolean; email: string }) {
  const [pending, setPending] = useState(false);
  if (verified) return null;
  async function resend() {
    setPending(true);
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: "/verify-email?status=done" });
    setPending(false);
    if (error) toast.error(error.status === 429 ? "Please wait a minute before requesting another email." : "Could not send the email. Email may not be configured on this server.");
    else toast.success("Verification email sent. Check your inbox.");
  }
  return (
    <Alert className="mb-6 border-warning/40 bg-warning-soft">
      <MailWarning aria-hidden />
      <AlertTitle>Verify your email address</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>We need to confirm {email} before account recovery can be trusted.</span>
        <Button size="sm" variant="outline" onClick={resend} disabled={pending}>{pending ? "Sending…" : "Resend email"}</Button>
      </AlertDescription>
    </Alert>
  );
}
