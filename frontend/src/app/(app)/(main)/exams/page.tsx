import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { ExamList } from "@/components/exams/exam-list";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { requireMe } from "@/lib/server/backend";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Exams" };

export default async function ExamsPage() {
  const t = await getT();
  await requireMe("/exams");
  return (
    <>
      <PageHeader
        title={t("Exams")}
        description={t("Build timed multiple-choice exams from your question bank, take them, and review your results. The server keeps the clock and does the marking.")}
        actions={<Button asChild className="rounded-xl"><Link href="/exams/new"><Plus aria-hidden /> {t("New exam")}</Link></Button>}
      />
      <ExamList />
    </>
  );
}
