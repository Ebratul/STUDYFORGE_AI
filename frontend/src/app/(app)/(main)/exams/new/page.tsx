import type { Metadata } from "next";
import { NewExamForm } from "@/components/exams/new-exam-form";
import { PageHeader } from "@/components/common/page-header";
import { requireMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "New exam" };

export default async function NewExamPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const t = await getT();
  await requireMe("/exams/new");
  const { group } = await searchParams;
  return (
    <>
      <PageHeader title={t("New exam")} description={t("Create a draft, then choose questions and rules.")} />
      <NewExamForm initialGroupId={group ?? null} />
    </>
  );
}
