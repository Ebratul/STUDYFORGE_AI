import type { Metadata } from "next";
import { BookOpenCheck } from "lucide-react";
import { PlaceholderPage } from "@/components/common/placeholder-page";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Question bank" };

export default async function Page() {
  await requireMe("/question-bank");
  return (
    <PlaceholderPage
      title="Question bank"
      description="Save, organise and reuse your questions across exams."
      icon={BookOpenCheck}
      part={3}
      planned={["Collections, tags, subjects and difficulty filters", "Search, import and export", "Versioned questions so edits never change a published exam"]}
    />
  );
}
