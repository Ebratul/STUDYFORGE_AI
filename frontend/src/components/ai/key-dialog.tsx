"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ApiError, apiSend } from "@/lib/api";
import { describeProviderCode, type ProviderInfo } from "@/lib/ai";

type TestResult = { ok: boolean; code?: string; message?: string; latencyMs?: number; modelsCount?: number };

/**
 * Add or rotate a provider key. The key lives only in this dialog's state; it is sent once over HTTPS to the
 * server, which encrypts it. It is never shown again (only "••••last4").
 */
export function KeyDialog({ provider, open, onOpenChange, onSaved }: { provider: ProviderInfo; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rotating = Boolean(provider.credential);

  function reset() {
    setKey("");
    setResult(null);
    setError(null);
  }

  async function test() {
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      setResult(await apiSend<TestResult>("POST", "/api/ai/credentials/test", { provider: provider.id, apiKey: key }));
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields.apiKey ?? err.message) : "Couldn't run the test.");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiSend("PUT", `/api/ai/credentials/${provider.id}`, { apiKey: key });
      toast.success(rotating ? `${provider.name} key rotated` : `${provider.name} key saved`);
      reset();
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields.apiKey ?? err.message) : "Couldn't save the key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rotating ? `Rotate ${provider.name} key` : `Add ${provider.name} key`}</DialogTitle>
          <DialogDescription>
            Your key is encrypted on the server and never shown again. It is only ever sent to {provider.name}.
            {provider.docs_url && (
              <> <a href={provider.docs_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">Get a key <ExternalLink className="size-3" aria-hidden /></a></>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); if (key && !saving) void save(); }} className="space-y-3" autoComplete="off">
          <div className="space-y-1.5">
            <Label htmlFor={`key-${provider.id}`}>API key</Label>
            <Input
              id={`key-${provider.id}`}
              type="password"
              name={`${provider.id}-api-key`}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={provider.key_hint ?? "Paste your key"}
              value={key}
              onChange={(e) => { setKey(e.target.value.trim()); setResult(null); setError(null); }}
              className="h-10 rounded-xl font-mono"
              aria-describedby={error ? `key-err-${provider.id}` : undefined}
              aria-invalid={error ? true : undefined}
            />
          </div>
          {error && <p id={`key-err-${provider.id}`} role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          {result && (
            <p role="status" className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${result.ok ? "border-success/40 bg-success-soft" : "border-destructive/40 bg-destructive/5"}`}>
              {result.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
              <span>{result.ok ? `Connection works${result.modelsCount != null ? ` — ${result.modelsCount} models visible` : ""}${result.latencyMs != null ? ` (${result.latencyMs} ms)` : ""}.` : describeProviderCode(result.code)}</span>
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="outline" className="rounded-xl" onClick={test} disabled={!key || testing || saving}>
              {testing && <Loader2 className="animate-spin" aria-hidden />} Test connection
            </Button>
            <Button type="submit" className="rounded-xl" disabled={!key || saving}>
              {saving && <Loader2 className="animate-spin" aria-hidden />} {rotating ? "Replace key" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
