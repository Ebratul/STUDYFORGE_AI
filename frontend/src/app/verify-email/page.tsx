import type { Metadata } from "next";
import Link from "next/link";
import { MailCheck, MailWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { getMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Email verification" };

// Better Auth redirects here with ?error=... when a verification link is invalid or expired.
export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ error?: string; status?: string }> }) {
  const { error, status } = await searchParams;
  const signedIn = Boolean(await getMe());
  const t = await getT();
  const verified = !error && status === "done";
  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 outline-none">
      <Logo href="/" />
      <div className="w-full max-w-md space-y-3 rounded-2xl border bg-card p-8 text-center shadow-card">
      <span className={`mx-auto inline-flex size-12 items-center justify-center rounded-2xl ${verified ? "bg-success-soft text-success" : "bg-warning-soft text-warning"}`}>
        {verified ? <MailCheck className="size-6" aria-hidden /> : <MailWarning className="size-6" aria-hidden />}
      </span>
      <h1 className="text-xl font-semibold">{error ? t("This verification link isn't valid") : verified ? t("Email verified") : t("Check your email")}</h1>
      <p className="text-sm text-muted-foreground">
        {error ? t("It may have expired or already been used. Sign in and we'll send you a new one.") : verified ? t("Thanks — your email address is confirmed.") : t("Open the verification link we emailed you to activate your account.")}
      </p>
      <Button asChild className="rounded-xl"><Link href={signedIn ? "/workspace" : "/login"}>{signedIn ? t("Open workspace") : t("Go to sign in")}</Link></Button>
      </div>
    </main>
  );
}
