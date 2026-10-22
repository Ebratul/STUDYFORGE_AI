"use client";

import { useI18n, useRich } from "@/lib/i18n/client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { TASK_LABEL, type PreferencesResponse, type PrefView, type ProvidersResponse, type TaskId } from "@/lib/ai";
import { ModelPicker, type PickerValue } from "./model-picker";
import { msg } from "@/lib/i18n/translate";

type Params = { temperature: string; topP: string; maxTokens: string };
type State = { default: PickerValue | null; params: Params; tasks: Partial<Record<TaskId, PickerValue | null>> };

const fromPrefs = (p: PreferencesResponse): State => ({
  default: p.default ? { provider: p.default.provider.toLowerCase(), modelId: p.default.modelId } : null,
  params: { temperature: p.default?.temperature?.toString() ?? "", topP: p.default?.topP?.toString() ?? "", maxTokens: p.default?.maxTokens?.toString() ?? "" },
  tasks: Object.fromEntries((Object.entries(p.tasks) as [TaskId, PrefView][]).map(([t, v]) => [t, { provider: v.provider.toLowerCase(), modelId: v.modelId }])),
});

const num = (s: string) => (s.trim() === "" ? null : Number(s));

export function ModelSettings({ providers, initial }: { providers: ProvidersResponse; initial: PreferencesResponse }) {
  const { t, format } = useI18n();
  const rich = useRich();
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ["ai", "preferences"], queryFn: () => apiGet<PreferencesResponse>("/api/ai/preferences"), initialData: initial });
  const [state, setState] = useState<State>(() => fromPrefs(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const L = providers.limits;
  const connected = providers.providers.filter((p) => p.credential);

  function validate(): boolean {
    const e: Record<string, string> = {};
    const temp = num(state.params.temperature), p = num(state.params.topP), m = num(state.params.maxTokens);
    if (temp !== null && (Number.isNaN(temp) || temp < L.temperature.min || temp > L.temperature.max)) e.temperature = t("Between {min} and {max}.", { min: L.temperature.min, max: L.temperature.max });
    if (p !== null && (Number.isNaN(p) || p < L.topP.min || p > L.topP.max)) e.topP = t("Between {min} and {max}.", { min: L.topP.min, max: L.topP.max });
    if (m !== null && (!Number.isInteger(m) || m < L.maxTokens.min || m > L.maxTokens.max)) e.maxTokens = t("A whole number between {min} and {max}.", { min: L.maxTokens.min, max: format.number(L.maxTokens.max) });
    if (state.default && !state.default.modelId) e.default = t("Choose or enter a model.");
    for (const [task, v] of Object.entries(state.tasks)) if (v && !v.modelId) e[task] = t("Choose or enter a model.");
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  const save = useMutation({
    mutationFn: () => {
      const entry = (v: PickerValue | null, withParams: boolean) =>
        v ? { provider: v.provider, modelId: v.modelId, ...(withParams ? { temperature: num(state.params.temperature), topP: num(state.params.topP), maxTokens: num(state.params.maxTokens) } : {}) } : null;
      const tasks: Record<string, unknown> = {};
      for (const k of Object.keys(TASK_LABEL) as TaskId[]) tasks[k] = entry(state.tasks[k] ?? null, k !== "EMBEDDING");
      return apiSend<PreferencesResponse>("PUT", "/api/ai/preferences", { default: entry(state.default, true), tasks });
    },
    onSuccess: (data) => {
      toast.success(t("Model settings saved"));
      qc.setQueryData(["ai", "preferences"], data);
      setState(fromPrefs(data));
    },
    onError: (err) => {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      toast.error(err instanceof ApiError ? t(err.message) : t("Couldn't save settings."));
    },
  });

  if (connected.length === 0) {
    return (
      <Card className="rounded-2xl shadow-card">
        <CardHeader><CardTitle>{t("Connect a provider first")}</CardTitle><CardDescription>{t("Models are listed using your own API key.")}</CardDescription></CardHeader>
        <CardFooter><Button asChild className="rounded-xl"><Link href="/settings/api-keys">{t("Add an API key")}</Link></Button></CardFooter>
      </Card>
    );
  }

  const embeddingChanged = (initial.tasks.EMBEDDING?.modelId ?? "") !== (state.tasks.EMBEDDING?.modelId ?? "") && Boolean(initial.tasks.EMBEDDING);

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (validate()) save.mutate(); }} className="space-y-6" noValidate>
      <Card className="rounded-2xl shadow-card">
        <CardHeader>
          <CardTitle>{t("Default model")}</CardTitle>
          <CardDescription>{t("Used for conversation unless you choose a task-specific model below. We never switch to another provider automatically if this one fails.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ModelPicker idPrefix="default" providers={providers.providers} kind="chat" value={state.default} onChange={(v) => setState((s) => ({ ...s, default: v }))} />
          {errors.default && <p role="alert" className="text-xs font-medium text-destructive">{errors.default}</p>}

          <fieldset className="grid gap-4 sm:grid-cols-3">
            <legend className="mb-2 text-sm font-medium">{t("Generation settings")} <span className="font-normal text-muted-foreground">{t("(optional; blank = provider default)")}</span></legend>
            {([
              ["temperature", msg("Temperature"), `${L.temperature.min}–${L.temperature.max}`, "0.1"],
              ["topP", msg("Top-p"), `${L.topP.min}–${L.topP.max}`, "0.05"],
              ["maxTokens", msg("Max output tokens"), `1–${L.maxTokens.max.toLocaleString("en-US")}`, "1"],
            ] as const).map(([key, label, range, step]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`param-${key}`}>{t(label)}</Label>
                <Input
                  id={`param-${key}`}
                  inputMode="decimal"
                  type="number"
                  step={step}
                  value={state.params[key]}
                  onChange={(e) => setState((s) => ({ ...s, params: { ...s.params, [key]: e.target.value } }))}
                  placeholder={range}
                  className="h-10 rounded-xl"
                  aria-invalid={errors[key] ? true : undefined}
                  aria-describedby={`param-${key}-hint`}
                />
                <p id={`param-${key}-hint`} className={errors[key] ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"} role={errors[key] ? "alert" : undefined}>{errors[key] ?? t("Allowed: {range}", { range })}</p>
              </div>
            ))}
          </fieldset>
        </CardContent>
      </Card>

      {(Object.keys(TASK_LABEL) as TaskId[]).map((task) => {
        const meta = TASK_LABEL[task];
        const custom = Boolean(state.tasks[task]);
        return (
          <Card key={task} className="rounded-2xl shadow-card">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">{t(meta.title)} {!meta.available && <Badge variant="outline" className="rounded-full text-[10px]">{t("Used in a later part")}</Badge>}</CardTitle>
                  <CardDescription className="mt-1">{t(meta.hint)}</CardDescription>
                </div>
                {task !== "EMBEDDING" && (
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`custom-${task}`} className="text-xs text-muted-foreground">{custom ? t("Custom") : t("Use default")}</Label>
                    <Switch id={`custom-${task}`} checked={custom} onCheckedChange={(on) => setState((s) => ({ ...s, tasks: { ...s.tasks, [task]: on ? (s.default ? { ...s.default } : { provider: "", modelId: "" }) : null } }))} />
                  </div>
                )}
              </div>
            </CardHeader>
            {(custom || task === "EMBEDDING") && (
              <CardContent className="space-y-3">
                <ModelPicker idPrefix={task.toLowerCase()} providers={providers.providers} kind={task === "EMBEDDING" ? "embedding" : "chat"} value={state.tasks[task] ?? null} onChange={(v) => setState((s) => ({ ...s, tasks: { ...s.tasks, [task]: v } }))} />
                {errors[task] && <p role="alert" className="text-xs font-medium text-destructive">{errors[task]}</p>}
                {task === "EMBEDDING" && (
                  <p className="text-xs text-muted-foreground">{t("Documents are indexed with this model. Embeddings must be 1536-dimensional (for OpenAI text-embedding-3-* this is set automatically).")} {state.tasks.EMBEDDING && t("Clear it only if you don't need document search.")}</p>
                )}
                {embeddingChanged && (
                  <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-xs"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden /> {rich("Existing documents were indexed with a different embedding model and won't be searched until you reprocess them from the {link} page.", { link: <Link href="/documents" className="underline">{t("Documents")}</Link> })}</p>
                )}
                {task === "EMBEDDING" && state.tasks.EMBEDDING && (
                  <Button type="button" variant="ghost" size="sm" className="rounded-xl" onClick={() => setState((s) => ({ ...s, tasks: { ...s.tasks, EMBEDDING: null } }))}>{t("Clear embedding model")}</Button>
                )}
              </CardContent>
            )}
          </Card>
        );
      })}

      <div className="sticky bottom-0 flex items-center justify-end gap-3 rounded-2xl border bg-card/95 p-3 shadow-card backdrop-blur">
        {prefs.data.default && <p className="mr-auto text-xs text-muted-foreground">{t("Saved default:")} <span className="font-mono">{prefs.data.default.provider.toLowerCase()} / {prefs.data.default.modelId}</span></p>}
        <Button type="submit" className="rounded-xl" disabled={save.isPending}>{save.isPending && <Loader2 className="animate-spin" aria-hidden />} {t("Save settings")}</Button>
      </div>
    </form>
  );
}
