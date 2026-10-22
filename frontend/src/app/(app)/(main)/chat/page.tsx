import type { Metadata } from "next";
import { requireMe } from "@/lib/server/backend";
import { NewChatPrompt } from "@/components/chat/new-chat-prompt";

export const metadata: Metadata = { title: "Conversation" };

export default async function ChatIndexPage() {
  await requireMe("/chat");
  return <NewChatPrompt />;
}
