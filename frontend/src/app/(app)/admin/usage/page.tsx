import type { Metadata } from "next";
import { UsageView } from "@/components/admin/usage-view";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin · Usage" };
export const dynamic = "force-dynamic";

export default async function AdminUsagePage() {
  await requireMe("/admin/usage");
  return <UsageView />;
}
