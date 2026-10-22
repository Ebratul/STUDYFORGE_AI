"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ApiError, apiGet } from "@/lib/api";
import { describeProviderCode, type ModelInfo, type ModelsResponse, type ProviderInfo } from "@/lib/ai";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export type PickerValue = { provider: string; modelId: string };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

function Caps({ m }: { m: ModelInfo }) {
  const t = useT();
  const c = m.capabilities;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {c.embeddings && <Badge variant="secondary" className="h-5 rounded-full px-1.5 text-[10px]">{t("Embeddings")}</Badge>}
      {c.streaming && c.chat && <Badge variant="secondary" className="h-5 rounded-full px-1.5 text-[10px]">{t("Streaming")}</Badge>}
      {c.chat && (
        <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px]" title={t("Whether the model supports native structured (JSON) output")}>
          {t("Structured: {mode}", { mode: c.structured_output })}
        </Badge>
      )}
      {m.context_length ? <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px]">{t("{k}k ctx", { k: Math.round(m.context_length / 1000) })}</Badge> : null}
      {m.capability_source === "unverified" && <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px] text-warning" title={t("The provider doesn't report capabilities for this model, so they aren't verified.")}>{t("unverified")}</Badge>}
    </span>
  );
}

/**
 * Provider + model chooser. Models are loaded from the provider's own API with the user's saved key —
 * nothing is hard-coded. A model id can also be typed (validated); ids not in the list are flagged, not blocked.
 */
export function ModelPicker({
  idPrefix, providers, kind, value, onChange,
}: {
  idPrefix: string;
  providers: ProviderInfo[];
  kind: "chat" | "embedding";
  value: PickerValue | null;
  onChange: (v: PickerValue | null) => void;
}) {
  const t = useT();
  const eligible = providers.filter((p) => p.credential && (kind === "chat" ? p.capabilities.chat : p.capabilities.embeddings));
  const provider = value?.provider ?? "";
  const [filter, setFilter] = useState("");

  const models = useQuery({
    queryKey: ["ai", "models", provider],
    queryFn: () => apiGet<ModelsResponse>(`/api/ai/credentials/${provider}/models`),
    enabled: Boolean(provider),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const list = useMemo(() => {
    const all = (models.data?.models ?? []).filter((m) => (kind === "chat" ? m.capabilities.chat !== false : m.capabilities.embeddings));
    const q = (value?.modelId ?? "").toLowerCase() || filter.toLowerCase();
    return q ? all.filter((m) => m.id.toLowerCase().includes(q)).slice(0, 100) : all.slice(0, 100);
  }, [models.data, kind, value?.modelId, filter]);

  const typed = value?.modelId ?? "";
  const known = (models.data?.models ?? []).some((m) => m.id === typed);
  const badId = typed !== "" && !MODEL_ID.test(typed);

  if (eligible.length === 0) {
    return (
      <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
        {kind === "embedding" ? t("No saved key belongs to a provider that offers embeddings. Add an OpenAI (or compatible) key first.") : t("Add a provider API key first.")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-provider`}>{t("Provider")}</Label>
          <Select value={provider} onValueChange={(p) => { setFilter(""); onChange({ provider: p, modelId: "" }); }}>
            <SelectTrigger id={`${idPrefix}-provider`} className="h-10 w-full rounded-xl"><SelectValue placeholder={t("Choose provider")} /></SelectTrigger>
            <SelectContent>{eligible.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-model`}>{t("Model ID")}</Label>
          <Input
            id={`${idPrefix}-model`}
            value={typed}
            disabled={!provider}
            placeholder={provider ? t("Type or pick a model id") : t("Choose a provider first")}
            onChange={(e) => provider && onChange({ provider, modelId: e.target.value.trim() })}
            className="h-10 rounded-xl font-mono text-sm"
            aria-invalid={badId || undefined}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
      {badId && <p role="alert" className="text-xs font-medium text-destructive">{t("Model ids contain letters, digits and . _ : / @ + - only.")}</p>}

      {provider && (
        <div className="rounded-xl border">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
            <span>
              {models.isLoading ? t("Loading models from the provider…") : models.isError ? t("Couldn't load the model list") : `${t("{count} models reported by the provider", { count: models.data?.models.length ?? 0 })}${models.data?.cached ? ` (${t("cached")})` : ""}`}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void models.refetch()} disabled={models.isFetching} aria-label={t("Refresh model list")}>
              {models.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} {t("Refresh")}
            </Button>
          </div>
          {models.isError ? (
            <p role="alert" className="p-3 text-sm text-destructive">
              {models.error instanceof ApiError ? (models.error.details.providerCode ? describeProviderCode(String(models.error.details.providerCode), t) : t(models.error.message)) : t("Couldn't load models.")} {t("You can still type a model id above.")}
            </p>
          ) : (
            <ScrollArea className="max-h-56">
              <ul aria-label={t("Available models")} className="divide-y">
                {list.length === 0 && !models.isLoading && <li className="p-3 text-sm text-muted-foreground">{t("No matching models.")}</li>}
                {list.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      aria-pressed={m.id === typed}
                      onClick={() => onChange({ provider, modelId: m.id })}
                      className={cn("flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent/60 sm:flex-row sm:items-center sm:justify-between", m.id === typed && "bg-accent")}
                    >
                      <span className="flex items-center gap-2 font-mono text-xs">{m.id === typed && <Check className="size-3.5 text-primary" aria-hidden />} {m.id}</span>
                      <Caps m={m} />
                    </button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>
      )}
      {provider && typed && !badId && models.data && !known && <p className="text-xs text-warning">{t("This id isn't in the provider's model list. It will be used as typed; requests fail if the provider doesn't recognise it.")}</p>}
    </div>
  );
}
