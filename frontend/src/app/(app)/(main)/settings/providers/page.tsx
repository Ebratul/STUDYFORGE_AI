import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { ModelSettings } from "@/components/ai/model-settings";
import { BackendError, backendJson, requireMe } from "@/lib/server/backend";
import { ServiceError } from "@/components/common/service-error";
import type { PreferencesResponse, ProvidersResponse } from "@/lib/ai";
import { UsageCard } from "@/components/ai/usage-card";
import { readUsage } from "@/lib/usage";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "AI providers" };

export default async function ProvidersPage() {
  const t = await getT();
  await requireMe("/settings/providers");
  const [providers, prefs, usageRaw] = await Promise.all([
    backendJson<ProvidersResponse>("/api/ai/providers").catch((e) => (e instanceof BackendError ? null : Promise.reject(e))),
    backendJson<PreferencesResponse>("/api/ai/preferences"),
    backendJson<unknown>("/api/ai/usage").catch(() => null),
  ]);
  const usage = readUsage(usageRaw);
  return (
    <>
      <PageHeader title={t("AI providers")} description={t("Pick the models used for conversation and document search. Model lists come straight from your provider.")} />
      {usage && <UsageCard usage={usage} />}
      {providers ? <ModelSettings providers={providers} initial={prefs} /> : <ServiceError title={t("The AI service is unavailable")} message={t("We couldn't reach the AI service, so models can't be listed right now. Your saved settings are unchanged. Please try again shortly.")} />}
    </>
  );
}
