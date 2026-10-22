import type { Metadata } from "next";
import { GraduationCap } from "lucide-react";
import { PlaceholderPage } from "@/components/common/placeholder-page";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Exams" };

export default async function Page() {
  await requireMe("/exams");
  return (
    <PlaceholderPage
      title="Exams"
      description="Build and take timed exams, then review your results."
      icon={GraduationCap}
      part={4}
      planned={["Server-authoritative timer, autosave and idempotent submission", "Deterministic scoring with negative marking", "Result bands and answer review according to the release policy", "Attempt history and score trends"]}
    />
  );
}
