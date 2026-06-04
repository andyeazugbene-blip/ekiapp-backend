import { prisma } from "../../lib/prisma";
import { pushNotifications } from "../../lib/push-notifications";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type {
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageInput,
} from "./messages.types";

type ParticipantRecord = {
  id: string;
  name: string;
  role: "BUYER" | "VENDOR" | "ADMIN";
  vendor: { id: string; storeName: string } | null;
};

function sortParticipants(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function assertConversationAllowed(
  requester: ParticipantRecord,
  other: ParticipantRecord,
  orderId?: string,
): Promise<"BUYER_VENDOR" | "ADMIN_VENDOR" | "DISPUTE"> {
  const roles = new Set([requester.role, other.role]);

  if (roles.has("ADMIN")) {
    if (requester.role === "ADMIN" && other.role === "ADMIN") {
      throw new AppError("Admin-to-admin conversations are not supported", 400);
    }
    return "ADMIN_VENDOR";
  }

  if (!roles.has("BUYER") || !roles.has("VENDOR")) {
    throw new AppError("Conversation participants are not compatible", 400);
  }

  if (!orderId) {
    return "BUYER_VENDOR";
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      buyerId: true,
      vendorId: true,
    },
  });

  if (!order || !order.vendorId) {
    throw new AppError("Order not found", 404);
  }

  const buyer = requester.role === "BUYER" ? requester : other;
  const vendor = requester.role === "VENDOR" ? requester : other;

  if (order.buyerId !== buyer.id || order.vendorId !== vendor.vendor?.id) {
    throw new AppError("Conversation is not allowed for this order", 403);
  }

  return "BUYER_VENDOR";
}

async function serializeConversationForUser(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  const orderRecord = conversation.orderId
    ? await prisma.order.findUnique({
        where: { id: conversation.orderId },
        select: { id: true, orderNumber: true },
      })
    : null;

  const participantId = conversation.participantA === userId ? conversation.participantB : conversation.participantA;
  const [participantUser, unreadCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: participantId },
      include: {
        vendor: {
          select: {
            id: true,
            storeName: true,
            avatar: true,
            coverImage: true,
          },
        },
      },
    }),
    prisma.message.count({
      where: {
        conversationId: conversation.id,
        senderId: participantId,
        readAt: null,
      },
    }),
  ]);

  if (!participantUser) {
    throw new AppError("Participant not found", 404);
  }

  return {
    id: conversation.id,
    participantId,
    participantName: participantUser.vendor?.storeName ?? participantUser.name,
    participantStoreName: participantUser.vendor?.storeName ?? null,
    participantAvatar: participantUser.vendor?.avatar ?? participantUser.avatar ?? participantUser.vendor?.coverImage ?? null,
    participantRole: participantUser.role.toLowerCase(),
    participantUser: {
      id: participantUser.id,
      name: participantUser.name,
      avatar: participantUser.avatar,
      role: participantUser.role,
      vendor: participantUser.vendor,
    },
    lastMessage: conversation.messages[0]?.text ?? "",
    lastMessageAt: conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt,
    unreadCount,
    orderId: conversation.orderId || undefined,
    orderNumber: orderRecord?.orderNumber ?? undefined,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

async function serializeMessage(messageId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });

  if (!message) {
    throw new AppError("Message not found", 404);
  }

  const sender = await prisma.user.findUnique({
    where: { id: message.senderId },
    include: {
      vendor: {
        select: {
          id: true,
          storeName: true,
          avatar: true,
          coverImage: true,
        },
      },
    },
  });

  return {
    ...message,
    sender: sender
      ? {
          id: sender.id,
          name: sender.name,
          avatar: sender.avatar,
          role: sender.role,
          vendor: sender.vendor,
        }
      : null,
  };
}

export const messagesService = {
  async createConversation(
    userId: string,
    input: CreateConversationInput,
  ): Promise<any> {
    if (userId === input.participantId) {
      throw new AppError("Cannot create conversation with yourself", 400);
    }

    const requester = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true, vendor: { select: { id: true, storeName: true } } },
    });
    if (!requester) {
      throw new AppError("Requester not found", 404);
    }

    const otherUser = await prisma.user.findUnique({
      where: { id: input.participantId },
      select: { id: true, name: true, role: true, vendor: { select: { id: true, storeName: true } } },
    });
    if (!otherUser) {
      throw new AppError("Participant not found", 404);
    }

    const allowedType = await assertConversationAllowed(
      requester as ParticipantRecord,
      otherUser as ParticipantRecord,
      input.orderId,
    );

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
      return serializeConversationForUser(userId, existing.id);
    }

    const conversation = await prisma.conversation.create({
      data: {
        type: input.type ?? allowedType,
        participantA,
        participantB,
        orderId: input.orderId ?? "",
        lastMessageAt: input.initialMessage ? new Date() : null,
      },
    });

    if (input.initialMessage) {
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          text: input.initialMessage,
        },
      });
      pushNotifications.newMessage(input.participantId, requester.vendor?.storeName ?? requester.name);
      await prisma.notification.create({
        data: {
          userId: input.participantId,
          type: "ADMIN_BROADCAST",
          title: "New message",
          body: `${requester.vendor?.storeName ?? requester.name} sent you a message.`,
          data: { conversationId: conversation.id, messageId: message.id },
        },
      });
    }

    return serializeConversationForUser(userId, conversation.id);
  },

  async listConversations(
    userId: string,
    query: ListConversationsQuery,
  ): Promise<{ items: any[]; nextCursor: string | null }> {
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

    const enrichedItems = await Promise.all(items.map((item) => serializeConversationForUser(userId, item.id)));
    return { items: enrichedItems, nextCursor };
  },

  async listMessages(
    userId: string,
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<{ items: any[]; nextCursor: string | null }> {
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

    const enrichedItems = await Promise.all(items.reverse().map((item) => serializeMessage(item.id)));
    return { items: enrichedItems, nextCursor };
  },

  async sendMessage(
    userId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<any> {
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

    const recipientId = conversation.participantA === userId ? conversation.participantB : conversation.participantA;
    const sender = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendor: { select: { storeName: true } } },
    });
    const senderName = sender?.vendor?.storeName ?? sender?.name ?? "Eki";

    await notificationsServiceSafe(recipientId, conversationId, message.id, senderName);
    pushNotifications.newMessage(recipientId, senderName);

    return serializeMessage(message.id);
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

async function notificationsServiceSafe(
  userId: string,
  conversationId: string,
  messageId: string,
  senderName: string,
): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId,
        type: "ADMIN_BROADCAST",
        title: "New message",
        body: `${senderName} sent you a message.`,
        data: { conversationId, messageId },
      },
    });
  } catch {
    // Messaging must not fail only because notification persistence failed.
  }
}
