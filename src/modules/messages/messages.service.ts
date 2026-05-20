import type { Conversation, Message } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageInput,
} from "./messages.types";

function sortParticipants(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export const messagesService = {
  async createConversation(
    userId: string,
    input: CreateConversationInput,
  ): Promise<Conversation> {
    if (userId === input.participantId) {
      throw new AppError("Cannot create conversation with yourself", 400);
    }

    // Verify the other participant exists
    const otherUser = await prisma.user.findUnique({
      where: { id: input.participantId },
      select: { id: true },
    });
    if (!otherUser) {
      throw new AppError("Participant not found", 404);
    }

    const [participantA, participantB] = sortParticipants(userId, input.participantId);

    // Check if conversation already exists
    const existing = await prisma.conversation.findUnique({
      where: {
        participantA_participantB_orderId: {
          participantA,
          participantB,
          orderId: input.orderId ?? "",
        },
      },
    });

    if (existing) {
      // If there's an initial message, send it
      if (input.initialMessage) {
        await this.sendMessage(userId, existing.id, {
          text: input.initialMessage,
        });
      }
      return existing;
    }

    const conversation = await prisma.conversation.create({
      data: {
        type: input.type ?? "BUYER_VENDOR",
        participantA,
        participantB,
        orderId: input.orderId ?? "",
        lastMessageAt: input.initialMessage ? new Date() : null,
      },
    });

    if (input.initialMessage) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          text: input.initialMessage,
        },
      });
    }

    return conversation;
  },

  async listConversations(
    userId: string,
    query: ListConversationsQuery,
  ): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    const items = await prisma.conversation.findMany({
      where: {
        OR: [{ participantA: userId }, { participantB: userId }],
      },
      orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },

  async listMessages(
    userId: string,
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    // Verify user is a participant
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }
    if (conversation.participantA !== userId && conversation.participantB !== userId) {
      throw new AppError("Forbidden", 403);
    }

    const items = await prisma.message.findMany({
      where: { conversationId },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items: items.reverse(), nextCursor };
  },

  async sendMessage(
    userId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<Message> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }
    if (conversation.participantA !== userId && conversation.participantB !== userId) {
      throw new AppError("Forbidden", 403);
    }

    const [message] = await prisma.$transaction([
      prisma.message.create({
        data: {
          conversationId,
          senderId: userId,
          text: input.text,
          attachments: input.attachments ?? [],
        },
      }),
      prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      }),
    ]);

    return message;
  },

  async markConversationRead(userId: string, conversationId: string): Promise<void> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }
    if (conversation.participantA !== userId && conversation.participantB !== userId) {
      throw new AppError("Forbidden", 403);
    }

    // Mark all unread messages from the OTHER participant as read
    await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        readAt: null,
      },
      data: { readAt: new Date() },
    });
  },
};
