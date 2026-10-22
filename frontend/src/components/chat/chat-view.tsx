"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowUp, FileText, Loader2, MessageSquare, Square } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiGet, apiSend } from "@/lib/api";
import { describeProviderCode, type PreferencesResponse } from "@/lib/ai";
import { takePrompt } from "@/lib/assistant";
import { cn } from "@/lib/utils";
import { DocumentPicker } from "./document-picker";
import { AssistantBubble, UserBubble } from "./message-item";
import { MAX_MESSAGE_CHARS, type Conversation, type MessagesPage } from "./types";
import { useChatStream } from "./use-chat-stream";

export function ChatView({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const stream = useChatStream(conversationId);

  const conv = useQuery({ queryKey: ["chat", "conversation", conversationId], queryFn: async () => (await apiGet<{ conversation: Conversation }>(`/api/conversations/${conversationId}`)).conversation, retry: false });
  const prefs = useQuery({ queryKey: ["ai", "preferences"], queryFn: () => apiGet<PreferencesResponse>("/api/ai/preferences"), staleTime: 30_000 });
  const history = useInfiniteQuery({
    queryKey: ["chat", "messages", conversationId],
    queryFn: ({ pageParam }) => apiGet<MessagesPage>(`/api/conversations/${conversationId}/messages?limit=30${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const messages = [...(history.data?.pages ?? [])].reverse().flatMap((p) => p.items);

  // A prompt handed over by the study assistant (result page, study plan) is sent once, as soon as the conversation is ready.
  const ready = conv.isSuccess && history.isSuccess && prefs.isSuccess && Boolean(prefs.data?.tasks.CHAT ?? prefs.data?.default) && messages.length === 0;
  useEffect(() => {
    if (!ready || stream.busy) return;
    const prompt = takePrompt(conversationId); // removes it: a reload or re-render can never send it twice
    if (prompt) void stream.send(prompt.slice(0, MAX_MESSAGE_CHARS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => apiSend<{ conversation: Conversation }>("PATCH", `/api/conversations/${conversationId}`, patch),
    onSuccess: ({ conversation }) => {
      qc.setQueryData(["chat", "conversation", conversationId], conversation);
      void qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? (err.fields.title ?? err.message) : "Couldn't update the conversation."),
  });

  // Keep the view pinned to the newest message; preserve position when older history is prepended.
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, stream.draft?.assistantText, stream.draft?.userText, stream.error]);

  if (conv.isError) {
    const notFound = conv.error instanceof ApiError && conv.error.status === 404;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="font-medium">{notFound ? "This conversation doesn't exist." : "Couldn't load this conversation."}</p>
        <Button asChild variant="outline" className="rounded-xl"><Link href="/chat">Back to conversations</Link></Button>
      </div>
    );
  }

  const c = conv.data;
  const chatModel = prefs.data?.tasks.CHAT ?? prefs.data?.default ?? null;
  const embeddingModel = prefs.data?.tasks.EMBEDDING ?? null;
  const needsModel = prefs.isSuccess && !chatModel;
  const docCount = c?.documentIds.length ?? 0;
  const last = messages[messages.length - 1];
  const lastAssistant = last?.role === "ASSISTANT" ? last : undefined;
  const sending = stream.busy;

  async function submit() {
    const content = text.trim();
    if (!content || sending) return;
    setText("");
    await stream.send(content);
  }

  const err = stream.error;
  const errMessage = err ? (err.code === "NOT_CONFIGURED" || err.code === "QUOTA_EXCEEDED" || err.code === "CONFLICT" || err.code === "VALIDATION" || err.code === "NETWORK" ? err.message : describeProviderCode(err.code) || err.message) : null;

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5 sm:px-4">
        <Button asChild variant="ghost" size="icon-sm" className="md:hidden"><Link href="/chat" aria-label="Back to conversations"><ArrowLeft aria-hidden /></Link></Button>
        <div className="min-w-0 flex-1">
          {editingTitle && c ? (
            <form onSubmit={(e) => { e.preventDefault(); if (titleDraft.trim()) update.mutate({ title: titleDraft.trim() }); setEditingTitle(false); }}>
              <input autoFocus value={titleDraft} maxLength={120} onChange={(e) => setTitleDraft(e.target.value)} onBlur={() => setEditingTitle(false)} aria-label="Conversation title" className="w-full rounded-md border bg-background px-2 py-1 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </form>
          ) : (
            <button type="button" className="max-w-full truncate rounded-md px-1 text-left text-sm font-semibold hover:bg-accent/60" title="Click to rename" onClick={() => { setTitleDraft(c?.title ?? ""); setEditingTitle(true); }} disabled={!c}>
              {c?.title ?? <Skeleton className="h-4 w-40" />}
            </button>
          )}
          <p className="px-1 text-xs text-muted-foreground" data-testid="model-badge">
            {chatModel ? <span className="font-mono">{chatModel.provider.toLowerCase()} · {chatModel.modelId}</span> : "No model selected"}
          </p>
        </div>

        <div role="radiogroup" aria-label="Answer policy" className="inline-flex rounded-full border bg-muted p-0.5 text-xs">
          {([["DOCUMENT_ONLY", "Documents only", FileText], ["GENERAL", "General AI", MessageSquare]] as const).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={c?.mode === mode}
              disabled={!c || sending || update.isPending}
              onClick={() => c?.mode !== mode && update.mutate({ mode })}
              className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium transition-colors", c?.mode === mode ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
            >
              <Icon className="size-3.5" aria-hidden /> {label}
            </button>
          ))}
        </div>
        <DocumentPicker selected={c?.documentIds ?? []} onChange={(ids) => update.mutate({ documentIds: ids })} disabled={!c || sending} />
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6" aria-live="polite" aria-busy={sending}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {needsModel && (
            <Alert className="border-warning/40 bg-warning-soft">
              <AlertTriangle aria-hidden />
              <AlertTitle>Choose a model to start chatting</AlertTitle>
              <AlertDescription>Add an API key and pick a default model in <Link href="/settings/api-keys" className="font-medium underline">API keys</Link> and <Link href="/settings/providers" className="font-medium underline">AI providers</Link>.</AlertDescription>
            </Alert>
          )}
          {c?.mode === "DOCUMENT_ONLY" && (
            <Alert>
              <FileText aria-hidden />
              <AlertTitle>Documents-only mode</AlertTitle>
              <AlertDescription>
                Answers use only the documents you attach ({docCount} attached), with sources. If they don&apos;t contain the answer, you&apos;ll be told so — the model never falls back to general knowledge.
                {docCount === 0 && " Attach a document to get started."}
                {docCount > 0 && !embeddingModel && <> Choose an <Link href="/settings/providers" className="font-medium underline">embedding model</Link> to search them.</>}
              </AlertDescription>
            </Alert>
          )}

          {history.hasNextPage && (
            <Button variant="ghost" size="sm" className="self-center rounded-full" disabled={history.isFetchingNextPage} onClick={() => { prevHeight.current = scroller.current?.scrollHeight ?? 0; loadingOlder.current = true; void history.fetchNextPage(); }}>
              {history.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden />} Load earlier messages
            </Button>
          )}
          {history.isLoading && <div className="space-y-4" role="status" aria-label="Loading messages"><Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" /><Skeleton className="h-24 w-4/5 rounded-2xl" /></div>}
          {history.isError && <p role="alert" className="text-center text-sm text-destructive">Couldn&apos;t load messages. <button className="underline" onClick={() => void history.refetch()}>Retry</button></p>}
          {!history.isLoading && messages.length === 0 && !stream.draft && (
            <div className="py-16 text-center text-sm text-muted-foreground">
              <p className="text-base font-medium text-foreground">Ask your first question</p>
              <p className="mt-1">{c?.mode === "DOCUMENT_ONLY" ? "Attach documents above, then ask about their content." : "Ask anything — or attach documents to ground the answer."}</p>
            </div>
          )}

          {messages.map((m) =>
            m.role === "USER" ? (
              <UserBubble key={m.id} text={m.content} />
            ) : (
              <AssistantBubble key={m.id} message={m} isLast={m.id === lastAssistant?.id} canRegenerate={!sending} onRegenerate={() => void stream.regenerate()} />
            ),
          )}

          {stream.draft && (
            <>
              {stream.draft.userText !== null && <UserBubble text={stream.draft.userText} pending />}
              <AssistantBubble streamingText={stream.draft.assistantText} stage={stream.draft.stage} isLast canRegenerate={false} onRegenerate={() => undefined} onStop={stream.stop} />
              {stream.draft.warnings.length > 0 && <p className="text-xs text-warning" role="status">{stream.draft.warnings.join(" ")}</p>}
            </>
          )}

          {err && !stream.draft && (
            <Alert variant="destructive" role="alert" data-testid="chat-error">
              <AlertTriangle aria-hidden />
              <AlertTitle>{err.code === "PROVIDER_RATE_LIMITED" ? "Rate limit reached" : err.code === "QUOTA_EXCEEDED" ? "Daily limit reached" : "Couldn't get an answer"}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{errMessage}{err.retryAfter ? ` Try again in about ${err.retryAfter} seconds.` : ""}</p>
                <div className="flex flex-wrap gap-2">
                  {err.retryable && lastAssistantOrUser(messages) && <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void stream.regenerate()}>Retry</Button>}
                  {(err.code === "NOT_CONFIGURED" || err.code === "CONFLICT") && <Button asChild size="sm" variant="outline" className="rounded-xl"><Link href="/settings/providers">Open model settings</Link></Button>}
                  {(err.code === "PROVIDER_AUTH_INVALID" || err.code === "MODEL_NOT_FOUND") && <Button asChild size="sm" variant="outline" className="rounded-xl"><Link href={err.code === "MODEL_NOT_FOUND" ? "/settings/providers" : "/settings/api-keys"}>{err.code === "MODEL_NOT_FOUND" ? "Change model" : "Fix API key"}</Link></Button>}
                  <Button size="sm" variant="ghost" className="rounded-xl" onClick={stream.clearError}>Dismiss</Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="border-t bg-card px-3 py-3 sm:px-6"
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <div className="relative flex-1">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
              placeholder={c?.mode === "DOCUMENT_ONLY" ? "Ask about your documents…" : "Ask anything…"}
              aria-label="Message"
              rows={2}
              maxLength={MAX_MESSAGE_CHARS}
              disabled={!c || needsModel}
              className="max-h-40 min-h-[3.25rem] resize-none rounded-2xl pr-3"
            />
            {text.length > MAX_MESSAGE_CHARS * 0.8 && <span className="absolute bottom-1.5 right-3 text-[10px] text-muted-foreground">{text.length}/{MAX_MESSAGE_CHARS}</span>}
          </div>
          {sending ? (
            <Button type="button" size="icon-lg" variant="outline" className="rounded-full" onClick={stream.stop} aria-label="Stop generating"><Square className="fill-current" aria-hidden /></Button>
          ) : (
            <Button type="submit" size="icon-lg" className="rounded-full" disabled={!text.trim() || !c || needsModel} aria-label="Send message"><ArrowUp aria-hidden /></Button>
          )}
        </div>
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-muted-foreground">AI can make mistakes. Check important facts against your sources.</p>
      </form>
    </>
  );
}

function lastAssistantOrUser(messages: { role: string }[]) {
  return messages.length > 0;
}
