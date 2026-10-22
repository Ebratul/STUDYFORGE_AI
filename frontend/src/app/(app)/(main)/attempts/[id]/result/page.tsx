import type { Metadata } from "next";
import { ResultView } from "@/components/exams/result-view";
import type { AttemptView, ResultView as ResultData } from "@/lib/exams";
import { redirect } from "next/navigation";
import { BackendError, backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Exam result" };

export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/attempts/${id}/result`);
  const raw = await backendJson<{ result: ResultData } | ResultData>(`/api/attempts/${id}/result`).catch((err: unknown) => {
    if (err instanceof BackendError && err.status === 409) redirect(`/attempts/${id}`); // still in progress: back to the exam
    throw err;
  });
  const result = "result" in raw ? raw.result : raw;
  // Title / exam id for the header and the retry button (the attempt view is available to the owner in every state).
  const attempt = await backendJson<{ attempt: AttemptView } | AttemptView>(`/api/attempts/${id}`).then((r) => ("attempt" in r ? r.attempt : r)).catch(() => null);
  return <ResultView result={result} attemptId={id} examId={attempt?.examId ?? result.exam?.id ?? null} examTitle={attempt?.examTitle ?? null} attemptNo={attempt?.attemptNo ?? null} />;
}
