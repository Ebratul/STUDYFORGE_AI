"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, KeyRound, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { ApiError, apiGet } from "@/lib/api";
import { describeGroupError, readGroupSummary, readList, resolveGroupLimits, type GroupSummary } from "@/lib/groups";
import { CreateGroupDialog } from "./create-group-dialog";
import { RoleBadge } from "./badges";

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
}

function GroupCard({ g }: { g: GroupSummary }) {
  const full = g.capacity > 0 && g.memberCount >= g.capacity;
  return (
    <li>
      <Link href={`/groups/${g.id}`} className="block h-full rounded-2xl border bg-card p-5 shadow-card transition hover:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none" data-testid="group-card">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-base font-semibold">{g.title}</h2>
          <RoleBadge role={g.role} />
        </div>
        {g.description && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{g.description}</p>}
        <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Users className="size-4" aria-hidden /> {g.memberCount} of {g.capacity} members{full && <span className="font-medium text-foreground"> · Full</span>}
        </p>
        {g.nextExam ? (
          <p className="mt-2 flex items-start gap-1.5 text-sm"><CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> <span><span className="text-muted-foreground">Next exam: </span>{g.nextExam.title}{when(g.nextExam.opensAt ?? g.nextExam.closesAt) && <span className="text-muted-foreground"> · {when(g.nextExam.opensAt ?? g.nextExam.closesAt)}</span>}</span></p>
        ) : g.lastExam ? (
          <p className="mt-2 flex items-start gap-1.5 text-sm"><CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> <span><span className="text-muted-foreground">Last exam: </span>{g.lastExam.title}</span></p>
        ) : null}
      </Link>
    </li>
  );
}

export function GroupList() {
  const [creating, setCreating] = useState(false);
  const groups = useQuery({ queryKey: ["groups"], queryFn: async () => readList(await apiGet("/api/groups"), readGroupSummary).items });
  const limits = useQuery({ queryKey: ["exam-limits"], queryFn: async () => resolveGroupLimits(await apiGet("/api/exams/limits")), retry: false });
  const resolved = limits.data ?? resolveGroupLimits(null);

  return (
    <>
      <PageHeader
        title="Study groups"
        description="Study together: invite people with a private code, publish one exam for everyone, and compare results on a fair leaderboard."
        actions={
          <>
            <Button asChild variant="outline" className="rounded-xl"><Link href="/join"><KeyRound aria-hidden /> Join with a code</Link></Button>
            <Button className="rounded-xl" onClick={() => setCreating(true)}><Plus aria-hidden /> New group</Button>
          </>
        }
      />
      {groups.isLoading && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true"><Skeleton className="h-36 rounded-2xl" /><Skeleton className="h-36 rounded-2xl" /></div>}
      {groups.isError && (
        <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm">
          {describeGroupError(groups.error instanceof ApiError ? groups.error : { code: "ERROR", message: "Couldn't load your groups." })}{" "}
          <button type="button" className="font-medium underline" onClick={() => void groups.refetch()}>Try again</button>
        </div>
      )}
      {groups.data && groups.data.length === 0 && (
        <EmptyState
          icon={Users}
          title="You're not in any group yet"
          description="Create a group to invite classmates, or join one with an invitation code or link."
          action={<div className="flex flex-wrap justify-center gap-2"><Button className="rounded-xl" onClick={() => setCreating(true)}><Plus aria-hidden /> Create a group</Button><Button asChild variant="outline" className="rounded-xl"><Link href="/join">Join with a code</Link></Button></div>}
        />
      )}
      {groups.data && groups.data.length > 0 && <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{groups.data.map((g) => <GroupCard key={g.id} g={g} />)}</ul>}
      {creating && <CreateGroupDialog open={creating} onOpenChange={setCreating} limits={resolved} />}
    </>
  );
}
