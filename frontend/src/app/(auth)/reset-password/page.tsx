import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth/recovery-forms";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage() {
  const t = await getT();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{t("Choose a new password")}</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">{t("Signing in elsewhere will be required after the change.")}</p>
      <Suspense><ResetPasswordForm /></Suspense>
    </>
  );
}
