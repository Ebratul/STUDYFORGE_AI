import type { Metadata } from "next";
import { ConfigView } from "@/components/admin/config-view";
import { readConfig } from "@/lib/admin";
import { backendJson, requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Admin · Config" };
export const dynamic = "force-dynamic";

// ADMIN only: the backend answers 404 to SUPPORT and everyone else.
export default async function AdminConfigPage() {
  await requireMe("/admin/config");
  return <ConfigView groups={readConfig(await backendJson<unknown>("/api/admin/config"))} />;
}
