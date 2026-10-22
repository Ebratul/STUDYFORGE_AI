"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, BookMarked, Check, Copy, Loader2, RefreshCw, Sparkles, Square, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { describeProviderCode } from "@/lib/ai";
import { SafeMarkdown } from "./safe-markdown";
import type { ChatMessage, Citation } from "./types";

export function CopyButton({ text, label = "Copy message" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}

function CitationChip({ c }: { c: Citation }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs hover:border-primary/50" data-testid="citation-chip">
          <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">{c.ordinal}</span>
          <span className="truncate">{c.documentName}</span>
          {c.page != null && <span className="text-muted-foreground">· p.{c.page}</span>}
          {c.page == null && c.section && <span className="truncate text-muted-foreground">· {c.section}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm" align="start">
        <p className="font-medium">{c.documentName}{c.documentId === null && <span className="ml-1 text-xs font-normal text-muted-foreground">(document deleted)</span>}</p>
        <p className="text-xs text-muted-foreground">{c.page != null ? `Page ${c.page}` : (c.section ?? "Passage")}</p>
        <blockquote className="mt-2 max-h-48 overflow-y-auto border-l-2 pl-3 text-[13px] italic">{c.quote}</blockquote>
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          {c.quoteVerified ? <><Check className="size-3.5 text-success" aria-hidden /> Verbatim quote, checked against the document text.</> : <><AlertTriangle className="size-3.5 text-warning" aria-hidden /> Excerpt of the source passage; the answer text itself is not quote-verified.</>}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function UserBubble({ text, pending }: { text: string; pending?: boolean }) {
  return (
    <div className="flex justify-end gap-3" data-testid="user-message">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-primary px-4 py-2.5 text-[15px] leading-7 text-primary-foreground">{text}{pending && <span className="sr-only"> (sending)</span>}</div>
      <span className="mt-1 hidden size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground sm:inline-flex"><User className="size-4" aria-hidden /></span>
    </div>
  );
}

export function AssistantBubble({
  message, streamingText, stage, isLast, canRegenerate, onRegenerate, onStop, retryError,
}: {
  message?: ChatMessage;
  streamingText?: string;
  stage?: string | null;
  isLast: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onStop?: () => void;
  retryError?: boolean;
}) {
  const streaming = streamingText !== undefined;
  const content = streaming ? streamingText : (message?.content ?? "");
  const failed = message?.status === "FAILED";
  const interrupted = message?.status === "INTERRUPTED";
  const insufficient = message?.insufficientEvidence;

  return (
    <div className="flex gap-3" data-testid="assistant-message" data-status={streaming ? "STREAMING" : message?.status}>
      <span className="mt-1 hidden size-8 shrink-0 items-center justify-center rounded-full bg-accent text-primary sm:inline-flex"><Sparkles className="size-4" aria-hidden /></span>
      <div className="min-w-0 max-w-[92%] flex-1">
        {insufficient ? (
          <div className="rounded-2xl rounded-tl-md border border-warning/40 bg-warning-soft px-4 py-3 text-[15px] leading-7" data-testid="insufficient-evidence">
            <p className="flex items-start gap-2"><BookMarked className="mt-1 size-4 shrink-0 text-warning" aria-hidden /> <span>{content}</span></p>
          </div>
        ) : (
          <div className="rounded-2xl rounded-tl-md border bg-card px-4 py-2.5 shadow-xs">
            {content ? <SafeMarkdown>{content}</SafeMarkdown> : streaming ? (
              <p className="flex items-center gap-2 py-1 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" aria-hidden /> {stage === "retrieving" ? "Searching your documents…" : stage === "verifying" ? "Checking sources…" : "Thinking…"}</p>
            ) : failed || interrupted ? <p className="py-1 text-sm text-muted-foreground">No text was produced.</p> : null}
            {streaming && content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-middle" aria-hidden />}
          </div>
        )}

        {failed && (
          <p role="alert" className="mt-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {describeProviderCode(message?.errorCode)}
          </p>
        )}
        {interrupted && <p className="mt-2 text-xs text-muted-foreground" role="status">Response stopped.</p>}

        {message && message.citations.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Sources">
            {message.citations.map((c) => <CitationChip key={c.ordinal} c={c} />)}
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {streaming ? (
            onStop && <Button size="xs" variant="outline" className="rounded-full" onClick={onStop} aria-label="Stop generating"><Square className="fill-current" aria-hidden /> Stop</Button>
          ) : (
            <>
              {content && <CopyButton text={content} label="Copy response" />}
              {isLast && canRegenerate && (
                <Button size="icon-sm" variant="ghost" aria-label={failed || retryError ? "Retry" : "Regenerate response"} onClick={onRegenerate}><RefreshCw aria-hidden /></Button>
              )}
              {message?.provider && message.model && <Badge variant="outline" className="rounded-full font-mono text-[10px]" title="Provider and model that produced this answer">{message.provider} · {message.model}</Badge>}
              {message?.mode === "DOCUMENT_ONLY" && <Badge variant="outline" className="rounded-full text-[10px]">Documents only</Badge>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function SetupLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="font-medium underline">{children}</Link>;
}
