import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { StudyPlanView } from "@/components/study-plan/study-plan-view";
import { requireMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Study plan" };

export default async function StudyPlanPage() {
  const t = await getT();
  await requireMe("/study-plan");
  return (
    <>
      <PageHeader title={t("Study plan")} description={t("Practical next steps built from your real, released exam results. Early on these are initial suggestions — one exam can't prove mastery.")} />
      <StudyPlanView />
    </>
  );
}
