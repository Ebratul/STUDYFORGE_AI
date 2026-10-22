import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { BankView } from "@/components/questions/bank/bank-view";
import { backendJson, requireMe } from "@/lib/server/backend";
import type { QuestionLimitsResponse } from "@/lib/questions";

export const metadata: Metadata = { title: "Question bank" };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async function Page({ searchParams }: { searchParams: Promise<{ collection?: string; question?: string }> }) {
  const sp = await searchParams;
  const collection = sp.collection && ID.test(sp.collection) ? sp.collection : null;
  const question = sp.question && ID.test(sp.question) ? sp.question : null;
  await requireMe("/question-bank");
  const limits = await backendJson<QuestionLimitsResponse>("/api/questions/limits");
  // Deep links are checked on the server: an id that isn't yours is a 404, exactly like one that doesn't exist.
  if (collection) await backendJson(`/api/collections/${collection}`);
  if (question) await backendJson(`/api/questions/${question}`);
  return (
    <>
      <PageHeader title="Question bank" description="Your saved questions and collections. Search, organise, edit, export and reuse them — private to you." />
      <BankView limitsResponse={limits} initialCollectionId={collection} initialQuestionId={question} />
    </>
  );
}
