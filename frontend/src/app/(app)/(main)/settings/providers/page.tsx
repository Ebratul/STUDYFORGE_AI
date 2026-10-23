import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { AiConnectionForm } from "@/components/ai/connection-form";
import { readConnection } from "@/components/ai/connection-helpers";
import { BackendError, backendJson, requireMe } from "@/lib/server/backend";
import { ServiceError } from "@/components/common/service-error";
import { UsageCard } from "@/components/ai/usage-card";
import { readUsage } from "@/lib/usage";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "AI connection" };

export default async function AiConnectionPage() {
  const t = await getT();
  await requireMe("/settings/providers");
  const [connection, usageRaw] = await Promise.all([
    backendJson<unknown>("/api/ai/connection").catch((e) => (e instanceof BackendError ? null : Promise.reject(e))),
    backendJson<unknown>("/api/ai/usage").catch(() => null),
  ]);
  const initial = readConnection(connection);
  const usage = readUsage(usageRaw);
  return (
    <>
      <PageHeader title={t("AI connection")} description={t("Connect your own AI account: one API key, one chat model and one embedding model. Usage is billed to you by your provider.")} />
      {usage && <UsageCard usage={usage} />}
      {initial ? <AiConnectionForm initial={initial} /> : <ServiceError title={t("The AI service is unavailable")} message={t("We couldn't load your AI connection right now. Your saved settings are unchanged. Please try again shortly.")} />}
    </>
  );
}
