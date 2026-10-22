"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MoreHorizontal, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/questions/bank/bank-dialogs";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { canChangeRoles, canRemoveMember, describeGroupError, readList, readMember, type GroupDetail, type MemberView } from "@/lib/groups";
import { RoleBadge } from "./badges";
import { useI18n } from "@/lib/i18n/client";

const PAGE_SIZE = 20;
const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "ERROR", "Something went wrong. Please try again."));

export function MembersTab({ group }: { group: GroupDetail }) {
  const { t, format } = useI18n();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const members = useQuery({
    queryKey: ["group", group.id, "members", page],
    queryFn: async () => readList(await apiGet(`/api/groups/${group.id}/members?page=${page}&pageSize=${PAGE_SIZE}`), readMember),
    placeholderData: (prev) => prev,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["group", group.id] });
    void qc.invalidateQueries({ queryKey: ["groups"] });
  };
  const role = useMutation({
    mutationFn: (v: { m: MemberView; role: "ADMIN" | "MEMBER" }) => apiSend("PATCH", `/api/groups/${group.id}/members/${encodeURIComponent(v.m.memberId)}`, { role: v.role }),
    onSuccess: (_r, v) => { refresh(); toast.success(v.role === "ADMIN" ? t("{name} is now an admin", { name: t(v.m.displayName) }) : t("{name} is now a member", { name: t(v.m.displayName) })); },
    onError: (e) => toast.error(describeGroupError(asError(e), "generic", t)),
  });
  const remove = useMutation({
    mutationFn: (m: MemberView) => apiSend("DELETE", `/api/groups/${group.id}/members/${encodeURIComponent(m.memberId)}`),
    onSuccess: (_r, m) => { setRemoving(null); refresh(); toast.success(t("{name} was removed", { name: t(m.displayName) })); },
    onError: (e) => { setRemoving(null); toast.error(describeGroupError(asError(e), "generic", t)); },
  });

  const data = members.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <section className="mt-4 rounded-2xl border bg-card shadow-card" aria-labelledby="mem-h" aria-busy={members.isFetching}>
      <div className="flex items-center justify-between border-b px-5 py-3"><h2 id="mem-h" className="text-base font-semibold">{t("Members")}</h2><p className="text-sm text-muted-foreground" aria-live="polite">{data ? t("{count, plural, one {# member} other {# members}}", { count: data.total }) : ""}</p></div>
      {members.isLoading && <div className="space-y-2 p-5"><Skeleton className="h-10 rounded-xl" /><Skeleton className="h-10 rounded-xl" /></div>}
      {members.isError && <p role="alert" className="p-5 text-sm text-destructive">{describeGroupError(asError(members.error), "generic", t)}</p>}
      {data && (
        <ul className="divide-y" data-testid="member-list">
          {data.items.map((m) => {
            const mayRole = canChangeRoles(group.role) && !m.isSelf && m.role !== "OWNER";
            const mayRemove = canRemoveMember(group.role, m.role, m.isSelf);
            return (
              <li key={m.memberId} className="flex items-center gap-3 px-5 py-3" data-testid="member-row">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground" aria-hidden>{m.displayName.slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="truncate">{t(m.displayName)}</span>{m.isSelf && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{t("You")}</span>}</p>
                  <p className="text-xs text-muted-foreground">{t("Joined")} <time dateTime={m.joinedAt}>{m.joinedAt ? format.date(m.joinedAt) : "—"}</time></p>
                </div>
                <RoleBadge role={m.role} />
                {(mayRole || mayRemove) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-10 rounded-xl" aria-label={t("Actions for {name}", { name: t(m.displayName) })}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {mayRole && m.role === "MEMBER" && <DropdownMenuItem onSelect={() => role.mutate({ m, role: "ADMIN" })}>{t("Make admin")}</DropdownMenuItem>}
                      {mayRole && m.role === "ADMIN" && <DropdownMenuItem onSelect={() => role.mutate({ m, role: "MEMBER" })}>{t("Make regular member")}</DropdownMenuItem>}
                      {mayRemove && <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(m)}><UserMinus aria-hidden /> {t("Remove from group")}</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data && pages > 1 && (
        <nav aria-label={t("Members pages")} className="flex items-center justify-between border-t px-5 py-3">
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft aria-hidden /> {t("Previous")}</Button>
          <span className="text-sm text-muted-foreground">{t("Page {page} of {pages}", { page, pages })}</span>
          <Button variant="outline" size="sm" className="rounded-xl" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>{t("Next")} <ChevronRight aria-hidden /></Button>
        </nav>
      )}
      <ConfirmDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} title={removing ? t("Remove {name}?", { name: removing.displayName }) : t("Remove this member?")} description={t("They lose access to this group's exams and leaderboards, and their results disappear from the group's leaderboards. They can rejoin only with a new invitation.")} confirmLabel={t("Remove member")} pending={remove.isPending} onConfirm={() => removing && remove.mutate(removing)} />
    </section>
  );
}
