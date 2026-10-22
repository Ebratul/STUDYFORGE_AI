import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { CqWorkspace } from "@/components/questions/cq-workspace";
import { backendJson, requireMe } from "@/lib/server/backend";
import { readPrefill } from "@/lib/prefill";
import type { QuestionLimitsResponse } from "@/lib/questions";

export const metadata: Metadata = { title: "CQ Generator" };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const prefill = readPrefill(await searchParams);
  await requireMe("/cq");
  const limits = await backendJson<QuestionLimitsResponse>("/api/questions/limits");
  return (
    <>
      <PageHeader title="CQ Generator" description="Create creative or descriptive questions, with or without model answers. CQ sets are for study — there is no timer." />
      <CqWorkspace limitsResponse={limits} prefill={prefill} />
    </>
  );
}
