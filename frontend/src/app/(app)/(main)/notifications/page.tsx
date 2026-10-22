import type { Metadata } from "next";
import { Bell } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { NotificationList } from "@/components/account/notification-list";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  await requireMe("/notifications");
  const { items } = await backendJson<{ items: { id: string; title: string; body: string; link?: string | null; read: boolean; createdAt: string }[] }>("/api/notifications");
  return (
    <>
      <PageHeader title="Notifications" description="Account and activity updates." />
      {items.length === 0 ? <EmptyState icon={Bell} title="Nothing here yet" description="When something needs your attention it will show up in this list." /> : <NotificationList items={items} />}
    </>
  );
}
