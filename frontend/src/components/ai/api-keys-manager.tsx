"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Plug, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { describeProviderCode, STATUS_LABEL, type CredentialStatus, type ProviderInfo, type ProvidersResponse } from "@/lib/ai";
import { KeyDialog } from "./key-dialog";

const STATUS_STYLE: Record<CredentialStatus, string> = {
  UNTESTED: "bg-muted text-muted-foreground",
  VALID: "bg-success-soft text-success",
  INVALID: "bg-destructive/10 text-destructive",
  ERROR: "bg-warning-soft text-warning",
};

export function ApiKeysManager({ initial }: { initial: ProvidersResponse }) {
  const qc = useQueryClient();
  const { data, isError, refetch } = useQuery({ queryKey: ["ai", "providers"], queryFn: () => apiGet<ProvidersResponse>("/api/ai/providers"), initialData: initial });
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [deleting, setDeleting] = useState<ProviderInfo | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["ai"] });
  };

  const test = useMutation({
    mutationFn: (p: ProviderInfo) => apiSend<{ ok: boolean; code?: string; modelsCount?: number }>("POST", `/api/ai/credentials/${p.id}/test`),
    onSuccess: (r, p) => {
      if (r.ok) toast.success(`${p.name} connection works${r.modelsCount != null ? ` (${r.modelsCount} models)` : ""}`);
      else toast.error(describeProviderCode(r.code));
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't run the test."),
  });

  const remove = useMutation({
    mutationFn: (p: ProviderInfo) => apiSend("DELETE", `/api/ai/credentials/${p.id}`),
    onSuccess: (_r, p) => {
      toast.success(`${p.name} key deleted`);
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't delete the key."),
  });

  if (isError) {
    return (
      <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-sm">
        Couldn&apos;t load providers. <Button variant="link" className="h-auto p-0" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex items-start gap-3 rounded-2xl border bg-card p-4 text-sm shadow-card">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
        <p className="text-muted-foreground">
          <strong className="text-foreground">Bring your own key.</strong> Keys are encrypted on the server (AES-256-GCM) and only used for your own requests. They are never sent to your browser after you save them, never logged, and never shared with another user or provider. Usage is billed by the provider to your account.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {data.providers.map((p) => {
          const c = p.credential;
          return (
            <Card key={p.id} className="rounded-2xl shadow-card" data-testid={`provider-${p.id}`}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4 text-primary" aria-hidden /> {p.name}</CardTitle>
                    <CardDescription className="mt-1">
                      {p.capabilities.embeddings ? "Chat and embeddings" : "Chat only (no embeddings)"}
                    </CardDescription>
                  </div>
                  <Badge className={`rounded-full ${c ? STATUS_STYLE[c.status] : "bg-muted text-muted-foreground"}`} variant="secondary">{c ? STATUS_LABEL[c.status] : "No key"}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {c ? (
                  <>
                    <p>Key: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" aria-label={`Saved key ending in ${c.masked.slice(-4)}`}>{c.masked}</code></p>
                    <p className="text-xs text-muted-foreground">
                      {c.rotatedAt ? `Rotated ${new Date(c.rotatedAt).toLocaleDateString()}` : `Added ${new Date(c.createdAt).toLocaleDateString()}`}
                      {c.lastTestedAt && ` · tested ${new Date(c.lastTestedAt).toLocaleString()}`}
                    </p>
                    {c.status === "INVALID" || c.status === "ERROR" ? <p className="text-xs text-destructive">{describeProviderCode(c.lastErrorCode)}</p> : null}
                  </>
                ) : (
                  <p className="text-muted-foreground">Add a key to use {p.name} models.</p>
                )}
                {p.embedding_dimensions_note && <p className="text-xs text-muted-foreground">{p.embedding_dimensions_note}</p>}
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                <Button size="sm" className="rounded-xl" onClick={() => setEditing(p)}>{c ? "Rotate key" : "Add key"}</Button>
                {c && (
                  <>
                    <Button size="sm" variant="outline" className="rounded-xl" onClick={() => test.mutate(p)} disabled={test.isPending}>
                      {test.isPending && test.variables?.id === p.id ? <Loader2 className="animate-spin" aria-hidden /> : <Plug aria-hidden />} Test
                    </Button>
                    <Button size="sm" variant="ghost" className="rounded-xl text-destructive hover:text-destructive" onClick={() => setDeleting(p)}>
                      <Trash2 aria-hidden /> Delete
                    </Button>
                  </>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {editing && <KeyDialog provider={editing} open onOpenChange={(o) => !o && setEditing(null)} onSaved={refresh} />}

      <Dialog open={Boolean(deleting)} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name} key?</DialogTitle>
            <DialogDescription>The key is permanently removed from our servers and any model settings that use it are cleared. Chat and document processing with {deleting?.name} will stop until you add a key again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" className="rounded-xl" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              {remove.isPending && <RefreshCw className="animate-spin" aria-hidden />} Delete key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
