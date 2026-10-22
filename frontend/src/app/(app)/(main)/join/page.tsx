import type { Metadata } from "next";
import { JoinCodeForm } from "@/components/groups/join-panel";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Join a group" };

export default async function Page() {
  await requireMe("/join");
  return <JoinCodeForm />;
}
