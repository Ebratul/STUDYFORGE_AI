import type { Metadata } from "next";
import { PenLine } from "lucide-react";
import { PlaceholderPage } from "@/components/common/placeholder-page";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "CQ Generator" };

export default async function Page() {
  await requireMe("/cq");
  return (
    <PlaceholderPage
      title="CQ Generator"
      description="Create creative or descriptive questions, with or without model answers."
      icon={PenLine}
      part={3}
      planned={["Questions-only and questions-with-answers modes", "Stimulus-based Bangla CQ preset (knowledge, comprehension, application, higher-order)", "Edit, save, copy, print and PDF export", "No timer: CQ sets are for study, not exams"]}
    />
  );
}
