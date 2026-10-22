import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ExamWizard } from "@/components/exams/exam-wizard";
import type { ExamLimitsResponse, ExamManageView } from "@/lib/exams";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Edit exam" };

export default async function EditExamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string }> }) {
  const { id } = await params;
  const { step } = await searchParams;
  await requireMe(`/exams/${id}/edit`);
  const [res, limits] = await Promise.all([
    backendJson<{ exam: ExamManageView }>(`/api/exams/${id}`),
    backendJson<ExamLimitsResponse>("/api/exams/limits").catch(() => null),
  ]);
  const exam = res.exam;
  if (!exam.draft) notFound(); // a participant's view has no draft: only the author edits
  if (exam.status !== "DRAFT") redirect(`/exams/${id}`);
  return <ExamWizard exam={exam} limitsResponse={limits} initialStep={step ?? null} />;
}
