/**
 * Admin shared support inbox (handbook 6.1 / 14.2).
 *
 * The inbox is every SUPPORT conversation PLUS every conversation that has an
 * ADMIN-role participant, whatever its type: an admin broadcast creates an
 * ADMIN_VENDOR / BUYER_VENDOR typed thread with the broadcasting admin
 * (admin-communications.service.ts), and a vendor's reply to it must not be
 * invisible. Ordinary buyer<->vendor threads are never in the inbox.
 *
 * Lifecycle: OPEN <-> CLOSED, escalated flag (independent of status). Every
 * transition is audited with a required reason. A new participant message on a
 * CLOSED thread reopens it (see messagesService.sendMessage()).
 *
 * Internal notes (Message.isInternal) are admin-only. They are returned by
 * listMessages() here and by nothing on the participant paths.
 */
import type { Request } from "express";
import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { isAdminInboxConversation, messagesService } from "./messages.service";
import type {
  AdminReplyInput,
  AdminSupportListQuery,
  ListMessagesQuery,
} from "./messages.types";

type ConversationRow = Awaited<ReturnType<typeof prisma.conversation.findFirst>> & {};

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
  role: true,
  vendor: { select: { id: true, storeName: true } },
} as const;

async function getAdminIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } });
  return admins.map((a) => a.id);
}

function inboxBaseWhere(adminIds: string[]): Prisma.ConversationWhereInput {
  return {
    OR: [
      { type: "SUPPORT" },
      { participantA: { in: adminIds } },
      { participantB: { in: adminIds } },
    ],
  };
}

function unreadWhere(adminIds: string[]): Prisma.ConversationWhereInput {
  return {
    messages: { some: { readAt: null, isInternal: false, senderId: { notIn: adminIds } } },
  };
}

/** Conversations with a pending ContentReport against one of their messages. */
async function reportedConversationIds(): Promise<string[]> {
  const reports = await prisma.contentReport.findMany({
    where: { targetType: "message", status: "PENDING" },
    select: { targetId: true },
    take: 2000,
  });
  if (reports.length === 0) return [];
  const msgs = await prisma.message.findMany({
    where: { id: { in: reports.map((r) => r.targetId) } },
    select: { conversationId: true },
  });
  return Array.from(new Set(msgs.map((m) => m.conversationId)));
}

async function conversationIdsByCounterpartyRole(role: "BUYER" | "VENDOR", adminIds: string[]): Promise<string[]> {
  if (adminIds.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT c."id" FROM "Conversation" c
    JOIN "User" u ON u."id" IN (c."participantA", c."participantB")
    WHERE u."role" = ${role}::"UserRole"
      AND (c."participantA" IN (${Prisma.join(adminIds)}) OR c."participantB" IN (${Prisma.join(adminIds)}))`);
  return rows.map((r) => r.id);
}

async function buildWhere(query: AdminSupportListQuery, adminIds: string[]): Promise<Prisma.ConversationWhereInput> {
  const and: Prisma.ConversationWhereInput[] = [inboxBaseWhere(adminIds)];
  if (query.status === "open") and.push({ status: "OPEN" });
  if (query.status === "closed") and.push({ status: "CLOSED" });
  if (query.unread) and.push(unreadWhere(adminIds));
  if (query.escalated) and.push({ escalatedAt: { not: null } });
  if (query.reported) and.push({ id: { in: await reportedConversationIds() } });
  if (query.orderLinked) and.push({ AND: [{ orderId: { not: null } }, { orderId: { not: "" } }] });
  if (query.orderId) and.push({ orderId: query.orderId });
  if (query.role) {
    and.push({ id: { in: await conversationIdsByCounterpartyRole(query.role === "vendor" ? "VENDOR" : "BUYER", adminIds) } });
  }
  if (query.q) {
    const q = query.q;
    const [users, orders] = await Promise.all([
      prisma.user.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { vendor: { is: { storeName: { contains: q, mode: "insensitive" } } } },
          ],
        },
        select: { id: true },
        take: 100,
      }),
      prisma.order.findMany({
        where: { orderNumber: { contains: q, mode: "insensitive" } },
        select: { id: true },
        take: 50,
      }),
    ]);
    const userIds = users.map((u) => u.id).filter((id) => !adminIds.includes(id));
    and.push({
      OR: [
        { participantA: { in: userIds } },
        { participantB: { in: userIds } },
        ...(orders.length ? [{ orderId: { in: orders.map((o) => o.id) } }] : []),
        { messages: { some: { text: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  return { AND: and };
}

type UserRecord = {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
  role: "BUYER" | "VENDOR" | "ADMIN";
  vendor: { id: string; storeName: string } | null;
};

function publicParticipant(u: UserRecord) {
  return {
    id: u.id,
    name: u.vendor?.storeName ?? u.name,
    userName: u.name,
    email: u.email,
    avatar: u.avatar,
    role: u.role,
    storeName: u.vendor?.storeName ?? null,
    vendorId: u.vendor?.id ?? null,
  };
}

/** Batch-serialise conversations for the admin list/detail (no per-row queries). */
async function serializeConversations(conversations: Array<NonNullable<ConversationRow> & { messages: Array<{ text: string; senderId: string; createdAt: Date }> }>, adminIds: string[]) {
  if (conversations.length === 0) return [];
  const convIds = conversations.map((c) => c.id);
  const userIds = Array.from(new Set(conversations.flatMap((c) => [c.participantA, c.participantB])));
  const orderIds = Array.from(new Set(conversations.map((c) => c.orderId).filter((id): id is string => !!id)));

  const [users, unreadGroups, noteGroups, orders, reportedIds] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: USER_SELECT }),
    prisma.message.groupBy({
      by: ["conversationId"],
      where: { conversationId: { in: convIds }, readAt: null, isInternal: false, senderId: { notIn: adminIds } },
      _count: { _all: true },
    }),
    prisma.message.groupBy({
      by: ["conversationId"],
      where: { conversationId: { in: convIds }, isInternal: true },
      _count: { _all: true },
    }),
    orderIds.length
      ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true } })
      : Promise.resolve([] as Array<{ id: string; orderNumber: string }>),
    reportedConversationIds(),
  ]);

  const userById = new Map<string, UserRecord>(users.map((u) => [u.id, u as UserRecord]));
  const unread = new Map(unreadGroups.map((g) => [g.conversationId, g._count._all]));
  const notes = new Map(noteGroups.map((g) => [g.conversationId, g._count._all]));
  const orderById = new Map(orders.map((o) => [o.id, o.orderNumber]));
  const reported = new Set(reportedIds);

  return conversations.map((c) => {
    const a = userById.get(c.participantA);
    const b = userById.get(c.participantB);
    const counterparty = (a && a.role !== "ADMIN" ? a : b && b.role !== "ADMIN" ? b : a ?? b) as UserRecord | undefined;
    const supportSide = counterparty && counterparty.id === c.participantA ? b : a;
    const last = c.messages[0];
    const orderId = c.orderId ? c.orderId : null;
    const cp = counterparty ? publicParticipant(counterparty) : null;
    return {
      id: c.id,
      type: c.type,
      status: c.status,
      closedAt: c.closedAt,
      closedById: c.closedById,
      escalated: !!c.escalatedAt,
      escalatedAt: c.escalatedAt,
      escalatedById: c.escalatedById,
      escalationNote: c.escalationNote,
      reported: reported.has(c.id),
      counterparty: cp,
      supportParticipant: supportSide ? { id: supportSide.id, name: supportSide.name } : null,
      // Legacy fields kept for older admin-web builds.
      buyerId: cp?.id ?? null,
      buyerName: cp?.name ?? "",
      buyerEmail: cp?.email ?? null,
      buyerAvatar: cp?.avatar ?? null,
      orderId,
      orderNumber: orderId ? (orderById.get(orderId) ?? null) : null,
      lastMessage: last?.text ?? "",
      lastMessageFromCounterparty: last ? last.senderId === counterparty?.id : null,
      lastMessageAt: c.lastMessageAt ?? c.updatedAt ?? c.createdAt,
      unreadCount: unread.get(c.id) ?? 0,
      internalNoteCount: notes.get(c.id) ?? 0,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  });
}

const LIST_INCLUDE = {
  messages: {
    where: { isInternal: false },
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { text: true, senderId: true, createdAt: true },
  },
};

async function loadInboxConversation(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || !(await isAdminInboxConversation(conversation))) {
    throw new AppError("Support conversation not found", 404);
  }
  return conversation;
}

async function serializeMessages(messages: Array<any>) {
  const senderIds = Array.from(new Set(messages.map((m) => m.senderId)));
  const senders = senderIds.length
    ? await prisma.user.findMany({ where: { id: { in: senderIds } }, select: USER_SELECT })
    : [];
  const byId = new Map(senders.map((s) => [s.id, s]));
  return messages.map((m) => {
    const s = byId.get(m.senderId);
    return {
      ...m,
      sender: s
        ? { id: s.id, name: s.vendor?.storeName ?? s.name, avatar: s.avatar, role: s.role, vendor: s.vendor }
        : null,
    };
  });
}

type LifecycleAction = "close" | "reopen" | "escalate" | "deescalate";

export const supportInboxService = {
  async list(query: AdminSupportListQuery) {
    const adminIds = await getAdminIds();
    const where = await buildWhere(query, adminIds);
    const base = inboxBaseWhere(adminIds);

    const [rows, total, open, closed, unread, escalated] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      prisma.conversation.count({ where }),
      prisma.conversation.count({ where: { AND: [base, { status: "OPEN" }] } }),
      prisma.conversation.count({ where: { AND: [base, { status: "CLOSED" }] } }),
      prisma.conversation.count({ where: { AND: [base, unreadWhere(adminIds)] } }),
      prisma.conversation.count({ where: { AND: [base, { escalatedAt: { not: null } }] } }),
    ]);

    let nextCursor: string | null = null;
    if (rows.length > query.limit) {
      nextCursor = rows.pop()?.id ?? null;
    }
    const items = await serializeConversations(rows as any, adminIds);
    return { items, nextCursor, total, counts: { open, closed, all: open + closed, unread, escalated } };
  },

  async get(conversationId: string) {
    await loadInboxConversation(conversationId);
    const adminIds = await getAdminIds();
    const full = await prisma.conversation.findUnique({ where: { id: conversationId }, include: LIST_INCLUDE });
    if (!full) throw new AppError("Support conversation not found", 404);
    const [item] = await serializeConversations([full as any], adminIds);
    return item;
  },

  /** All messages incl. internal notes, newest page first by cursor, returned oldest-first. nextCursor = older page. */
  async listMessages(conversationId: string, query: ListMessagesQuery) {
    await loadInboxConversation(conversationId);
    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (rows.length > query.limit) {
      nextCursor = rows.pop()?.id ?? null;
    }
    return { items: await serializeMessages(rows.reverse()), nextCursor };
  },

  async sendReply(adminId: string, conversationId: string, input: AdminReplyInput, request?: Request) {
    await loadInboxConversation(conversationId);
    const message = await messagesService.sendMessage(
      adminId,
      conversationId,
      { text: input.text, attachments: input.attachments },
      { isInternal: input.isInternal },
    );
    await recordAudit({
      actorId: adminId,
      action: input.isInternal ? "support.internal_note" : "support.reply",
      entityType: "Conversation",
      entityId: conversationId,
      request,
      metadata: {
        messageId: message.id,
        internal: input.isInternal,
        textLength: input.text.length,
        attachmentCount: input.attachments.length,
      },
    });
    const [serialized] = await serializeMessages([message]);
    return serialized;
  },

  async transition(
    action: LifecycleAction,
    adminId: string,
    conversationId: string,
    reason: string,
    request?: Request,
  ) {
    const conversation = await loadInboxConversation(conversationId);
    const before = {
      status: conversation.status,
      escalated: !!conversation.escalatedAt,
      escalationNote: conversation.escalationNote,
    };
    let data: Prisma.ConversationUpdateInput;
    switch (action) {
      case "close":
        if (conversation.status === "CLOSED") throw new AppError("Conversation is already closed", 409);
        data = { status: "CLOSED", closedAt: new Date(), closedById: adminId };
        break;
      case "reopen":
        if (conversation.status === "OPEN") throw new AppError("Conversation is already open", 409);
        data = { status: "OPEN", closedAt: null, closedById: null };
        break;
      case "escalate":
        if (conversation.escalatedAt) throw new AppError("Conversation is already escalated", 409);
        data = { escalatedAt: new Date(), escalatedById: adminId, escalationNote: reason };
        break;
      case "deescalate":
        if (!conversation.escalatedAt) throw new AppError("Conversation is not escalated", 409);
        data = { escalatedAt: null, escalatedById: null, escalationNote: null };
        break;
    }
    const updated = await prisma.conversation.update({ where: { id: conversationId }, data });
    await recordAudit({
      actorId: adminId,
      action: `support.conversation.${action}`,
      entityType: "Conversation",
      entityId: conversationId,
      request,
      reason,
      beforeState: before,
      afterState: {
        status: updated.status,
        escalated: !!updated.escalatedAt,
        escalationNote: updated.escalationNote,
      },
    });
    return this.get(conversationId);
  },
};
