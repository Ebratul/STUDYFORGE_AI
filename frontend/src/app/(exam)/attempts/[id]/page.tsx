import type { Metadata } from "next";
import { TakeExam } from "@/components/exams/take-exam";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Exam" };

export default async function AttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/attempts/${id}`);
  // The attempt itself is loaded in the browser right before use: the countdown must start from a fresh server response.
  return <TakeExam attemptId={id} />;
}
