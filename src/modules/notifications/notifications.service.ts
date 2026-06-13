import type { Notification, NotificationType, Prisma } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { sendPushToUser } from "../../lib/expo-push";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { notificationsQueue } from "../../queues";
import { AppError } from "../../shared/errors/app-error";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const NOTIFICATION_JOB = "create-notification";

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

  // Async path: when Redis is configured, push the notification to the
  // BullMQ queue and let the worker create it in the DB. When Redis
  // is unavailable, fall back to a direct DB insert so the app keeps
  // working in local dev. Never throws — notifications must not break
  // the calling business operation.
  //
  // After the DB record is created, fire an Expo push notification if
  // the user has registered push tokens. This ensures push notifications
  // work even when no Redis/worker infrastructure is available.
  async enqueue(input: CreateNotificationInput): Promise<void> {
    if (notificationsQueue) {
      try {
        await notificationsQueue.add(NOTIFICATION_JOB, input, {
          jobId: undefined,
        });
        // Send Expo push in parallel — worker only creates DB records,
        // it does not send pushes.
        sendPushToUser(input.userId, {
          title: input.title,
          body: input.body ?? "",
          data: input.data as Record<string, unknown> | undefined,
        });
        return;
      } catch (error) {
        logger.warn("Notification enqueue failed, falling back to direct insert", {
          type: input.type,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      await this.create(input);
      // Fire Expo push after saving to DB
      sendPushToUser(input.userId, {
        title: input.title,
        body: input.body ?? "",
        data: input.data as Record<string, unknown> | undefined,
      });
    } catch (error) {
      logger.error("Notification fallback insert failed", {
        type: input.type,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
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
      orderBy: CURSOR_ORDER_BY,
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

  async markAllRead(userId: string): Promise<{ count: number }> {
    const result = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  },

  async getPreferences(userId: string) {
    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        smsMarketingConsentAt: true,
        smsTransactionalEnabled: true,
      },
    });
  },

  async updatePreferences(userId: string, input: { smsMarketing?: boolean; smsTransactional?: boolean }) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.smsMarketing === undefined
          ? {}
          : { smsMarketingConsentAt: input.smsMarketing ? new Date() : null }),
        ...(input.smsTransactional === undefined
          ? {}
          : { smsTransactionalEnabled: input.smsTransactional }),
      },
      select: {
        smsMarketingConsentAt: true,
        smsTransactionalEnabled: true,
      },
    });
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
