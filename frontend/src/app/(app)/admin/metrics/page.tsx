import type { Metadata } from "next";
import { MetricsView } from "@/components/admin/metrics-view";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin · Metrics" };
export const dynamic = "force-dynamic";

export default async function AdminMetricsPage() {
  await requireMe("/admin/metrics");
  return <MetricsView />;
}
