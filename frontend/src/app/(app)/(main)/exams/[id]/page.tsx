import type { Metadata } from "next";
import { ExamDetail } from "@/components/exams/exam-detail";
import type { ExamManageView, ExamTakeView } from "@/lib/exams";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Exam" };

export default async function ExamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ published?: string }> }) {
  const { id } = await params;
  const { published } = await searchParams;
  await requireMe(`/exams/${id}`);
  const { exam } = await backendJson<{ exam: ExamManageView | ExamTakeView }>(`/api/exams/${id}`);
  return <ExamDetail exam={exam} justPublished={published === "1"} />;
}
