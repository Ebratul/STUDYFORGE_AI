import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/auth/recovery-forms";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Reset password" };

export default async function ForgotPasswordPage() {
  const t = await getT();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t("Forgot your password?")}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{t("Enter your email and we'll send you a reset link.")}</p>
      <ForgotPasswordForm />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-primary hover:underline">{t("Back to sign in")}</Link>
      </p>
    </>
  );
}
