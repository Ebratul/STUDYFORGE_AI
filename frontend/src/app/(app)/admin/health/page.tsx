import type { Metadata } from "next";
import { HealthView } from "@/components/admin/health-view";
import { readHealth } from "@/lib/admin";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin · Health" };
export const dynamic = "force-dynamic";

export default async function AdminHealthPage() {
  await requireMe("/admin/health");
  return <HealthView h={readHealth(await backendJson<unknown>("/api/admin/health"))} />;
}
