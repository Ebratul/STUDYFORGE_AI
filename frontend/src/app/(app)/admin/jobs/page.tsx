import type { Metadata } from "next";
import { JobsView } from "@/components/admin/jobs-view";
import { asRole } from "@/lib/admin";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin · Jobs" };
export const dynamic = "force-dynamic";

export default async function AdminJobsPage() {
  const me = await requireMe("/admin/jobs");
  return <JobsView role={asRole(me.user.role)} />;
}
