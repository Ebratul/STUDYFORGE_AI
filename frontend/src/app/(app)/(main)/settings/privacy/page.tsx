import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { ChangePasswordCard, DeleteAccountCard, ExportCard, SessionsCard } from "@/components/account/privacy-cards";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Privacy & account" };

type Sessions = { items: { id: string; userAgent: string | null; createdAt: string; expiresAt: string; current: boolean }[] };

export default async function PrivacyPage() {
  const me = await requireMe("/settings/privacy");
  const { items } = await backendJson<Sessions>("/api/sessions");
  return (
    <>
      <PageHeader title="Privacy & account" description="Security, your data, and account deletion." />
      <div className="space-y-6">
        <ChangePasswordCard />
        <SessionsCard sessions={items} />
        <ExportCard />
        <DeleteAccountCard email={me.user.email} />
      </div>
    </>
  );
}
