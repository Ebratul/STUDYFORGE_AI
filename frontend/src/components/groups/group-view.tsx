"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Users } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiGet } from "@/lib/api";
import { canEditGroup, canManageInvites, readGroupDetail, type GroupDetail } from "@/lib/groups";
import { RoleBadge } from "./badges";
import { ExamsTab } from "./exams-tab";
import { InvitesTab } from "./invites-tab";
import { MembersTab } from "./members-tab";
import { OverviewTab } from "./overview-tab";
import { SettingsTab } from "./settings-tab";
import { useI18n } from "@/lib/i18n/client";

export type TabId = "overview" | "members" | "invites" | "exams" | "settings";

export function GroupView({ initial, initialTab }: { initial: unknown; initialTab: string | null }) {
  const { t } = useI18n();
  const first = readGroupDetail(initial);
  const q = useQuery({
    queryKey: ["group", first.id],
    queryFn: async (): Promise<GroupDetail> => readGroupDetail((await apiGet<{ group: unknown }>(`/api/groups/${first.id}`)).group),
    initialData: first,
    staleTime: 10_000,
  });
  const g = q.data;
  const staff = canManageInvites(g.role);
  const owner = canEditGroup(g.role);
  const allowed: TabId[] = ["overview", "members", ...(staff ? ["invites" as const] : []), "exams", ...(owner ? ["settings" as const] : [])];
  const [tab, setTab] = useState<TabId>(allowed.includes(initialTab as TabId) ? (initialTab as TabId) : "overview");
  const change = (v: string) => {
    setTab(v as TabId);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", v);
    window.history.replaceState(null, "", url);
  };

  return (
    <>
      <Link href="/groups" className="mb-3 inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"><ArrowLeft className="size-4" aria-hidden /> {t("All groups")}</Link>
      <header className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight" data-testid="group-title">{g.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Users className="size-4" aria-hidden /> {t("{count} of {capacity} members", { count: g.memberCount, capacity: g.capacity })}</span><RoleBadge role={g.role} />{g.ownerName && <span>{t("Owned by {name}", { name: g.ownerName })}</span>}</p>
        </div>
      </header>
      <Tabs value={tab} onValueChange={change}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList variant="line" aria-label={t("Group sections")} className="h-11 w-max min-w-full justify-start">
            <TabsTrigger value="overview" className="min-h-10 px-3">{t("Overview")}</TabsTrigger>
            <TabsTrigger value="members" className="min-h-10 px-3">{t("Members")}</TabsTrigger>
            {staff && <TabsTrigger value="invites" className="min-h-10 px-3">{t("Invitations")}</TabsTrigger>}
            <TabsTrigger value="exams" className="min-h-10 px-3">{t("Exams")}</TabsTrigger>
            {owner && <TabsTrigger value="settings" className="min-h-10 px-3">{t("Settings")}</TabsTrigger>}
          </TabsList>
        </div>
        <TabsContent value="overview"><OverviewTab group={g} /></TabsContent>
        <TabsContent value="members"><MembersTab group={g} /></TabsContent>
        {/* Stays mounted so a freshly created code is never lost by switching tabs. */}
        {staff && <TabsContent value="invites" forceMount hidden={tab !== "invites"}><InvitesTab group={g} /></TabsContent>}
        <TabsContent value="exams"><ExamsTab group={g} /></TabsContent>
        {owner && <TabsContent value="settings"><SettingsTab group={g} /></TabsContent>}
      </Tabs>
    </>
  );
}
