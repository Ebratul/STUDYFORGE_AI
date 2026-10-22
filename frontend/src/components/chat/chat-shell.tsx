"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ConversationList } from "./conversation-list";

/** Two-pane layout; on small screens only one pane is visible (list at /chat, conversation at /chat/:id). */
export function ChatShell({ children }: { children: React.ReactNode }) {
  const inConversation = usePathname().split("/").length > 2;
  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-4rem)] overflow-hidden bg-card sm:-mx-6 lg:-mx-8 lg:h-[calc(100dvh-4rem-1.5rem)]">
      <ConversationList className={cn("w-full md:w-72 md:shrink-0 lg:w-80", inConversation ? "hidden md:flex" : "flex")} />
      <section className={cn("min-w-0 flex-1 flex-col", inConversation ? "flex" : "hidden md:flex")} aria-label="Conversation">{children}</section>
    </div>
  );
}
