import type { ConversationType } from "@prisma/client";

export interface CreateConversationInput {
  participantId: string;
  type?: ConversationType;
  orderId?: string;
  initialMessage?: string;
}

export interface SendMessageInput {
  text: string;
  attachments?: string[];
}

export interface ListConversationsQuery {
  limit: number;
  cursor?: string;
}

export interface ListMessagesQuery {
  limit: number;
  cursor?: string;
}
