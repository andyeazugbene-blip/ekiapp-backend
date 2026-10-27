import type { Notification, NotificationPreferenceCategory, NotificationPreferenceChannel, NotificationConsent, NotificationRecipientRole, NotificationPriority, NotificationType, Prisma } from "@prisma/client";

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
  /** Canonical business-identity key for idempotent creation — e.g.
   * "RENEWAL_REMINDER:{subscriptionId}:{isoDate}", the SAME identity a
   * caller also uses for the corresponding AutomationRun.dedupeKey.
   * Enforced at the DB level (Notification.dedupeKey unique), so two
   * concurrent calls for the same event can never both create a row.
   * Omit entirely for notifications that don't need dedup — the default,
   * unaffected by this. */
  dedupeKey?: string;
}

const RULE_RECIPIENT_ROLE: Record<string, NotificationRecipientRole> = {
  R07_VERIFICATION_REQUIRES_CORRECTION: "VENDOR",
  R08_VERIFICATION_APPROVED: "VENDOR",
  R09_PUBLICATION_CONFIRMED: "VENDOR",
  R12_FIRST_PAID_ORDER: "VENDOR",
  R17_STOCK_DEPLETED: "VENDOR",
  R18_STOCK_CONFLICT: "VENDOR",
  R20_PAYMENT_FAILED: "BUYER",
  R21_ORDER_CONFIRMED: "BUYER",
  R22_ORDER_DISPATCHED: "BUYER",
  R25_PAYOUT_ACTION_REQUIRED: "VENDOR",
  R26_PAYOUT_CONFIRMED: "VENDOR",
  R28_SUPPORT_RESPONSE: "BUYER",
  R29_MEMBERSHIP_PAYMENT_FAILED: "VENDOR",
  R34_COMMUNITY_BUY_BELOW_MINIMUM: "ORGANISER",
  R35_COMMUNITY_BUY_MINIMUM_REACHED: "ORGANISER",
  R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED: "PARTICIPANT",
  R37_SUPPLIER_RECONFIRMATION: "SUPPLIER",
  R40_CRITICAL_INCIDENT: "ADMIN",
};

const P0_RULES = new Set([
  "R12_FIRST_PAID_ORDER", "R19_PAYMENT_AUTHENTICATION_REQUIRED", "R20_PAYMENT_FAILED",
  "R21_ORDER_CONFIRMED", "R25_PAYOUT_ACTION_REQUIRED", "R32_SUBSCRIPTION_PAYMENT_FAILED",
  "R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED", "R40_CRITICAL_INCIDENT",
]);

function orchestrationFields(input: CreateNotificationInput) {
  const data = input.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const value = data as Record<string, unknown>;
  const ruleId = typeof value.ruleKey === "string" ? value.ruleKey : null;
  const eventId = typeof value.eventId === "string" ? value.eventId : null;
  if (!ruleId || !eventId) return {};
  const audienceRole: Record<string, NotificationRecipientRole> = {
    buyer: "BUYER", vendor: "VENDOR", admin: "ADMIN", organiser: "ORGANISER", participant: "PARTICIPANT", supplier: "SUPPLIER",
  };
  const role = (typeof value.recipientRole === "string" ? audienceRole[value.recipientRole.toLowerCase()] : undefined)
    ?? (typeof value.audience === "string" ? audienceRole[value.audience.toLowerCase()] : undefined)
    ?? RULE_RECIPIENT_ROLE[ruleId];
  const entity = ruleId === "R09_PUBLICATION_CONFIRMED" && typeof value.vendorId === "string"
    ? ["vendorId", "Vendor"]
    : [
    ["orderId", "Order"], ["productId", "Product"], ["vendorId", "Vendor"], ["campaignId", "CommunityCampaign"],
    ["payoutRequestId", "Payout"], ["payoutId", "Payout"], ["conversationId", "Conversation"],
    ["vendorSubscriptionId", "VendorSubscription"], ["subscriptionId", "VendorSubscription"],
    ["authorisationId", "CommunityBuyPaymentAuthorisation"], ["anomalyKey", "PaymentAnomaly"], ["checkoutId", "Checkout"],
    ].find(([key]) => typeof value[key!] === "string");
  const entityId = entity ? value[entity[0]!] as string : null;
  const ruleVersion = Number(value.ruleVersion);
  if (!role || !entity || !entityId || !Number.isInteger(ruleVersion) || ruleVersion < 1) return {};
  return {
    ruleId,
    ruleVersion,
    eventId,
    role,
    priority: (P0_RULES.has(ruleId) ? "P0" : "P1") as NotificationPriority,
    entityType: entity[1]!,
    entityId,
    taskEpisodeKey: [input.userId, role, entity[1], entityId, `${ruleId}:${eventId}`].join(":"),
    dueAt: new Date(),
    candidateState: "QUEUED" as const,
    templateVersion: String(value.templateVersion ?? "1"),
    category: "SERVICE" as const,
  };
}

export interface ListNotificationsQuery {
  limit?: number;
  cursor?: string;
  unreadOnly?: boolean;
}

export interface OrchestrationPreferenceInput {
  channel: NotificationPreferenceChannel;
  category: NotificationPreferenceCategory;
  consent: NotificationConsent;
  timezone?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

type PrismaLike = Prisma.TransactionClient | typeof prisma;

function isUniqueViolation(error: unknown, field: string): boolean {
  const e = error as any;
  return e?.code === "P2002"
    && Array.isArray(e?.meta?.target)
    && e.meta.target.includes(field);
}

export const notificationsService = {
  /**
   * Returns null (not an error) when `dedupeKey` was already used by an
   * existing notification — the DB-level unique constraint is what
   * actually prevents the duplicate, including under two concurrent
   * calls; this just turns that into a clean "already exists" signal
   * instead of letting the caller stumble into a raw P2002.
   */
  async create(input: CreateNotificationInput, tx: PrismaLike = prisma): Promise<Notification | null> {
    try {
      return await tx.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data,
          dedupeKey: input.dedupeKey,
          ...orchestrationFields(input),
        },
      });
    } catch (error) {
      if (input.dedupeKey && isUniqueViolation(error, "dedupeKey")) {
        return null;
      }
      throw error;
    }
  },

  // Async path: when Redis is configured, push the notification to the
  // BullMQ queue and let the worker create it in the DB. When Redis
  // is unavailable, fall back to a direct DB insert so the app keeps
  // working in local dev. Never throws — notifications must not break
  // the calling business operation.
  //
  // Always persists the Notification row directly and fires an Expo push —
  // does not depend on the BullMQ notifications queue being drained by a
  // worker. notifications.worker.ts is written to run as a standalone
  // long-lived process (its own comment says so); nothing in this repo's
  // deployment config (Vercel serverless functions only, confirmed via
  // vercel.json / api/index.ts) actually runs it. If REDIS_URL were ever
  // set in production without also deploying that worker elsewhere, the
  // old code here would silently queue notifications that nothing ever
  // processes — the in-app Notification row would just never be created,
  // even though (confusingly) the push still went out via the code below.
  // Still best-effort-enqueues afterwards so a real worker, if deployed,
  // has a record for retries/analytics — but delivery never depends on it.
  async enqueue(input: CreateNotificationInput): Promise<void> {
    let created: Notification | null = null;
    try {
      created = await this.create(input);
    } catch (error) {
      logger.error("Notification insert failed", {
        type: input.type,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    // A dedupeKey that already existed means this exact event already
    // produced a notification — the DB row, the push, and the best-effort
    // queue entry all represent the SAME effective notification, so all
    // three stop here. Without this, a deduped DB insert would still fire
    // a real duplicate push to the buyer's device on every repeated sweep.
    if (input.dedupeKey && created === null) {
      logger.info("Notification skipped: duplicate dedupeKey", { type: input.type, dedupeKey: input.dedupeKey });
      return;
    }

    // Fire Expo push after saving to DB — awaited for serverless.
    await sendPushToUser(input.userId, {
      title: input.title,
      body: input.body ?? "",
      data: {
        ...(input.data as Record<string, unknown> | undefined),
        ...(created ? { notificationId: created.id } : {}),
      },
    }).catch((error) => {
      logger.warn("Push notification send failed (non-blocking)", {
        userId: input.userId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });

    if (notificationsQueue) {
      notificationsQueue.add(NOTIFICATION_JOB, input, { jobId: undefined }).catch((error) => {
        logger.warn("Notification best-effort enqueue failed (non-blocking)", {
          type: input.type,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
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
    }

    const notification = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    // The authenticated single-item read endpoint is invoked by the mobile
    // notification tap handler. Keep this attribution separate from inbox
    // bulk-read actions, which do not imply a click.
    await prisma.notificationOutcome.upsert({
      where: { notificationId },
      create: { notificationId, clickedAt: new Date() },
      update: {},
    });
    return notification;
  },

  async markAllRead(userId: string): Promise<{ count: number }> {
    const result = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  },

  /**
   * Phase 3 fix: no primitive existed for a real unread badge count — only
   * list({unreadOnly: true}), which returns paginated rows, not a cheap
   * total. A UI showing "3 unread" anywhere outside the notification list
   * itself (a bell icon, a tab badge) had nothing real to call.
   */
  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const count = await prisma.notification.count({ where: { userId, readAt: null } });
    return { count };
  },

  async getPreferences(userId: string) {
    return prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        smsMarketingConsentAt: true,
        smsTransactionalEnabled: true,
        marketingConsentAt: true,
      },
    });
  },

  async updatePreferences(userId: string, input: { smsMarketing?: boolean; smsTransactional?: boolean; marketingConsent?: boolean }) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.smsMarketing === undefined
          ? {}
          : { smsMarketingConsentAt: input.smsMarketing ? new Date() : null }),
        ...(input.smsTransactional === undefined
          ? {}
          : { smsTransactionalEnabled: input.smsTransactional }),
        // Gates CART_RECOVERY / BUYER_WIN_BACK / BUYER_REFERRAL /
        // REVIEW_REQUEST in automation.service.ts's isEligible() — that
        // check already reads this field as-is, so honoring the buyer's
        // choice here requires no change on the automation side at all.
        ...(input.marketingConsent === undefined
          ? {}
          : { marketingConsentAt: input.marketingConsent ? new Date() : null }),
      },
      select: {
        smsMarketingConsentAt: true,
        smsTransactionalEnabled: true,
        marketingConsentAt: true,
      },
    });
  },

  async getOrchestrationPreferences(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });
    return prisma.notificationPreference.findMany({
      where: { userId, role: user.role },
      orderBy: [{ category: "asc" }, { channel: "asc" }],
    });
  },

  async updateOrchestrationPreferences(userId: string, preferences: OrchestrationPreferenceInput[]) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } });
    await prisma.$transaction(async (tx) => {
      for (const preference of preferences) {
        await tx.notificationPreference.upsert({
          where: { userId_role_channel_category: {
            userId,
            role: user.role,
            channel: preference.channel,
            category: preference.category,
          } },
          create: {
            userId,
            role: user.role,
            channel: preference.channel,
            category: preference.category,
            consent: preference.consent,
            timezone: preference.timezone ?? "UTC",
            quietHoursStart: preference.quietHoursStart ?? null,
            quietHoursEnd: preference.quietHoursEnd ?? null,
          },
          update: {
            consent: preference.consent,
            ...(preference.timezone === undefined ? {} : { timezone: preference.timezone }),
            ...(preference.quietHoursStart === undefined ? {} : { quietHoursStart: preference.quietHoursStart }),
            ...(preference.quietHoursEnd === undefined ? {} : { quietHoursEnd: preference.quietHoursEnd }),
          },
        });
      }
    });
    return this.getOrchestrationPreferences(userId);
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
