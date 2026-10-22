import type { Metadata } from "next";
import { GroupList } from "@/components/groups/group-list";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Study groups" };

export default async function Page() {
  await requireMe("/groups");
  return <GroupList />;
}
