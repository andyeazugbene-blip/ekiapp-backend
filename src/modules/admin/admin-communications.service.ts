import { NotificationType, Prisma, UserRole } from "@prisma/client";

import { sendPushToUser } from "../../lib/expo-push";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { sendSms } from "../../lib/sms";
import { AppError } from "../../shared/errors/app-error";

type BroadcastAudience =
  | "all" | "vendors" | "buyers"
  | "active_vendors" | "new_vendors"
  | "individual_vendor" | "individual_buyer"
  | "last_30_days_buyers" | "repeat_buyers" | "inactive_buyers"
  | "first_time_buyers" | "top_customers"
  | "bought_specific_product";
type BroadcastChannel = "in_app" | "push" | "sms" | "in_app_push" | "in_app_sms" | "in_app_push_sms";

export interface AdminBroadcastInput {
  audience: BroadcastAudience;
  channel: BroadcastChannel;
  subject: string;
  body: string;
  vendorId?: string;
  userId?: string;
  productId?: string;
}

const VALID_AUDIENCES = new Set<BroadcastAudience>([
  "all", "vendors", "buyers", "active_vendors", "new_vendors",
  "individual_vendor", "individual_buyer",
  "last_30_days_buyers", "repeat_buyers", "inactive_buyers",
  "first_time_buyers", "top_customers", "bought_specific_product",
]);
const VALID_CHANNELS = new Set<BroadcastChannel>(["in_app", "push", "sms", "in_app_push", "in_app_sms", "in_app_push_sms"]);

function normalizeInput(raw: unknown): AdminBroadcastInput {
  const input = (raw ?? {}) as Partial<AdminBroadcastInput>;
  const audience = input.audience ?? "all";
  const channel = input.channel ?? "in_app_push";
  const rawSubject = input.subject ?? (raw as { title?: unknown } | null)?.title;
  const subject = typeof rawSubject === "string" ? rawSubject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const vendorId = typeof input.vendorId === "string" ? input.vendorId.trim() : undefined;
  const userId = typeof input.userId === "string" ? input.userId.trim() : undefined;
  const productId = typeof input.productId === "string" ? input.productId.trim() : undefined;

  if (!VALID_AUDIENCES.has(audience)) throw new AppError("Invalid broadcast audience", 400);
  if (!VALID_CHANNELS.has(channel)) throw new AppError("Invalid broadcast channel", 400);
  if (!subject) throw new AppError("Broadcast subject is required", 400);
  if (!body) throw new AppError("Broadcast body is required", 400);
  if (subject.length > 120) throw new AppError("Broadcast subject is too long", 400);
  if (body.length > 1000) throw new AppError("Broadcast body is too long", 400);
  if (audience === "individual_vendor" && !vendorId) throw new AppError("vendorId is required for individual vendor broadcasts", 400);
  if (audience === "individual_buyer" && !userId) throw new AppError("userId is required for individual buyer broadcasts", 400);
  if (audience === "bought_specific_product" && !productId) throw new AppError("productId is required for product-specific broadcasts", 400);

  return { audience, channel, subject, body, vendorId, userId, productId };
}

function whereForAudience(audience: BroadcastAudience) {
  if (audience === "buyers") return { role: UserRole.BUYER, isSuspended: false };
  if (audience === "vendors") return { role: UserRole.VENDOR, isSuspended: false };
  if (audience === "active_vendors") return { role: UserRole.VENDOR, isSuspended: false, vendor: { isSuspended: false } };
  if (audience === "new_vendors") {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return { role: UserRole.VENDOR, isSuspended: false, createdAt: { gte: sevenDaysAgo } };
  }
  // For buyer-specific audiences we use the where clause with buyer role
  if (
    audience === "last_30_days_buyers" ||
    audience === "repeat_buyers" ||
    audience === "inactive_buyers" ||
    audience === "first_time_buyers" ||
    audience === "top_customers"
  ) {
    return { role: UserRole.BUYER, isSuspended: false };
  }
  return { isSuspended: false };
}

/**
 * For advanced buyer audiences, after fetching the user list we further filter
 * based on order history. Returns user IDs that match the criteria.
 */
async function resolveAdvancedBuyerAudience(
  audience: BroadcastAudience,
  userIds: string[],
  productId?: string,
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Get order stats for all qualifying buyers
  const orderStats = await prisma.order.groupBy({
    by: ["buyerId"],
    where: {
      buyerId: { in: userIds },
      status: { not: "CANCELLED" },
    },
    _count: { id: true },
    _sum: { totalAmount: true },
    _max: { createdAt: true },
  });

  const statsMap = new Map(orderStats.map((s) => [s.buyerId, {
    orderCount: s._count.id,
    totalSpent: s._sum.totalAmount ?? 0,
    lastOrderAt: s._max.createdAt,
  }]));

  // Filter based on audience type
  if (audience === "last_30_days_buyers") {
    return userIds.filter((id) => {
      const stat = statsMap.get(id);
      return stat?.lastOrderAt && stat.lastOrderAt >= thirtyDaysAgo;
    });
  }

  if (audience === "repeat_buyers") {
    return userIds.filter((id) => {
      const stat = statsMap.get(id);
      return (stat?.orderCount ?? 0) >= 2;
    });
  }

  if (audience === "inactive_buyers") {
    return userIds.filter((id) => {
      const stat = statsMap.get(id);
      return !stat || !stat.lastOrderAt || stat.lastOrderAt < thirtyDaysAgo;
    });
  }

  if (audience === "first_time_buyers") {
    return userIds.filter((id) => {
      const stat = statsMap.get(id);
      return stat?.orderCount === 1;
    });
  }

  if (audience === "top_customers") {
    const activeBuyers = userIds.filter((id) => {
      const stat = statsMap.get(id);
      return stat && (stat.totalSpent > 0 || stat.orderCount > 0);
    });
    const sorted = [...activeBuyers].sort((a, b) => {
      const aStat = statsMap.get(a);
      const bStat = statsMap.get(b);
      return (bStat?.totalSpent ?? 0) - (aStat?.totalSpent ?? 0);
    });
    const count = Math.max(1, Math.min(25, Math.ceil(sorted.length * 0.2)));
    return sorted.slice(0, count);
  }

  if (audience === "bought_specific_product" && productId) {
    const ordersWithProduct = await prisma.order.findMany({
      where: {
        buyerId: { in: userIds },
        status: { not: "CANCELLED" },
        items: {
          some: { productId },
        },
      },
      select: { buyerId: true },
      distinct: ["buyerId"],
    });
    return ordersWithProduct.map((o) => o.buyerId);
  }

  return userIds;
}

export const adminCommunicationsService = {
  normalizeInput,

  async broadcast(actorId: string, input: AdminBroadcastInput) {
    const isAdvancedBuyerAudience = [
      "last_30_days_buyers", "repeat_buyers", "inactive_buyers",
      "first_time_buyers", "top_customers", "bought_specific_product",
    ].includes(input.audience);

    // For advanced buyer audiences, first get all buyers then filter
    let recipients: { id: string; role: string; phone: string | null; smsMarketingConsentAt: Date | null }[];

    if (isAdvancedBuyerAudience) {
      const allBuyers = await prisma.user.findMany({
        where: whereForAudience(input.audience),
        select: { id: true, role: true, phone: true, smsMarketingConsentAt: true },
        take: 1000,
      });
      const matchingIds = await resolveAdvancedBuyerAudience(
        input.audience,
        allBuyers.map((u) => u.id),
        input.productId,
      );
      const idSet = new Set(matchingIds);
      recipients = allBuyers.filter((u) => idSet.has(u.id));
    } else if (input.audience === "individual_vendor") {
      recipients = await prisma.user.findMany({
        where: { vendor: { id: input.vendorId }, role: UserRole.VENDOR, isSuspended: false },
        select: { id: true, role: true, phone: true, smsMarketingConsentAt: true },
        take: 1,
      });
    } else if (input.audience === "individual_buyer") {
      recipients = await prisma.user.findMany({
        where: { id: input.userId, role: UserRole.BUYER, isSuspended: false },
        select: { id: true, role: true, phone: true, smsMarketingConsentAt: true },
        take: 1,
      });
    } else {
      recipients = await prisma.user.findMany({
        where: whereForAudience(input.audience),
        select: { id: true, role: true, phone: true, smsMarketingConsentAt: true },
        take: 1000,
      });
    }

    const shouldCreateMessages = ["in_app", "in_app_push", "in_app_sms", "in_app_push_sms"].includes(input.channel);
    const shouldPush = ["push", "in_app_push", "in_app_push_sms"].includes(input.channel);
    const shouldSms = ["sms", "in_app_sms", "in_app_push_sms"].includes(input.channel);

    let notificationsCreated = 0;
    if (recipients.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const recipient of recipients) {
          if (recipient.id === actorId) continue;
          await tx.notification.create({
            data: {
              userId: recipient.id,
              type: NotificationType.ADMIN_BROADCAST,
              title: input.subject,
              body: input.body,
              data: { source: "admin", channel: input.channel, audience: input.audience },
            },
          });
          notificationsCreated += 1;
        }
      });
    }

    let messageCount = 0;
    if (shouldCreateMessages && recipients.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const recipient of recipients) {
          if (recipient.id === actorId) continue;
          const [participantA, participantB] = actorId < recipient.id ? [actorId, recipient.id] : [recipient.id, actorId];
          const conversation = await tx.conversation.upsert({
            where: {
              participantA_participantB_orderId: {
                participantA,
                participantB,
                orderId: "",
              },
            },
            create: {
              participantA,
              participantB,
              orderId: "",
              type: recipient.role === UserRole.VENDOR ? "ADMIN_VENDOR" : "BUYER_VENDOR",
              lastMessageAt: new Date(),
            },
            update: { lastMessageAt: new Date() },
          });
          await tx.message.create({
            data: {
              conversationId: conversation.id,
              senderId: actorId,
              text: `${input.subject}\n\n${input.body}`,
            },
          });
          messageCount += 1;
        }
      });
    }

    if (shouldPush) {
      await Promise.allSettled(
        recipients.map(async (recipient) => {
          if (recipient.id === actorId) return;
          try {
            await sendPushToUser(recipient.id, {
              title: input.subject,
              body: input.body,
              data: { type: "admin_broadcast", audience: input.audience },
            });
          } catch (error) {
            logger.warn("Broadcast push send failed (non-blocking)", {
              userId: recipient.id,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }

    let smsQueued = 0;
    let smsSkipped = 0;
    if (shouldSms) {
      for (const recipient of recipients) {
        if (recipient.id === actorId) continue;
        if (!recipient.phone || !recipient.smsMarketingConsentAt) {
          smsSkipped += 1;
          continue;
        }
        smsQueued += 1;
        void sendSms({
          to: recipient.phone,
          message: `${input.subject}: ${input.body}`,
          purpose: "admin_marketing",
        });
      }
    }

    return {
      sent: recipients.filter((recipient) => recipient.id !== actorId).length,
      queued: shouldPush ? recipients.length : 0,
      notificationsCreated,
      messagesCreated: messageCount,
      smsQueued,
      smsSkipped,
      message: "Admin broadcast queued successfully.",
    };
  },
};
