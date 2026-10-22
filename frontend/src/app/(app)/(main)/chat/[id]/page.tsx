import type { Metadata } from "next";
import { ChatView } from "@/components/chat/chat-view";
import { requireMe } from "@/lib/server/backend";

export const metadata: Metadata = { title: "Conversation" };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireMe(`/chat/${id}`);
  return <ChatView key={id} conversationId={id} />;
}
