import { prisma } from "../../lib/prisma";
import { pushNotifications } from "../../lib/push-notifications";
import { isBlocked } from "../reports/reports.service";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { adminRolesService } from "../admin/admin-roles.service";
import { recordAudit } from "../../shared/utils/audit";
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
  if (await isAdminInboxConversation(conversation)) {
    await adminRolesService.assertPermission(userId, permission);
    return;
  }
  throw new AppError("Forbidden", 403);
}

/**
 * A conversation belongs to the shared admin inbox when it is a SUPPORT
 * thread OR has an ADMIN-role participant of any type — e.g. a vendor's reply
 * to an admin broadcast, which admin-communications creates as an
 * ADMIN_VENDOR/BUYER_VENDOR-typed thread with the broadcasting admin. An
 * ordinary buyer<->vendor thread is never in the inbox.
 */
export async function isAdminInboxConversation(conversation: {
  participantA: string;
  participantB: string;
  type: string;
}): Promise<boolean> {
  if (conversation.type === "SUPPORT") return true;
  const admin = await prisma.user.findFirst({
    where: { id: { in: [conversation.participantA, conversation.participantB] }, role: "ADMIN" },
    select: { id: true },
  });
  return !!admin;
}

/** Participant-facing label for the support side of a thread. */
export const SUPPORT_DISPLAY_NAME = "Eki Support";

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
        // Internal admin notes are never visible on any participant path.
        where: { isInternal: false },
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
        isInternal: false,
      },
    }),
  ]);

  if (!participantUser) {
    throw new AppError("Participant not found", 404);
  }

  // The support side of any thread is shown as "Eki Support" to participants
  // (buyer and vendor alike) rather than an individual admin's name.
  const isSupportSide = participantUser.role === "ADMIN";
  if (isSupportSide) participantUser.name = SUPPORT_DISPLAY_NAME;

  return {
    id: conversation.id,
    participantId,
    participantName: participantUser.vendor?.storeName ?? participantUser.name,
    isSupport: isSupportSide,
    status: conversation.status,
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

    // Participant read path: internal admin notes are NEVER returned here —
    // not even to an admin (the admin inbox has its own endpoint that
    // includes them, see support-inbox.service.ts).
    const items = await prisma.message.findMany({
      where: { conversationId, isInternal: false },
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
    options: { isInternal?: boolean } = {},
  ): Promise<any> {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }

    if (options.isInternal) {
      // Admin-only internal note: needs support.mutate even for a literal
      // participant, only on inbox threads, never notifies/pushes/reopens
      // and does not bump lastMessageAt (it is not participant-visible).
      await adminRolesService.assertPermission(userId, "support.mutate");
      if (!(await isAdminInboxConversation(conversation))) {
        throw new AppError("Internal notes are only available on support conversations", 400);
      }
      const note = await prisma.message.create({
        data: {
          conversationId,
          senderId: userId,
          text: input.text,
          attachments: input.attachments ?? [],
          isInternal: true,
          // Notes have no recipient; mark read so they never count as unread.
          readAt: new Date(),
        },
      });
      return serializeMessage(note.id);
    }

    await assertConversationAccess(userId, conversation, "support.mutate");

    const recipientIdForBlockCheck = await resolveMessageRecipientId(userId, conversation);
    if (await isBlocked(recipientIdForBlockCheck, userId)) {
      throw new AppError("You cannot send messages to this user", 403);
    }
    if (await isBlocked(userId, recipientIdForBlockCheck)) {
      throw new AppError("You have blocked this user. Unblock them to send messages.", 403);
    }

    const sender = await prisma.user.findUnique({
      where: { id: userId },
      include: { vendor: { select: { storeName: true } } },
    });
    // A new message from the non-admin side of a CLOSED thread reopens it
    // (handbook 6.1). An admin reply on a closed thread does not change its
    // status — closing/reopening is an explicit, audited admin action.
    const reopens = conversation.status === "CLOSED" && sender?.role !== "ADMIN";

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
        data: {
          lastMessageAt: new Date(),
          ...(reopens ? { status: "OPEN", closedAt: null, closedById: null } : {}),
        },
      }),
    ]);

    if (reopens) {
      await recordAudit({
        actorId: userId,
        action: "support.conversation.auto_reopened",
        entityType: "Conversation",
        entityId: conversationId,
        beforeState: { status: "CLOSED" },
        afterState: { status: "OPEN" },
        reason: "New message from participant on a closed conversation",
        metadata: { messageId: message.id },
      });
    }

    const recipientId = recipientIdForBlockCheck;
    const senderName =
      sender?.role === "ADMIN" ? SUPPORT_DISPLAY_NAME : (sender?.vendor?.storeName ?? sender?.name ?? "Eki");

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

    // Mark unread messages from the OTHER side as read. When the viewer is an
    // admin, "other side" means every non-admin sender: one admin opening a
    // thread must never stamp a teammate's reply as read by the buyer/vendor
    // (readAt is the participant's read receipt shown in the admin thread).
    const viewer = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    let senderFilter: Record<string, unknown> = { not: userId };
    if (viewer?.role === "ADMIN") {
      const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
      senderFilter = { notIn: admins.map((a) => a.id) };
    }
    await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: senderFilter,
        readAt: null,
        isInternal: false,
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
