import type { Metadata } from "next";
import { OverviewView } from "@/components/admin/overview";
import { readOverview } from "@/lib/admin";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

// The backend answers 404 to anyone without the permission, which backendJson turns into notFound().
export default async function AdminOverviewPage() {
  await requireMe("/admin");
  return <OverviewView o={readOverview(await backendJson<unknown>("/api/admin/overview"))} />;
}
