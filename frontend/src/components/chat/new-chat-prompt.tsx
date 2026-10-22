"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiSend } from "@/lib/api";
import type { Conversation } from "./types";

export function NewChatPrompt() {
  const router = useRouter();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (mode: "GENERAL" | "DOCUMENT_ONLY") => apiSend<{ conversation: Conversation }>("POST", "/api/conversations", { mode }),
    onSuccess: ({ conversation }) => {
      void qc.invalidateQueries({ queryKey: ["chat", "conversations"] });
      router.push(`/chat/${conversation.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : "Couldn't create the conversation."),
  });
  const options = [
    { mode: "DOCUMENT_ONLY" as const, icon: FileText, title: "Ask my documents", text: "Answers come only from the documents you attach, with sources. If they don't contain the answer, you'll be told." },
    { mode: "GENERAL" as const, icon: MessageSquare, title: "General question", text: "Chat with your chosen model. Attach documents if you want them used as extra context." },
  ];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Start a conversation</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose how you want answers to be produced. You can switch later.</p>
      </div>
      <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
        {options.map(({ mode, icon: Icon, title, text }) => (
          <button key={mode} type="button" onClick={() => create.mutate(mode)} disabled={create.isPending} className="rounded-2xl border bg-card p-5 text-left shadow-card transition hover:border-primary/50 disabled:opacity-60">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">{create.isPending && create.variables === mode ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Icon className="size-5" aria-hidden />}</span>
            <h2 className="mt-3 font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{text}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
