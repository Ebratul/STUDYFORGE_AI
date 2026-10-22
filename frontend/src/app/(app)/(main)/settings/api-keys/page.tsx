import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { ApiKeysManager } from "@/components/ai/api-keys-manager";
import { BackendError, backendJson, requireMe } from "@/lib/server/backend";
import { ServiceError } from "@/components/common/service-error";
import type { ProvidersResponse } from "@/lib/ai";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  const t = await getT();
  await requireMe("/settings/api-keys");
  const providers = await backendJson<ProvidersResponse>("/api/ai/providers").catch((e) => (e instanceof BackendError ? null : Promise.reject(e)));
  return (
    <>
      <PageHeader title={t("API keys")} description={t("Connect your own OpenAI, OpenRouter or Groq account. Models and usage are billed to you by the provider.")} />
      {providers ? <ApiKeysManager initial={providers} /> : <ServiceError title={t("The AI service is unavailable")} message={t("We couldn't reach the AI service, so provider status can't be shown right now. Your saved keys are safe. Please try again shortly.")} />}
    </>
  );
}
