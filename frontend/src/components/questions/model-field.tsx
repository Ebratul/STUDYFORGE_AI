"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Cpu } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ModelPicker, type PickerValue } from "@/components/ai/model-picker";
import { apiGet } from "@/lib/api";
import type { ProvidersResponse } from "@/lib/ai";
import type { ModelRef } from "@/lib/questions";

/** Shows the model that will be used (from the user's settings) and lets them override it for this run only. */
export function ModelField({ configured, task, override, onOverride }: { configured: ModelRef | null; task: "MCQ" | "CQ"; override: ModelRef | null; onOverride: (m: ModelRef | null) => void }) {
  const [open, setOpen] = useState(false);
  const providers = useQuery({ queryKey: ["ai", "providers"], queryFn: () => apiGet<ProvidersResponse>("/api/ai/providers"), enabled: open, staleTime: 60_000 });
  const effective = override?.modelId ? override : configured;

  return (
    <div className="space-y-3">
      {effective ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Cpu className="size-4 text-muted-foreground" aria-hidden />
          <span>Model:</span>
          <Badge variant="secondary" className="rounded-full font-mono text-xs" data-testid="model-badge">{effective.provider.toLowerCase()} · {effective.modelId}</Badge>
          {override?.modelId && <span className="text-xs text-muted-foreground">(this run only)</span>}
          <Link href="/settings/providers" className="text-xs text-primary underline">Change in settings</Link>
        </p>
      ) : (
        <Alert className="border-warning/40 bg-warning-soft">
          <AlertTriangle className="text-warning" aria-hidden />
          <AlertTitle>No model chosen for {task} generation</AlertTitle>
          <AlertDescription>
            Add an API key and pick a model in <Link href="/settings/providers" className="font-medium text-primary underline">Settings → AI providers</Link>, or choose one for this run below. {task} generation falls back to your default model.
          </AlertDescription>
        </Alert>
      )}
      <div>
        <Button type="button" variant="outline" size="sm" className="rounded-full" aria-expanded={open} onClick={() => { setOpen((o) => !o); if (open) onOverride(null); }}>
          {open ? "Use my saved model" : "Use a different model for this run"}
        </Button>
      </div>
      {open && (
        <div className="rounded-xl border p-3">
          {providers.isLoading && <p className="text-sm text-muted-foreground">Loading your providers…</p>}
          {providers.isError && <p role="alert" className="text-sm text-destructive">Couldn&apos;t load your providers.</p>}
          {providers.data && <ModelPicker idPrefix={`${task.toLowerCase()}-override`} providers={providers.data.providers} kind="chat" value={override as PickerValue | null} onChange={(v) => onOverride(v && v.provider ? { provider: v.provider, modelId: v.modelId } : null)} />}
          <p className="mt-2 text-xs text-muted-foreground">Your key for that provider is used. Nothing is switched silently: if this model fails, the run fails.</p>
        </div>
      )}
    </div>
  );
}
