import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { McqWorkspace } from "@/components/questions/mcq-workspace";
import { backendJson, requireMe } from "@/lib/server/backend";
import { readPrefill } from "@/lib/prefill";
import type { QuestionLimitsResponse } from "@/lib/questions";

export const metadata: Metadata = { title: "MCQ Generator" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const prefill = readPrefill(await searchParams);
  await requireMe("/mcq");
  const limits = await backendJson<QuestionLimitsResponse>("/api/questions/limits");
  return (
    <>
      <PageHeader title="MCQ Generator" description="Generate multiple-choice questions from a topic, pasted text or your documents. Every question is validated by the server, then yours to review, edit and save." />
      <McqWorkspace limitsResponse={limits} prefill={prefill} />
    </>
  );
}
