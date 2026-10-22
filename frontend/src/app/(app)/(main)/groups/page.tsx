import type { Metadata } from "next";
import { Users } from "lucide-react";
import { PlaceholderPage } from "@/components/common/placeholder-page";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Study groups" };

export default async function Page() {
  await requireMe("/groups");
  return (
    <PlaceholderPage
      title="Study groups"
      description="Study together with invitation-based groups and shared exams."
      icon={Users}
      part={5}
      planned={["Group roles, capacity and expiring invitation codes", "Shared exams with identical question snapshots", "Leaderboards and score-distribution charts"]}
    />
  );
}
