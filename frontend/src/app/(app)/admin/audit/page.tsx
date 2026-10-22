import type { Metadata } from "next";
import { AuditView } from "@/components/admin/audit-view";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin · Audit" };
export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  await requireMe("/admin/audit");
  return <AuditView />;
}
