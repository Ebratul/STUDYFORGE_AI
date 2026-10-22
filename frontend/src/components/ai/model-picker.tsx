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

export type PickerValue = { provider: string; modelId: string };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

function Caps({ m }: { m: ModelInfo }) {
  const c = m.capabilities;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {c.embeddings && <Badge variant="secondary" className="h-5 rounded-full px-1.5 text-[10px]">Embeddings</Badge>}
      {c.streaming && c.chat && <Badge variant="secondary" className="h-5 rounded-full px-1.5 text-[10px]">Streaming</Badge>}
      {c.chat && (
        <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px]" title="Whether the model supports native structured (JSON) output">
          Structured: {c.structured_output}
        </Badge>
      )}
      {m.context_length ? <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px]">{Math.round(m.context_length / 1000)}k ctx</Badge> : null}
      {m.capability_source === "unverified" && <Badge variant="outline" className="h-5 rounded-full px-1.5 text-[10px] text-warning" title="The provider doesn't report capabilities for this model, so they aren't verified.">unverified</Badge>}
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
        {kind === "embedding" ? "No saved key belongs to a provider that offers embeddings. Add an OpenAI (or compatible) key first." : "Add a provider API key first."}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-provider`}>Provider</Label>
          <Select value={provider} onValueChange={(p) => { setFilter(""); onChange({ provider: p, modelId: "" }); }}>
            <SelectTrigger id={`${idPrefix}-provider`} className="h-10 w-full rounded-xl"><SelectValue placeholder="Choose provider" /></SelectTrigger>
            <SelectContent>{eligible.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-model`}>Model ID</Label>
          <Input
            id={`${idPrefix}-model`}
            value={typed}
            disabled={!provider}
            placeholder={provider ? "Type or pick a model id" : "Choose a provider first"}
            onChange={(e) => provider && onChange({ provider, modelId: e.target.value.trim() })}
            className="h-10 rounded-xl font-mono text-sm"
            aria-invalid={badId || undefined}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
      {badId && <p role="alert" className="text-xs font-medium text-destructive">Model ids contain letters, digits and . _ : / @ + - only.</p>}

      {provider && (
        <div className="rounded-xl border">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
            <span>
              {models.isLoading ? "Loading models from the provider…" : models.isError ? "Couldn't load the model list" : `${models.data?.models.length ?? 0} models reported by the provider${models.data?.cached ? " (cached)" : ""}`}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={() => void models.refetch()} disabled={models.isFetching} aria-label="Refresh model list">
              {models.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />} Refresh
            </Button>
          </div>
          {models.isError ? (
            <p role="alert" className="p-3 text-sm text-destructive">
              {models.error instanceof ApiError ? (models.error.details.providerCode ? describeProviderCode(String(models.error.details.providerCode)) : models.error.message) : "Couldn't load models."} You can still type a model id above.
            </p>
          ) : (
            <ScrollArea className="max-h-56">
              <ul aria-label="Available models" className="divide-y">
                {list.length === 0 && !models.isLoading && <li className="p-3 text-sm text-muted-foreground">No matching models.</li>}
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
      {provider && typed && !badId && models.data && !known && <p className="text-xs text-warning">This id isn&apos;t in the provider&apos;s model list. It will be used as typed; requests fail if the provider doesn&apos;t recognise it.</p>}
    </div>
  );
}
