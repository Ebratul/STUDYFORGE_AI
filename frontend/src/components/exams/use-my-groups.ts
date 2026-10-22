"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export type GroupOption = { id: string; title: string; role: string };

/** Groups the caller may publish exams to (OWNER / ADMIN). Tolerates the endpoint being absent: the exam form then offers individual exams only. */
export function useManageableGroups() {
  return useQuery({
    queryKey: ["groups", "manageable"],
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<GroupOption[]> => {
      const r = await apiGet<{ items?: Record<string, unknown>[]; groups?: Record<string, unknown>[] }>("/api/groups");
      const list = r.items ?? r.groups ?? [];
      return list
        .map((g) => ({ id: String(g.id), title: String(g.title ?? "Group"), role: String(g.role ?? g.myRole ?? "MEMBER") }))
        .filter((g) => g.role === "OWNER" || g.role === "ADMIN");
    },
  });
}
