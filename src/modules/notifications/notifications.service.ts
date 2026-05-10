import type { Notification, NotificationType, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  data?: Prisma.InputJsonValue;
}

export interface ListNotificationsQuery {
  limit?: number;
  cursor?: string;
  unreadOnly?: boolean;
}

type PrismaLike = Prisma.TransactionClient | typeof prisma;

export const notificationsService = {
  async create(input: CreateNotificationInput, tx: PrismaLike = prisma): Promise<Notification> {
    return tx.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
      },
    });
  },

  async list(
    userId: string,
    query: ListNotificationsQuery,
  ): Promise<{ items: Notification[]; nextCursor: string | null }> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }

    const items = await prisma.notification.findMany({
      where: {
        userId,
        ...(query.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }
    return { items, nextCursor };
  },

  async markRead(userId: string, notificationId: string): Promise<Notification> {
    const result = await prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      const existing = await prisma.notification.findUnique({
        where: { id: notificationId },
        select: { userId: true, readAt: true },
      });
      if (!existing) throw new AppError("Notification not found", 404);
      if (existing.userId !== userId) throw new AppError("Forbidden", 403);
      if (existing.readAt) {
        return prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
      }
    }

    return prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
  },
};

export function parseListQuery(query: Record<string, unknown>): ListNotificationsQuery {
  const out: ListNotificationsQuery = {};
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
      throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
    }
    out.limit = parsed;
  }
  if (typeof query.cursor === "string" && query.cursor.length > 0) {
    out.cursor = query.cursor;
  }
  if (query.unreadOnly === "true") {
    out.unreadOnly = true;
  }
  return out;
}
