"use client";

import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListFilter, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiGet } from "@/lib/api";
import { useT } from "@/lib/i18n/client";

export type PublicModel = { id: string; name: string; context_length: number | null; free: boolean; supported_parameters: string[] | null };
type Listing = { available: boolean; total: number; models: PublicModel[]; match: PublicModel | null };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readPublicModel(raw: unknown): PublicModel | null {
  if (!isRec(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : raw.id,
    context_length: typeof raw.context_length === "number" ? raw.context_length : null,
    free: raw.free === true,
    supported_parameters: Array.isArray(raw.supported_parameters) ? raw.supported_parameters.filter((x): x is string => typeof x === "string") : null,
  };
}

export function readListing(raw: unknown): Listing {
  const r = isRec(raw) ? raw : {};
  return {
    available: r.available === true,
    total: typeof r.total === "number" ? r.total : 0,
    models: (Array.isArray(r.models) ? r.models : []).map(readPublicModel).filter((m): m is PublicModel => m !== null),
    match: readPublicModel(r.match),
  };
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/**
 * Looks up ONE exact model id in the provider's public list (free, no key) so the form can show which settings the provider lists for it.
 * Never blocks anything: an unknown id simply returns no match.
 */
export function useModelMatch(provider: string, kind: "chat" | "embedding", modelId: string | null) {
  return useQuery({
    queryKey: ["ai", "public-model", provider, kind, modelId],
    queryFn: async () => readListing(await apiGet<unknown>(`/api/ai/public-models?${qs({ provider, kind, exact: modelId! })}`)).match,
    enabled: Boolean(modelId),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * Optional "Browse models": suggestions from the provider's PUBLIC model list (loaded only when opened; no key, no cost).
 * Picking one just fills the text box; anything can still be typed by hand.
 */
export function ModelSuggestions({ kind, provider, onPick, label }: { kind: "chat" | "embedding"; provider: string; onPick: (id: string) => void; label: string }) {
  const t = useT();
  const ids = { q: useId(), free: useId() };
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(h);
  }, [text]);

  const list = useQuery({
    queryKey: ["ai", "public-models", provider, kind, q, freeOnly],
    queryFn: async () => readListing(await apiGet<unknown>(`/api/ai/public-models?${qs({ provider, kind, q, free: freeOnly ? "1" : "0" })}`)),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-xl" aria-label={label}>
          <ListFilter aria-hidden /> {t("Browse models")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,28rem)] space-y-3 p-3">
        <p className="text-xs text-muted-foreground">{t("Suggestions from the provider's public model list. You can always type any model ID yourself.")}</p>
        <div className="space-y-1.5">
          <Label htmlFor={ids.q} className="sr-only">{t("Search models")}</Label>
          <Input id={ids.q} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Search by name or ID")} autoComplete="off" spellCheck={false} className="h-9 rounded-xl" />
          <div className="flex items-center gap-2">
            <Checkbox id={ids.free} checked={freeOnly} onCheckedChange={(v) => setFreeOnly(v === true)} />
            <Label htmlFor={ids.free} className="text-sm font-normal">{t("Free models only")}</Label>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-xl border" role="listbox" aria-label={t("Model suggestions")} aria-busy={list.isFetching}>
          {list.isLoading && <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> {t("Loading…")}</p>}
          {list.isError && <p className="p-3 text-sm text-muted-foreground">{t("The model list couldn't be loaded. You can still type a model ID.")}</p>}
          {list.data && !list.data.available && <p className="p-3 text-sm text-muted-foreground">{t("This provider doesn't publish a model list. Type the exact model ID.")}</p>}
          {list.data?.available && list.data.models.length === 0 && <p className="p-3 text-sm text-muted-foreground">{t("No models match.")}</p>}
          <ul>
            {list.data?.models.map((m) => (
              <li key={m.id} role="option" aria-selected={false}>
                <button type="button" className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" onClick={() => { onPick(m.id); setOpen(false); }}>
                  <span className="flex items-center gap-2 text-sm font-medium"><span className="break-all font-mono text-xs">{m.id}</span>{m.free && <Badge variant="secondary" className="rounded-full">{t("Free")}</Badge>}</span>
                  <span className="text-xs text-muted-foreground">{m.name}{m.context_length ? ` · ${t("{n} tokens of context", { n: m.context_length.toLocaleString() })}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {list.data?.available && list.data.total > list.data.models.length && <p className="text-xs text-muted-foreground">{t("Showing {shown} of {total}. Type to narrow the list.", { shown: list.data.models.length, total: list.data.total })}</p>}
      </PopoverContent>
    </Popover>
  );
}
