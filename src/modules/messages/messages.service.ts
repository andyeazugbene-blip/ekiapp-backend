import { prisma } from "../../lib/prisma";
import { pushNotifications } from "../../lib/push-notifications";
import { isBlocked } from "../reports/reports.service";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { adminRolesService } from "../admin/admin-roles.service";
import type {
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
  ListSupportConversationsQuery,
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

/**
 * A literal participant always has access. For a SUPPORT conversation
 * specifically, ANY admin holding the given permission also has access —
 * the shared-inbox model a real support team needs: a buyer's thread must
 * be answerable by whichever admin picks it up, not only whichever admin
 * happened to be resolved as the fixed participantB at creation time (see
 * resolveSupportAdminId()). Never loosened for any other conversation type
 * — an admin has no special access to an ordinary BUYER_VENDOR/ADMIN_VENDOR/
 * DISPUTE thread they weren't actually added to.
 */
async function assertConversationAccess(
  userId: string,
  conversation: { participantA: string; participantB: string; type: string },
  permission: "support.read" | "support.mutate",
): Promise<void> {
  if (conversation.participantA === userId || conversation.participantB === userId) return;
  if (conversation.type === "SUPPORT") {
    await adminRolesService.assertPermission(userId, permission);
    return;
  }
  throw new AppError("Forbidden", 403);
}

/** The real, findable "Eki Support" identity a buyer's support conversation is created against — the earliest-created ADMIN user, guaranteed to exist by the bootstrap-admin mechanism. Any admin with support.mutate can still reply (see assertConversationAccess) regardless of who this resolves to. */
async function resolveSupportAdminId(): Promise<string> {
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!admin) {
    throw new AppError("Support is not available right now — please try again later", 503);
  }
  return admin.id;
}

/** The other side of a message, correctly resolved even when the sender isn't a literal participant (a different admin picking up a SUPPORT thread — see assertConversationAccess()). Falls back to role-based resolution (whichever participant is NOT an admin) only in that case. */
async function resolveMessageRecipientId(
  userId: string,
  conversation: { participantA: string; participantB: string },
): Promise<string> {
  if (conversation.participantA === userId) return conversation.participantB;
  if (conversation.participantB === userId) return conversation.participantA;
  const [userA, userB] = await Promise.all([
    prisma.user.findUnique({ where: { id: conversation.participantA }, select: { role: true } }),
    prisma.user.findUnique({ where: { id: conversation.participantB }, select: { role: true } }),
  ]);
  if (userA?.role !== "ADMIN") return conversation.participantA;
  if (userB?.role !== "ADMIN") return conversation.participantB;
  return conversation.participantA;
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

/**
 * The admin-inbox equivalent of serializeConversationForUser() — takes no
 * viewer userId (any permitted admin may view any SUPPORT conversation, so
 * "the other participant" can't be resolved relative to who's asking).
 * Identifies the buyer side by role (whichever participant is NOT an
 * admin) rather than by matching a specific id, for the same reason
 * resolveMessageRecipientId() does. unreadCount counts unread messages
 * FROM the buyer — a shared value every admin sees the same way, since
 * Message.readAt is one field, not per-admin.
 */
async function serializeSupportConversationForAdmin(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!conversation) {
    throw new AppError("Conversation not found", 404);
  }

  const [userA, userB] = await Promise.all([
    prisma.user.findUnique({ where: { id: conversation.participantA }, select: { id: true, name: true, email: true, avatar: true, role: true } }),
    prisma.user.findUnique({ where: { id: conversation.participantB }, select: { id: true, name: true, email: true, avatar: true, role: true } }),
  ]);
  const buyer = userA?.role !== "ADMIN" ? userA : userB;
  if (!buyer) {
    throw new AppError("Support conversation participant not found", 404);
  }

  const unreadCount = await prisma.message.count({
    where: { conversationId: conversation.id, senderId: buyer.id, readAt: null },
  });

  return {
    id: conversation.id,
    buyerId: buyer.id,
    buyerName: buyer.name,
    buyerEmail: buyer.email,
    buyerAvatar: buyer.avatar,
    lastMessage: conversation.messages[0]?.text ?? "",
    lastMessageAt: conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt,
    unreadCount,
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

    if (await isBlocked(input.participantId, userId)) {
      throw new AppError("You cannot start a conversation with this user", 403);
    }
    if (await isBlocked(userId, input.participantId)) {
      throw new AppError("You have blocked this user. Unblock them to send messages.", 403);
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
      pushNotifications.newMessage(input.participantId, requester.vendor?.storeName ?? requester.name, conversation.id);
      await prisma.notification.create({
        data: {
          userId: input.participantId,
          type: "NEW_MESSAGE",
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
    // Verify user is a participant (or, for a SUPPORT thread, a permitted admin)
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }
    await assertConversationAccess(userId, conversation, "support.read");

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
    await assertConversationAccess(userId, conversation, "support.mutate");

    const recipientIdForBlockCheck = await resolveMessageRecipientId(userId, conversation);
    if (await isBlocked(recipientIdForBlockCheck, userId)) {
      throw new AppError("You cannot send messages to this user", 403);
    }
    if (await isBlocked(userId, recipientIdForBlockCheck)) {
      throw new AppError("You have blocked this user. Unblock them to send messages.", 403);
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

    const recipientId = recipientIdForBlockCheck;
    const sender = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendor: { select: { storeName: true } } },
    });
    const senderName = sender?.vendor?.storeName ?? sender?.name ?? "Eki";

    await notificationsServiceSafe(recipientId, conversationId, message.id, senderName);
    pushNotifications.newMessage(recipientId, senderName, conversationId);

    return serializeMessage(message.id);
  },

  async markConversationRead(userId: string, conversationId: string): Promise<void> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }
    await assertConversationAccess(userId, conversation, "support.mutate");

    // Mark all unread messages from the OTHER participant as read (or, for a
    // SUPPORT thread a different admin is picking up, everything not sent by
    // this same requester — harmless over-marking of a teammate's own reply,
    // never affects the buyer's own unread state).
    await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        readAt: null,
      },
      data: { readAt: new Date() },
    });
  },

  /**
   * In-app support messaging (2026-09-22 client decision) — "contact us"
   * inside the app instead of email. Reuses createConversation() exactly
   * (same dedup-by-unique-pair, same initial-message/notification path);
   * the only thing new here is resolving WHO the buyer is talking to
   * without the client ever supplying or knowing an admin's user id.
   * Calling this again after the first time reuses the same conversation
   * (createConversation()'s existing "already exists" branch) rather than
   * starting a new thread every time a buyer taps "Contact us".
   */
  async startSupportConversation(userId: string, message: string): Promise<any> {
    const supportAdminId = await resolveSupportAdminId();
    if (userId === supportAdminId) {
      throw new AppError("You are the support account — nothing to contact", 400);
    }
    return this.createConversation(userId, {
      participantId: supportAdminId,
      type: "SUPPORT",
      initialMessage: message,
    });
  },

  /**
   * The shared admin inbox listing — deliberately NOT scoped to
   * participantA/B === the viewing admin (unlike listConversations()
   * above), since any permitted admin must see every buyer's support
   * thread, not only ones addressed to whichever admin was resolved as
   * the fixed participantB at creation time. Permission-gated at the
   * controller/route layer (support.read), not here.
   */
  async listSupportConversationsForAdmin(
    query: ListSupportConversationsQuery,
  ): Promise<{ items: any[]; nextCursor: string | null }> {
    const items = await prisma.conversation.findMany({
      where: { type: "SUPPORT" },
      orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    const enrichedItems = await Promise.all(items.map((item) => serializeSupportConversationForAdmin(item.id)));
    return { items: enrichedItems, nextCursor };
  },

  async getSupportConversationForAdmin(conversationId: string): Promise<any> {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.type !== "SUPPORT") {
      throw new AppError("Support conversation not found", 404);
    }
    return serializeSupportConversationForAdmin(conversationId);
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
        type: "NEW_MESSAGE",
        title: "New message",
        body: `${senderName} sent you a message.`,
        data: { conversationId, messageId },
      },
    });
  } catch {
    // Messaging must not fail only because notification persistence failed.
  }
}
