"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleSlash, Eye, EyeOff, FlaskConical, KeyRound, Loader2, ShieldCheck, SlidersHorizontal, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiGet, apiSend } from "@/lib/api";
import { type EmbeddingChange } from "@/lib/ai";
import { useI18n, useRich } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n/translate";
import { cn } from "@/lib/utils";
import {
  buildBody, CHAT_EXAMPLE, CHECK_ORDER, checkMessage, connectionPollInterval, diagnosticsLine, dimensionPayload, EMBEDDING_EXAMPLE, feedbackFromError, inputsToParams, PARAM_INTEGER, PARAM_ORDER, PARAM_WIRE, paramsToInputs, previewProvider, readChecks,
  readConnection, inferRequest, readDimensionInfo, readEmbeddingChange, shownDimension, validateApiKey, validateDimension, validateModelId, validateParam,
  type CheckName, type Checks, type Connection, type DimensionInfo, type ParamKey, type SaveFeedback,
} from "./connection-helpers";
import { CONNECTION_KEY, EmbeddingReindexPanel } from "./embedding-reindex-panel";
import { ModelSuggestions, useModelMatch } from "./model-suggestions";
import { ReembedButton } from "./reembed-button";

type Field = "apiKey" | "chatModelId" | "embeddingModelId" | "embeddingDimension";

const CHECK_LABEL: Record<CheckName, string> = {
  auth: msg("API key"), chat: msg("Chat model"), chatParams: msg("Generation settings"), embedding: msg("Embedding model"), dimension: msg("Vector size"), database: msg("Database storage"),
};
const PARAM_LABEL: Record<ParamKey, string> = {
  temperature: msg("Temperature"), maxTokens: msg("Maximum output tokens"), topP: msg("Top-p"), frequencyPenalty: msg("Frequency penalty"), presencePenalty: msg("Presence penalty"), seed: msg("Seed"),
};
const PARAM_HINT: Record<ParamKey, string> = {
  temperature: msg("Lower is more focused, higher is more varied."),
  maxTokens: msg("Upper limit for one reply. Question generation and feedback apply their own, smaller caps."),
  topP: msg("Only consider the most likely words that add up to this share."),
  frequencyPenalty: msg("Positive values discourage repeating the same words."),
  presencePenalty: msg("Positive values encourage new topics."),
  seed: msg("A whole number that makes repeated requests more repeatable, where the model supports it."),
};

function CheckRow({ name, check, info }: { name: CheckName; check: Checks[CheckName]; info: DimensionInfo | undefined }) {
  const { t } = useI18n();
  const label = t(CHECK_LABEL[name]);
  const Icon = check.skipped || check.ok === null ? CircleSlash : check.ok ? CheckCircle2 : XCircle;
  const tone = check.skipped || check.ok === null ? "text-muted-foreground" : check.ok ? "text-success" : "text-destructive";
  const state = check.skipped || check.ok === null ? t("Skipped") : check.ok ? t("Passed") : t("Failed");
  const diag = diagnosticsLine(check, t);
  return (
    <li className="flex items-start gap-2 text-sm" data-testid={`check-${name}`} data-state={check.skipped || check.ok === null ? "skipped" : check.ok ? "ok" : "failed"}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
      <span>
        <strong>{label}</strong> <span className="sr-only">{state}. </span>— {checkMessage(name, check, t, info)}
        {diag && <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground" data-testid={`diag-${name}`}>{t("Technical detail")}: {diag}</span>}
      </span>
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
  const ids = { key: useId(), chat: useId(), emb: useId(), dim: useId() };
  const q = useQuery({
    queryKey: CONNECTION_KEY,
    queryFn: async () => readConnection(await apiGet<unknown>("/api/ai/connection")) ?? initial,
    initialData: initial,
    refetchInterval: (query) => connectionPollInterval(query.state.data),
  });
  const conn = q.data;
  const [apiKey, setApiKey] = useState("");
  const [chat, setChat] = useState(initial.chatModelId ?? "");
  const [emb, setEmb] = useState(initial.embeddingModelId ?? "");
  // Untouched = the field mirrors the saved size and nothing is sent; touched = what the user typed (blank = Automatic) is sent.
  const [dimText, setDimText] = useState("");
  const [dimTouched, setDimTouched] = useState(false);
  const [show, setShow] = useState(false);
  const limits = conn.paramLimits;
  const [paramText, setParamText] = useState<Record<ParamKey, string>>(() => paramsToInputs(initial.params));
  const [lookup, setLookup] = useState<string | null>(initial.chatModelId);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [feedback, setFeedback] = useState<SaveFeedback | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [dimInfo, setDimInfo] = useState<DimensionInfo | undefined>(undefined);
  const [change, setChange] = useState<EmbeddingChange | null>(null);

  const hasKey = conn.apiKey.configured;
  const dimShown = shownDimension(dimText, dimTouched, conn.embeddingDimension, emb, conn.embeddingModelId);
  const local: Record<Field, string | null> = {
    apiKey: validateApiKey(apiKey, hasKey, t), chatModelId: validateModelId(chat, t), embeddingModelId: validateModelId(emb, t),
    embeddingDimension: validateDimension(dimShown, conn.dimensionLimits, t),
  };
  const paramErrors = Object.fromEntries(PARAM_ORDER.map((k) => [k, validateParam(k, paramText[k], limits, t)])) as Record<ParamKey, string | null>;
  const server = feedback?.fields ?? {};
  const err = (f: Field) => (touched[f] ? local[f] : null) ?? server[f] ?? null;
  const invalid = Object.values(local).some(Boolean) || Object.values(paramErrors).some(Boolean);
  const typed = previewProvider(apiKey);
  const providerLabel = typed?.label ?? conn.providerLabel;
  const providerId = typed?.id ?? conn.provider ?? "openrouter";
  // Free, key-less lookup of the typed chat model in the provider's public list: which generation settings does it list?
  const match = useModelMatch(providerId, "chat", lookup && !validateModelId(lookup, t) ? lookup.trim() : null);
  const listed = match.data?.supported_parameters ?? null;

  const bodyNow = () => buildBody({ apiKey, chatModelId: chat, embeddingModelId: emb, params: inputsToParams(paramText), ...dimensionPayload(dimShown, dimTouched) });
  const sameEmbeddingModel = conn.embeddingModelId !== null && emb.trim() === conn.embeddingModelId;
  const sentInfo = (): DimensionInfo => ({ measured: null, native: null, ...inferRequest(dimShown, dimTouched, sameEmbeddingModel, conn.embeddingDimension, conn.defaultEmbeddingDimension) });
  const touchAll = () => setTouched({ apiKey: true, chatModelId: true, embeddingModelId: true, embeddingDimension: true });

  // "Test configuration": the same checks as saving, on request only, nothing stored.
  const test = useMutation({
    mutationFn: () => apiSend<unknown>("POST", "/api/ai/connection/test", bodyNow()),
    onMutate: () => { setFeedback(null); setChecks(null); setSavedOk(false); setChange(null); setDimInfo(undefined); },
    onSuccess: (res) => {
      const r = (res ?? {}) as Record<string, unknown>;
      setChecks(readChecks(r.checks));
      setDimInfo(readDimensionInfo(r));
      if (r.ok === true) toast.success(t("Everything checks out. Nothing was saved yet."));
      else toast.error(t("Some checks failed. Nothing was saved."));
    },
    onError: (e) => {
      const f = feedbackFromError(e, t);
      setFeedback(f);
      setChecks(f.checks);
      setDimInfo((prev) => prev ?? sentInfo());
      toast.error(f.message);
    },
  });

  const save = useMutation({
    mutationFn: () => apiSend<unknown>("PUT", "/api/ai/connection", bodyNow()),
    onMutate: () => { setFeedback(null); setChecks(null); setSavedOk(false); setChange(null); setDimInfo(undefined); },
    onSuccess: (res) => {
      const r = (res ?? {}) as Record<string, unknown>;
      const next = readConnection(r);
      if (next) qc.setQueryData(CONNECTION_KEY, next);
      void qc.invalidateQueries({ queryKey: CONNECTION_KEY });
      setChecks(readChecks(r.checks));
      setApiKey("");
      setShow(false);
      if (next) setParamText(paramsToInputs(next.params));
      setTouched({});
      setDimTouched(false);
      setDimText("");
      setSavedOk(true);
      const ch = readEmbeddingChange(r);
      setChange(ch);
      toast.success(t("Connection verified and saved."));
      if (ch.status === "reindexing") toast.message(t("Your new embedding model is being built in the background. Your documents stay searchable with the current one until it is ready."));
    },
    onError: (e) => {
      const f = feedbackFromError(e, t);
      setFeedback(f);
      setChecks(f.checks);
      setDimInfo((prev) => prev ?? sentInfo());
      toast.error(f.message);
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    touchAll();
    if (invalid || save.isPending || test.isPending) return;
    save.mutate();
  }
  function runTest() {
    touchAll();
    if (invalid || save.isPending || test.isPending) return;
    test.mutate();
  }
  const busy = save.isPending || test.isPending;

  const stale = conn.documents.stale;
  const lim = conn.dimensionLimits;
  const dimError = (touched.embeddingDimension ? local.embeddingDimension : null) ?? server.embeddingDimension ?? null;
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

      {conn.reindex && <EmbeddingReindexPanel reindex={conn.reindex} />}

      {change?.status === "reindexing" && !conn.reindex && (
        <Alert data-testid="reindex-notice">
          <AlertTriangle aria-hidden />
          <AlertTitle>{t("Your documents are being re-indexed")}</AlertTitle>
          <AlertDescription>{t("The new embedding model takes over only after every document has a complete, verified new index. Until then the current index stays active and searchable.")}</AlertDescription>
        </Alert>
      )}
      {change?.status === "activated" && (
        <Alert data-testid="activated-notice">
          <CheckCircle2 aria-hidden />
          <AlertTitle>{t("Your new embedding model is active")}</AlertTitle>
          <AlertDescription>{t("It is used for your documents and your questions from now on.")}</AlertDescription>
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
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={ids.chat}>{t("Chat / LLM model ID")}</Label>
                <ModelSuggestions kind="chat" provider={providerId} label={t("Browse chat models")} onPick={(id) => { setChat(id); setLookup(id); setSavedOk(false); setTouched((x) => ({ ...x, chatModelId: true })); }} />
              </div>
              <Input
                id={ids.chat} name="chatModelId" type="text" value={chat} onChange={(e) => { setChat(e.target.value); setSavedOk(false); }} onBlur={() => { setTouched((x) => ({ ...x, chatModelId: true })); setLookup(chat); }}
                autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(err("chatModelId"))} aria-describedby={`${ids.chat}-hint ${ids.chat}-err`}
                placeholder={CHAT_EXAMPLE} className="h-10 rounded-xl font-mono"
              />
              <p id={`${ids.chat}-hint`} className="text-xs text-muted-foreground">{t("Used for conversation, MCQ and CQ generation and AI feedback. Copy the exact model ID from your provider's model list (for OpenRouter: openrouter.ai/models).")}</p>
              <p id={`${ids.chat}-err`} role={err("chatModelId") ? "alert" : undefined} className="text-sm text-destructive">{err("chatModelId")}</p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={ids.emb}>{t("Embedding model ID")}</Label>
                <ModelSuggestions kind="embedding" provider={providerId} label={t("Browse embedding models")} onPick={(id) => { setEmb(id); setSavedOk(false); setTouched((x) => ({ ...x, embeddingModelId: true })); }} />
              </div>
              <Input
                id={ids.emb} name="embeddingModelId" type="text" value={emb} onChange={(e) => { setEmb(e.target.value); setSavedOk(false); }} onBlur={() => setTouched((x) => ({ ...x, embeddingModelId: true }))}
                autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-invalid={Boolean(err("embeddingModelId"))} aria-describedby={`${ids.emb}-hint ${ids.emb}-err`}
                placeholder={EMBEDDING_EXAMPLE} className="h-10 rounded-xl font-mono"
              />
              <p id={`${ids.emb}-hint`} className="text-xs text-muted-foreground">{t("Used for your documents and your questions. Example: {example}. Copy the exact ID from your provider's model list (for OpenRouter: openrouter.ai/models). Not every chat model supports embeddings.", { example: EMBEDDING_EXAMPLE })}</p>
              <p id={`${ids.emb}-err`} role={err("embeddingModelId") ? "alert" : undefined} className="text-sm text-destructive">{err("embeddingModelId")}</p>
            </div>

            <div className="space-y-1.5" data-testid="embedding-dimension-field">
              <Label htmlFor={ids.dim}>{t("Embedding dimensions")} <span className="text-xs font-normal text-muted-foreground">({t("optional")})</span></Label>
              <Input
                id={ids.dim} name="embeddingDimension" type="number" inputMode="numeric" step={1} min={lim.min} max={lim.max} value={dimShown}
                onChange={(e) => { setDimText(e.target.value); setDimTouched(true); setSavedOk(false); }} onBlur={() => setTouched((x) => ({ ...x, embeddingDimension: true }))}
                aria-invalid={Boolean(dimError)} aria-describedby={`${ids.dim}-hint ${ids.dim}-err`}
                placeholder={t("Automatic")} className="h-10 rounded-xl font-mono sm:max-w-56"
              />
              <p id={`${ids.dim}-hint`} className="text-xs text-muted-foreground" data-testid="dimension-hint">
                {conn.defaultEmbeddingDimension
                  ? t("Leave empty for Automatic: this server's default of {n} dimensions is tried, and a size you saved earlier always replaces that default.", { n: format.number(conn.defaultEmbeddingDimension) })
                  : t("Leave empty for Automatic: the model's own vector size is used, and a size you saved earlier is kept.")}{" "}
                {t("Allowed: {min} to {max}.", { min: format.number(lim.min), max: format.number(lim.max) })}{" "}
                {t("Not every model supports every size. When you test or save, StudyForge asks the model for exactly this size and checks the vectors it really returns; they are never padded or truncated. Shorter sizes only work well with models trained for them.")}
              </p>
              <p id={`${ids.dim}-err`} role={dimError ? "alert" : undefined} className="text-sm text-destructive" data-testid="dimension-error">{dimError}</p>
            </div>

            <fieldset className="space-y-3 rounded-xl border p-4" data-testid="generation-settings">
              <legend className="flex items-center gap-2 px-1 text-sm font-semibold"><SlidersHorizontal className="size-4 text-primary" aria-hidden /> {t("Generation settings")} <span className="text-xs font-normal text-muted-foreground">({t("optional")})</span></legend>
              <p className="text-xs text-muted-foreground">
                {t("Leave a field empty to use the provider's default; empty settings are never sent. A setting you fill in is only saved if the model accepts it.")}
                {listed ? ` ${t("Based on the provider's public list for this model.")}` : lookup && match.data === null && !match.isLoading ? ` ${t("This model isn't in the provider's public list, so support is checked when you test.")}` : ""}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {PARAM_ORDER.map((k) => {
                  const id = `${ids.chat}-p-${k}`;
                  const notListed = listed !== null && !listed.includes(PARAM_WIRE[k]) && paramText[k].trim() !== "";
                  const msgText = paramErrors[k];
                  return (
                    <div key={k} className="space-y-1" data-testid={`param-${k}`}>
                      <Label htmlFor={id}>{t(PARAM_LABEL[k])}</Label>
                      <Input
                        id={id} name={k} type="number" inputMode={PARAM_INTEGER[k] ? "numeric" : "decimal"} step={PARAM_INTEGER[k] ? 1 : "any"} min={limits[k].min} max={limits[k].max}
                        value={paramText[k]} onChange={(e) => { setParamText((p) => ({ ...p, [k]: e.target.value })); setSavedOk(false); }}
                        placeholder={t("Provider default")} aria-invalid={Boolean(msgText)} aria-describedby={`${id}-hint`} className="h-10 rounded-xl"
                      />
                      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                        {t(PARAM_HINT[k])} {t("Range {min} to {max}.", { min: limits[k].min, max: limits[k].max })}
                      </p>
                      {msgText && <p role="alert" className="text-sm text-destructive">{msgText}</p>}
                      {notListed && <p className="text-xs text-warning" data-testid={`param-${k}-unlisted`}>{t("The provider's list doesn't show this setting for the chosen model, so saving will likely be refused.")}</p>}
                    </div>
                  );
                })}
              </div>
              {server.params && <p role="alert" className="text-sm text-destructive" data-testid="params-error">{server.params}</p>}
            </fieldset>

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
                <ul className="space-y-1.5">{CHECK_ORDER.map((n) => <CheckRow key={n} name={n} check={checks[n]} info={dimInfo ?? (checks.dimension.dimension ? { measured: checks.dimension.dimension, native: checks.embedding.nativeDimension ?? null, requested: null, source: null } : undefined)} />)}</ul>
              </section>
            )}
          </CardContent>
          <CardFooter className="flex flex-wrap items-center gap-3">
            <Button type="submit" className="rounded-xl" disabled={busy} data-testid="save-connection">
              {save.isPending && <Loader2 className="animate-spin" aria-hidden />} {save.isPending ? t("Testing…") : t("Test and save")}
            </Button>
            <Button type="button" variant="outline" className="rounded-xl" disabled={busy} onClick={runTest} data-testid="test-connection">
              {test.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <FlaskConical aria-hidden />} {test.isPending ? t("Testing…") : t("Test configuration")}
            </Button>
            <span role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {busy ? t("Testing the key, the models and your settings with your provider…") : savedOk ? t("Saved. Your connection works.") : ""}
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
            <div><dt className="text-muted-foreground">{t("Vector size")}</dt><dd data-testid="status-dimension">{conn.embeddingDimension ? t("{n} dimensions (measured)", { n: format.number(conn.embeddingDimension) }) : "—"}{conn.embeddingDimension && conn.embeddingRequestDimensions ? ` · ${t("shortened to {n}", { n: format.number(conn.embeddingRequestDimensions) })}` : ""}{conn.embeddingDimension && conn.defaultEmbeddingDimension ? <span className="mt-0.5 block text-xs text-muted-foreground" data-testid="status-dimension-source">{t("Saved in your settings; this replaces the server default of {n}.", { n: format.number(conn.defaultEmbeddingDimension) })}</span> : null}</dd></div>
            <div><dt className="text-muted-foreground">{t("Last verified")}</dt><dd>{conn.validatedAt ? format.dateTime(conn.validatedAt) : "—"}</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted-foreground">{t("Generation settings")}</dt><dd data-testid="status-params" className="font-mono text-xs">{PARAM_ORDER.filter((k) => conn.params[k] !== null).map((k) => `${PARAM_WIRE[k]}=${conn.params[k]}`).join("  ") || t("Provider defaults")}</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted-foreground">{t("Documents")}</dt><dd data-testid="status-documents">{t("{ready, plural, one {# document ready to search} other {# documents ready to search}}", { ready: conn.documents.ready })}{conn.documents.processing > 0 ? ` · ${t("{n} processing", { n: conn.documents.processing })}` : ""}{stale > 0 ? ` · ${t("{n} need re-embedding", { n: stale })}` : ""}</dd></div>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">{rich("Manage uploaded files on the {link} page.", { link: <Link href="/documents" className="font-medium text-primary underline">{t("Documents")}</Link> })}</p>
        </CardContent>
      </Card>
    </div>
  );
}
