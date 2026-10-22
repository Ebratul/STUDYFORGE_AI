import type { Metadata } from "next";
import { LeaderboardView } from "@/components/leaderboard/leaderboard-view";
import { backendFetch, backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Leaderboard" };

async function examInfo(id: string): Promise<{ title: string; group: { id: string; title: string } | null }> {
  try {
    const res = await backendFetch(`/api/exams/${encodeURIComponent(id)}`);
    if (!res.ok) return { title: "Group exam", group: null };
    const { exam } = (await res.json()) as { exam?: { title?: string; group?: { id?: string; title?: string } | null } };
    const g = exam?.group;
    return { title: exam?.title ?? "Group exam", group: g?.id ? { id: g.id, title: g.title ?? "Group" } : null };
  } catch {
    return { title: "Group exam", group: null };
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/exams/${id}/leaderboard`);
  // 404 for exams that don't exist, aren't group exams, or that you can't see.
  const initial = await backendJson<unknown>(`/api/exams/${encodeURIComponent(id)}/leaderboard?page=1&pageSize=25`);
  const info = await examInfo(id);
  return <LeaderboardView examId={id} title={info.title} group={info.group} initial={initial} />;
}
