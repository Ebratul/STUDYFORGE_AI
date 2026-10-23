import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { Suspense } from "react";
import { SignInMethodsCard, type SignInMethods } from "@/components/account/sign-in-methods";
import { ChangePasswordCard, DeleteAccountCard, ExportCard, SessionsCard } from "@/components/account/privacy-cards";
import { backendJson, requireMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Privacy & account" };

type MethodsResponse = { hasPassword: boolean; googleAvailable: boolean; providers: { id: string; provider: string; linkedAt: string }[] };
type Sessions = { items: { id: string; userAgent: string | null; createdAt: string; expiresAt: string; current: boolean }[] };

export default async function PrivacyPage() {
  const t = await getT();
  const me = await requireMe("/settings/privacy");
  const [{ items }, raw] = await Promise.all([backendJson<Sessions>("/api/sessions"), backendJson<MethodsResponse>("/api/account/sign-in-methods")]);
  const google = raw.providers.find((p) => p.provider === "google");
  const methods: SignInMethods = { hasPassword: raw.hasPassword, googleAvailable: raw.googleAvailable, google: google ? { id: google.id, linkedAt: google.linkedAt } : null };
  return (
    <>
      <PageHeader title={t("Privacy & account")} description={t("Security, your data, and account deletion.")} />
      <div className="space-y-6">
        <Suspense><SignInMethodsCard methods={methods} email={me.user.email} /></Suspense>
        {methods.hasPassword && <ChangePasswordCard />}
        <SessionsCard sessions={items} />
        <ExportCard />
        <DeleteAccountCard email={me.user.email} hasPassword={methods.hasPassword} />
      </div>
    </>
  );
}
