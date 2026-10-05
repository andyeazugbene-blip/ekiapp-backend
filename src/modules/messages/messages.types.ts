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

export interface StartSupportConversationInput {
  message: string;
}

export interface ListSupportConversationsQuery {
  limit: number;
  cursor?: string;
}

export type SupportStatusFilter = "open" | "closed" | "all";

/** Admin shared-inbox list query (handbook 6.1 / 14.2). */
export interface AdminSupportListQuery {
  limit: number;
  cursor?: string;
  status: SupportStatusFilter;
  unread?: boolean;
  escalated?: boolean;
  reported?: boolean;
  orderLinked?: boolean;
  orderId?: string;
  role?: "buyer" | "vendor";
  q?: string;
}

export interface AdminReplyInput {
  text: string;
  attachments: string[];
  isInternal: boolean;
}

export interface SupportLifecycleInput {
  reason: string;
}
