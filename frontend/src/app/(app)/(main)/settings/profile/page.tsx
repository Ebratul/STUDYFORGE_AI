import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { PreferencesForm, ProfileForm } from "@/components/account/profile-forms";
import { backendJson, requireMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Profile" };

type ProfileData = { name: string; email: string; displayName: string; bio: string; timezone: string; preference: { theme: "SYSTEM" | "LIGHT" | "DARK"; locale: "en" | "bn"; emailNotifications: boolean } };

export default async function ProfilePage() {
  const t = await getT();
  await requireMe("/settings/profile");
  const p = await backendJson<ProfileData>("/api/profile");
  return (
    <>
      <PageHeader title={t("Profile & preferences")} description={t("How you appear in StudyForge and how the app behaves for you.")} />
      <div className="space-y-6">
        <ProfileForm email={p.email} initial={{ name: p.name, displayName: p.displayName, bio: p.bio, timezone: p.timezone }} />
        <PreferencesForm initial={p.preference} />
      </div>
    </>
  );
}
