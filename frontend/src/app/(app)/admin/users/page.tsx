import type { Metadata } from "next";
import { UsersView } from "@/components/admin/users-view";
import { asRole } from "@/lib/admin";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin · Users" };
export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const me = await requireMe("/admin/users");
  return <UsersView role={asRole(me.user.role)} selfId={me.user.id} />;
}
