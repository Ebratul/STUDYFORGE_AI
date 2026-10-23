"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleSlash, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet, apiSend } from "@/lib/api";
import { useI18n, useRich } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  buildBody, CHAT_EXAMPLE, CHECK_ORDER, checkMessage, EMBEDDING_EXAMPLE, feedbackFromError, previewProvider, readChecks, readConnection, validateApiKey, validateModelId,
  type CheckName, type Checks, type Connection, type SaveFeedback,
} from "./connection-helpers";
import { ReembedButton } from "./reembed-button";

type Field = "apiKey" | "chatModelId" | "embeddingModelId";

function CheckRow({ name, check, expected }: { name: CheckName; check: Checks[CheckName]; expected: number }) {
  const { t } = useI18n();
  const label = name === "auth" ? t("API key") : name === "chat" ? t("Chat model") : t("Embedding model");
  const Icon = check.skipped || check.ok === null ? CircleSlash : check.ok ? CheckCircle2 : XCircle;
  const tone = check.skipped || check.ok === null ? "text-muted-foreground" : check.ok ? "text-success" : "text-destructive";
  const state = check.skipped || check.ok === null ? t("Skipped") : check.ok ? t("Passed") : t("Failed");
  return (
    <li className="flex items-start gap-2 text-sm" data-testid={`check-${name}`} data-state={check.skipped || check.ok === null ? "skipped" : check.ok ? "ok" : "failed"}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
      <span><strong>{label}</strong> <span className="sr-only">{state}. </span>— {checkMessage(name, check, t, expected)}</span>
    </li>
  );
}

/**
 * The AI connection: exactly three text inputs (API key, chat model ID, embedding model ID). The provider is derived by the server from
 * the key; the server tests the key and both models before anything is saved and keeps the previous configuration on failure.
 */
export function AiConnectionForm({ initial }: { initial: Connection }) {
  const { t, format } = useI18n();
  const rich = useRich();
  const qc = useQueryClient();
  const ids = { key: useId(), chat: useId(), emb: useId() };
  const q = useQuery({
    queryKey: ["ai", "connection"],
    queryFn: async () => readConnection(await apiGet<unknown>("/api/ai/connection")) ?? initial,
    initialData: initial,
    refetchInterval: (query) => ((query.state.data?.documents.processing ?? 0) > 0 ? 3000 : false),
  });
  const conn = q.data;
  const [apiKey, setApiKey] = useState("");
  const [chat, setChat] = useState(initial.chatModelId ?? "");
  const [emb, setEmb] = useState(initial.embeddingModelId ?? "");
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [feedback, setFeedback] = useState<SaveFeedback | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const hasKey = conn.apiKey.configured;
  const local: Record<Field, string | null> = { apiKey: validateApiKey(apiKey, hasKey, t), chatModelId: validateModelId(chat, t), embeddingModelId: validateModelId(emb, t) };
  const server = feedback?.fields ?? {};
  const err = (f: Field) => (touched[f] ? local[f] : null) ?? server[f] ?? null;
  const invalid = Object.values(local).some(Boolean);
  const typed = previewProvider(apiKey);
  const providerLabel = typed?.label ?? conn.providerLabel;

  const save = useMutation({
    mutationFn: () => apiSend<unknown>("PUT", "/api/ai/connection", buildBody({ apiKey, chatModelId: chat, embeddingModelId: emb })),
    onMutate: () => { setFeedback(null); setChecks(null); setSavedOk(false); },
    onSuccess: (res) => {
      const r = (res ?? {}) as Record<string, unknown>;
      const next = readConnection(r);
      if (next) qc.setQueryData(["ai", "connection"], next);
      void qc.invalidateQueries({ queryKey: ["ai", "connection"] });
      setChecks(readChecks(r.checks));
      setApiKey("");
      setShow(false);
      setTouched({});
      setSavedOk(true);
      toast.success(t("Connection verified and saved."));
      if (r.reembedRequired === true) toast.message(t("Your embedding model changed — re-embed your documents so they stay searchable."));
    },
    onError: (e) => {
      const f = feedbackFromError(e, t);
      setFeedback(f);
      setChecks(f.checks);
      toast.error(f.message);
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ apiKey: true, chatModelId: true, embeddingModelId: true });
    if (invalid || save.isPending) return;
    save.mutate();
  }

  const stale = conn.documents.stale;
  const expected = conn.expectedDimension;
  const keyHint = hasKey ? t("Key configured {masked} — leave blank to keep it.", { masked: conn.apiKey.masked ?? "••••" }) : t("Stored encrypted on the server. It is never shown again.");

  return (
    <div className="space-y-6">
      {stale > 0 && (
        <Alert className="border-warning/40 bg-warning-soft" data-testid="reembed-banner">
          <AlertTriangle aria-hidden />
          <AlertTitle>{t("{count, plural, one {# document needs re-embedding} other {# documents need re-embedding}}", { count: stale })}</AlertTitle>
          <AlertDescription>
            <p>{t("They were indexed with a different embedding model, so they are not searched until they are re-embedded. Your original text and permissions are kept; the old index stays until the new one is complete.")}</p>
            <div className="mt-3"><ReembedButton count={stale} /></div>
          </AlertDescription>
        </Alert>
      )}

      {conn.mixedProviders && (
        <Alert data-testid="mixed-hint">
          <AlertTriangle aria-hidden />
          <AlertTitle>{t("Please save your connection once more")}</AlertTitle>
          <AlertDescription>{t("Your chat and embedding models were saved with different accounts in an older version of this page. Enter your key and both model IDs below and save once to bring them together.")}</AlertDescription>
        </Alert>
      )}

      <Card className="rounded-2xl shadow-card">
        <form onSubmit={submit} noValidate aria-describedby={`${ids.key}-intro`}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><KeyRound className="size-5 text-primary" aria-hidden /> {t("Connect your AI account")}</CardTitle>
            <CardDescription id={`${ids.key}-intro`}>
              {t("Enter your API key and the exact model IDs your provider offers. Nothing is hard-coded: if your provider accepts the IDs, they work.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor={ids.key}>{t("API key")}</Label>
              <div className="flex gap-2">
                <Input
                  id={ids.key} name="apiKey" type={show ? "text" : "password"} value={apiKey} onChange={(e) => { setApiKey(e.target.value); setSavedOk(false); }} onBlur={() => setTouched((x) => ({ ...x, apiKey: true }))}
                  autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(err("apiKey"))} aria-describedby={`${ids.key}-hint ${ids.key}-err`}
                  placeholder={hasKey ? "••••••••••••" : "sk-or-v1-…"} className="h-10 rounded-xl font-mono"
                />
                <Button type="button" variant="outline" className="h-10 rounded-xl" aria-pressed={show} aria-controls={ids.key} onClick={() => setShow((s) => !s)}>
                  {show ? <EyeOff aria-hidden /> : <Eye aria-hidden />} {show ? t("Hide") : t("Show")}
                  <span className="sr-only"> {t("API key")}</span>
                </Button>
              </div>
              <p id={`${ids.key}-hint`} className="text-xs text-muted-foreground" data-testid="key-hint">{keyHint}</p>
              <p id={`${ids.key}-err`} role={err("apiKey") ? "alert" : undefined} className="text-sm text-destructive">{err("apiKey")}</p>
              {providerLabel && <p className="text-xs text-muted-foreground" data-testid="provider-line">{typed ? t("Provider: {name} (detected from the key you typed)", { name: providerLabel }) : t("Provider: {name} (detected from your key)", { name: providerLabel })}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={ids.chat}>{t("Chat / LLM model ID")}</Label>
              <Input
                id={ids.chat} name="chatModelId" type="text" value={chat} onChange={(e) => { setChat(e.target.value); setSavedOk(false); }} onBlur={() => setTouched((x) => ({ ...x, chatModelId: true }))}
                autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(err("chatModelId"))} aria-describedby={`${ids.chat}-hint ${ids.chat}-err`}
                placeholder={CHAT_EXAMPLE} className="h-10 rounded-xl font-mono"
              />
              <p id={`${ids.chat}-hint`} className="text-xs text-muted-foreground">{t("Used for conversation, MCQ and CQ generation and AI feedback. Copy the exact model ID from your provider's model list (for OpenRouter: openrouter.ai/models).")}</p>
              <p id={`${ids.chat}-err`} role={err("chatModelId") ? "alert" : undefined} className="text-sm text-destructive">{err("chatModelId")}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={ids.emb}>{t("Embedding model ID")}</Label>
              <Input
                id={ids.emb} name="embeddingModelId" type="text" value={emb} onChange={(e) => { setEmb(e.target.value); setSavedOk(false); }} onBlur={() => setTouched((x) => ({ ...x, embeddingModelId: true }))}
                autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(err("embeddingModelId"))} aria-describedby={`${ids.emb}-hint ${ids.emb}-err`}
                placeholder={EMBEDDING_EXAMPLE} className="h-10 rounded-xl font-mono"
              />
              <p id={`${ids.emb}-hint`} className="text-xs text-muted-foreground">{t("Used for your documents and your questions. It must produce {n}-dimensional vectors. Example: {example}. Copy the exact ID from your provider's model list (for OpenRouter: openrouter.ai/models). Not every chat model supports embeddings.", { n: expected, example: EMBEDDING_EXAMPLE })}</p>
              <p id={`${ids.emb}-err`} role={err("embeddingModelId") ? "alert" : undefined} className="text-sm text-destructive">{err("embeddingModelId")}</p>
            </div>

            <p className="flex items-start gap-2 rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground" data-testid="cost-note">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>{t(conn.costNote)} {t("Your key is encrypted on the server and never sent back to your browser. If the test fails nothing is saved and your current settings keep working.")}</span>
            </p>

            {feedback && (
              <Alert variant="destructive" role="alert" data-testid="save-error">
                <XCircle aria-hidden />
                <AlertTitle>{t("Not saved")}</AlertTitle>
                <AlertDescription>{feedback.message}</AlertDescription>
              </Alert>
            )}

            {checks && (
              <section aria-label={t("Connection test results")} data-testid="check-results">
                <h3 className="mb-2 text-sm font-semibold">{t("What the provider said")}</h3>
                <ul className="space-y-1.5">{CHECK_ORDER.map((n) => <CheckRow key={n} name={n} check={checks[n]} expected={expected} />)}</ul>
              </section>
            )}
          </CardContent>
          <CardFooter className="flex flex-wrap items-center gap-3">
            <Button type="submit" className="rounded-xl" disabled={save.isPending} data-testid="save-connection">
              {save.isPending && <Loader2 className="animate-spin" aria-hidden />} {save.isPending ? t("Testing…") : t("Test and save")}
            </Button>
            <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {save.isPending ? t("Testing the key and both models with your provider…") : savedOk ? t("Saved. Your connection works.") : ""}
            </span>
          </CardFooter>
        </form>
      </Card>

      <Card className="rounded-2xl shadow-card" data-testid="connection-status">
        <CardHeader>
          <CardTitle className="text-base">{t("Current connection")}</CardTitle>
          <CardDescription>{conn.configured ? t("This is what chat, document search, question generation and AI feedback use right now.") : t("Nothing is connected yet. Save the form above to start.")}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">{t("Provider")}</dt><dd>{conn.providerLabel ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">{t("API key")}</dt><dd data-testid="status-key">{hasKey ? <><span className="font-mono">{conn.apiKey.masked}</span> <Badge variant="secondary" className="ml-1 rounded-full">{conn.apiKey.status === "VALID" ? t("Verified") : conn.apiKey.status === "INVALID" ? t("Rejected") : t("Not verified")}</Badge></> : t("No key")}</dd></div>
            <div><dt className="text-muted-foreground">{t("Chat model")}</dt><dd className="break-all font-mono" data-testid="status-chat">{conn.chatModelId ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">{t("Embedding model")}</dt><dd className="break-all font-mono" data-testid="status-embedding">{conn.embeddingModelId ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">{t("Vector size")}</dt><dd data-testid="status-dimension">{conn.embeddingDimension ? t("{n} dimensions (measured)", { n: format.number(conn.embeddingDimension) }) : "—"}</dd></div>
            <div><dt className="text-muted-foreground">{t("Last verified")}</dt><dd>{conn.validatedAt ? format.dateTime(conn.validatedAt) : "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted-foreground">{t("Documents")}</dt><dd data-testid="status-documents">{t("{ready, plural, one {# document ready to search} other {# documents ready to search}}", { ready: conn.documents.ready })}{conn.documents.processing > 0 ? ` · ${t("{n} processing", { n: conn.documents.processing })}` : ""}{stale > 0 ? ` · ${t("{n} need re-embedding", { n: stale })}` : ""}</dd></div>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">{rich("Manage uploaded files on the {link} page.", { link: <Link href="/documents" className="font-medium text-primary underline">{t("Documents")}</Link> })}</p>
        </CardContent>
      </Card>
    </div>
  );
}
