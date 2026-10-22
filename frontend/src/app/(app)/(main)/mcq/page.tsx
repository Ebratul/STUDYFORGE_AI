import type { Metadata } from "next";
import { ListChecks } from "lucide-react";
import { PlaceholderPage } from "@/components/common/placeholder-page";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "MCQ Generator" };

export default async function Page() {
  await requireMe("/mcq");
  return (
    <PlaceholderPage
      title="MCQ Generator"
      description="Generate validated multiple-choice questions from a topic, pasted text or your documents."
      icon={ListChecks}
      part={3}
      planned={["Difficulty mix, option count, marks and negative marking", "Answer-key validation before anything can be saved or published", "Edit, regenerate, and save questions to the question bank", "Explanations and short notes grounded in your sources"]}
    />
  );
}
