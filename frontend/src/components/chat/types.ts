export type Citation = { ordinal: number; documentId: string | null; documentName: string; page: number | null; section: string | null; quote: string; quoteVerified: boolean };

export type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  status: "COMPLETE" | "STREAMING" | "INTERRUPTED" | "FAILED";
  mode: "GENERAL" | "DOCUMENT_ONLY" | null;
  provider: string | null;
  model: string | null;
  errorCode: string | null;
  insufficientEvidence: boolean;
  createdAt: string;
  citations: Citation[];
};

export type Conversation = { id: string; title: string; mode: "GENERAL" | "DOCUMENT_ONLY"; documentIds: string[]; lastMessageAt: string; createdAt: string };
export type MessagesPage = { items: ChatMessage[]; nextBefore: string | null };
export type ConversationsPage = { items: Conversation[]; nextCursor: string | null };

export type StreamError = { code: string; message: string; retryable: boolean; retryAfter: number | null };

export const MAX_MESSAGE_CHARS = 8000;
