import type { Metadata } from "next";
import { GroupView } from "@/components/groups/group-view";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Study group" };

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { id } = await params;
  const { tab } = await searchParams;
  await requireMe(`/groups/${id}`);
  // A group that doesn't exist and one you aren't in are indistinguishable (404).
  const { group } = await backendJson<{ group: unknown }>(`/api/groups/${encodeURIComponent(id)}`);
  return <GroupView initial={group} initialTab={tab ?? null} />;
}
