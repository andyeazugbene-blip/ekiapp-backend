import type { CommunicationLog, NotificationDelivery } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { sendPushToUser } from "../../lib/expo-push";
import { EVENT_NAMES } from "../events/events.service";
import { resolveNotificationRule } from "../events/notification-event-rules";
import { COMMUNITY_BUY_ORGANISER_DECISION_WINDOW_MS } from "../community-buy/community-buy-timing";
import { getCurrentInventoryConflict } from "../products/inventory-conflict";

const MAX_ATTEMPTS = 8;
const STALE_LOCK_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

function retryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function supportReplyStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "support_case_response"
    || typeof data.conversationId !== "string" || typeof data.messageId !== "string"
    || delivery.notification.readAt) return false;

  const [message, recipient] = await Promise.all([
    prisma.message.findUnique({
      where: { id: data.messageId },
      include: { conversation: { select: { id: true, type: true, status: true, participantA: true, participantB: true } } },
    }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  if (!message || !recipient || recipient.isSuspended || recipient.role === "ADMIN"
    || message.conversationId !== data.conversationId || message.isInternal || message.readAt
    || message.conversation.type !== "SUPPORT" || message.conversation.status !== "OPEN") return false;
  if (message.conversation.participantA !== recipient.id && message.conversation.participantB !== recipient.id) return false;
  const sender = await prisma.user.findUnique({ where: { id: message.senderId }, select: { role: true } });
  return sender?.role === "ADMIN";
}

async function productStockAlertStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R17_STOCK_DEPLETED_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "product_stock_depleted" || typeof data.productId !== "string"
    || !Number.isSafeInteger(data.stockVersion) || delivery.notification.readAt) return false;
  const product = await prisma.product.findUnique({
    where: { id: data.productId },
    include: { vendor: { select: { userId: true } } },
  });
  const recipient = await prisma.user.findUnique({
    where: { id: delivery.notification.userId },
    select: { id: true, role: true, isSuspended: true },
  });
  return Boolean(product && recipient && !recipient.isSuspended && recipient.role === "VENDOR"
    && product.vendor.userId === recipient.id && product.isActive && product.status === "PUBLISHED"
    && product.stock === 0 && product.stockVersion === data.stockVersion);
}

async function productInventoryConflictStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R18_STOCK_CONFLICT_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "product_inventory_conflict" || typeof data.productId !== "string"
    || typeof data.inventoryCountId !== "string" || delivery.notification.readAt) return false;
  const [conflict, product, recipient, latestCount] = await Promise.all([
    getCurrentInventoryConflict(prisma, data.inventoryCountId),
    prisma.product.findUnique({ where: { id: data.productId }, include: { vendor: { select: { userId: true } } } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
    prisma.productInventoryCount.findFirst({ where: { productId: data.productId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } }),
  ]);
  return Boolean(conflict && conflict.count.productId === data.productId && conflict.shortfall > 0
    && latestCount?.id === data.inventoryCountId && product && product.isActive && product.status === "PUBLISHED"
    && product.stockVersion === conflict.count.stockVersion && product.vendor.userId === delivery.notification.userId
    && recipient?.role === "VENDOR" && !recipient.isSuspended);
}

async function paidOrderStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  const data = delivery.notification.data;
  if (!isRecord(data) || typeof data.orderId !== "string" || delivery.notification.readAt
    || process.env.R12_FIRST_PAID_ORDER_ENABLED !== "true") return false;
  const rule = resolveNotificationRule({ name: EVENT_NAMES.payment_succeeded, schemaVersion: Number(data.ruleVersion) });
  if (!rule?.enabled || rule.key !== "R12_FIRST_PAID_ORDER") return false;
  const [order, recipient] = await Promise.all([
    prisma.order.findUnique({ where: { id: data.orderId }, select: { status: true, vendorConfirmedAt: true, vendorId: true, items: { select: { vendorId: true } } } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  const vendorId = order?.vendorId ?? order?.items[0]?.vendorId;
  const vendor = vendorId ? await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } }) : null;
  return Boolean(order?.status === "PAID" && !order.vendorConfirmedAt && vendor?.userId === delivery.notification.userId
    && recipient?.id === delivery.notification.userId && recipient.role === "VENDOR" && !recipient.isSuspended);
}

async function buyerOrderConfirmationStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  const data = delivery.notification.data;
  if (!isRecord(data) || typeof data.orderId !== "string" || delivery.notification.readAt
    || process.env.R21_ORDER_CONFIRMED_ENABLED !== "true") return false;
  const rule = resolveNotificationRule({ name: EVENT_NAMES.order_accepted, schemaVersion: Number(data.ruleVersion) });
  if (!rule?.enabled || rule.key !== "R21_ORDER_CONFIRMED") return false;
  const [order, recipient] = await Promise.all([
    prisma.order.findUnique({ where: { id: data.orderId }, select: { buyerId: true, status: true } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  return Boolean(order?.status === "CONFIRMED" && order.buyerId === delivery.notification.userId
    && recipient?.id === delivery.notification.userId && recipient.role === "BUYER" && !recipient.isSuspended);
}

async function dispatchedOrderStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  const data = delivery.notification.data;
  if (!isRecord(data) || typeof data.orderId !== "string" || delivery.notification.readAt
    || process.env.R22_ORDER_DISPATCHED_ENABLED !== "true") return false;
  const rule = resolveNotificationRule({ name: EVENT_NAMES.order_dispatched, schemaVersion: Number(data.ruleVersion) });
  if (!rule?.enabled || rule.key !== "R22_ORDER_DISPATCHED") return false;
  const [order, recipient] = await Promise.all([
    prisma.order.findUnique({ where: { id: data.orderId }, select: { buyerId: true, status: true } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  return Boolean(order?.status === "DISPATCHED" && order.buyerId === delivery.notification.userId
    && recipient?.id === delivery.notification.userId && recipient.role === "BUYER" && !recipient.isSuspended);
}

async function criticalIncidentStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R40_PAYMENT_ANOMALY_ALERTS_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "critical_incident" || data.ruleKey !== "R40_CRITICAL_INCIDENT"
    || typeof data.incidentId !== "string" || delivery.notification.readAt) return false;
  const [incident, recipient] = await Promise.all([
    prisma.paymentAnomaly.findUnique({ where: { id: data.incidentId }, select: { id: true, dedupeKey: true, severity: true, status: true } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  return Boolean(incident && incident.dedupeKey === data.anomalyKey && incident.severity === "CRITICAL"
    && incident.status !== "RESOLVED" && recipient?.id === delivery.notification.userId
    && recipient.role === "ADMIN" && !recipient.isSuspended);
}

async function communityBuyMinimumStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "community_campaign_update" || data.event !== "minimum_reached"
    || typeof data.campaignId !== "string" || !Number.isSafeInteger(data.minimumShares)
    || !Number.isSafeInteger(data.confirmedShares) || delivery.notification.readAt) return false;
  const [campaign, recipient] = await Promise.all([
    prisma.communityCampaign.findUnique({
      where: { id: data.campaignId },
      select: { status: true, minimumShares: true, confirmedShares: true, paymentMode: true, organiser: { select: { userId: true } } },
    }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  if (!campaign || !recipient || recipient.role !== "BUYER" || recipient.isSuspended || campaign.organiser.userId !== recipient.id
    || campaign.minimumShares == null || campaign.minimumShares !== data.minimumShares
    || ["CANCELLED", "FAILED", "FINANCIALLY_CLOSED"].includes(campaign.status)) return false;
  const thresholdStillMet = campaign.confirmedShares >= campaign.minimumShares
    || (campaign.paymentMode === "AUTHORISE_THEN_CAPTURE"
      && ["PAYMENT_CAPTURE", "FULFILLING", "COMPLETED"].includes(campaign.status)
      && Number(data.confirmedShares) >= Number(data.minimumShares));
  return thresholdStillMet;
}

async function communityBuyPaymentActionStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "community_buy_payment_action_required" || typeof data.authorisationId !== "string"
    || typeof data.campaignId !== "string" || delivery.notification.readAt) return false;
  const [authorisation, recipient] = await Promise.all([
    prisma.communityBuyPaymentAuthorisation.findUnique({
      where: { id: data.authorisationId },
      select: { holdStatus: true, campaignId: true, contribution: { select: { participant: { select: { userId: true } } } } },
    }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  return Boolean(authorisation && authorisation.holdStatus === "REQUIRES_ACTION" && authorisation.campaignId === data.campaignId
    && authorisation.contribution.participant.userId === delivery.notification.userId
    && recipient && recipient.role === "BUYER" && !recipient.isSuspended);
}

async function payoutActionStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R25_PAYOUT_ACTION_REQUIRED_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "payout_action_required" || typeof data.payoutRequestId !== "string"
    || delivery.notification.readAt) return false;
  const [payout, recipient] = await Promise.all([
    prisma.payoutRequest.findUnique({ where: { id: data.payoutRequestId }, select: { status: true, vendor: { select: { userId: true } } } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  return Boolean(payout && payout.status === "ON_HOLD" && recipient && recipient.role === "VENDOR"
    && !recipient.isSuspended && payout.vendor.userId === recipient.id);
}

async function vendorMembershipPaymentStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R29_MEMBERSHIP_PAYMENT_FAILED_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "subscription_update" || data.event !== "vendor_subscription_payment_failed"
    || typeof data.vendorSubscriptionId !== "string" || delivery.notification.readAt) return false;
  const [subscription, recipient] = await Promise.all([
    prisma.vendorSubscription.findUnique({
      where: { id: data.vendorSubscriptionId },
      select: { status: true, vendorId: true },
    }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  if (!subscription || subscription.status !== "PAST_DUE" || !recipient || recipient.role !== "VENDOR" || recipient.isSuspended) return false;
  const vendor = await prisma.vendor.findUnique({ where: { id: subscription.vendorId }, select: { userId: true } });
  return vendor?.userId === recipient.id;
}

async function communityBuyBelowMinimumStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R34_COMMUNITY_BUY_BELOW_MINIMUM_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "community_campaign_update" || data.event !== "below_minimum"
    || typeof data.campaignId !== "string" || delivery.notification.readAt) return false;
  const [campaign, recipient] = await Promise.all([
    prisma.communityCampaign.findUnique({ where: { id: data.campaignId }, select: { status: true, paymentMode: true, minimumShares: true, confirmedShares: true, rescueEndsAt: true, decisionRequiredAt: true, organiser: { select: { userId: true } } } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  if (!campaign || !recipient || recipient.role !== "BUYER" || recipient.isSuspended
    || campaign.organiser.userId !== recipient.id || campaign.minimumShares == null) return false;
  const deadline = campaign.status === "RESCUE_WINDOW" ? campaign.rescueEndsAt
    : campaign.status === "DECISION_REQUIRED" && campaign.decisionRequiredAt
      ? new Date(campaign.decisionRequiredAt.getTime() + COMMUNITY_BUY_ORGANISER_DECISION_WINDOW_MS)
      : null;
  if (!deadline || deadline <= new Date()) return false;
  const quantity = campaign.paymentMode === "AUTHORISE_THEN_CAPTURE"
    ? (await prisma.campaignContribution.findMany({
      where: { campaignId: data.campaignId, paymentAuthorisation: { holdStatus: "HOLD_SUCCEEDED" } },
      select: { quantity: true },
    })).reduce((sum, contribution) => sum + contribution.quantity, 0)
    : campaign.confirmedShares;
  return quantity < campaign.minimumShares && data.deadline === deadline.toISOString()
    && data.remainingShares === campaign.minimumShares - quantity;
}
async function payoutConfirmedStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R26_PAYOUT_CONFIRMED_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "payout_confirmed" || typeof data.payoutRequestId !== "string"
    || delivery.notification.readAt) return false;
  const [payout, recipient] = await Promise.all([
    prisma.payoutRequest.findUnique({ where: { id: data.payoutRequestId }, select: { status: true, vendor: { select: { userId: true } } } }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, role: true, isSuspended: true } }),
  ]);
  return Boolean(payout?.status === "PAID" && recipient?.role === "VENDOR" && !recipient.isSuspended
    && payout.vendor.userId === recipient.id);
}
async function supplierReconfirmationStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  if (process.env.R37_SUPPLIER_RECONFIRMATION_ENABLED !== "true") return false;
  const data = delivery.notification.data;
  if (!isRecord(data) || data.type !== "supplier_reconfirmation_requested" || typeof data.campaignId !== "string"
    || typeof data.deadline !== "string" || typeof data.requestedAt !== "string"
    || !Number.isSafeInteger(data.quantity) || delivery.notification.readAt) return false;
  const deadline = new Date(data.deadline);
  const requestedAt = new Date(data.requestedAt);
  if (Number.isNaN(deadline.getTime()) || deadline <= new Date() || Number.isNaN(requestedAt.getTime())) return false;
  const [campaign, recipient] = await Promise.all([
    prisma.communityCampaign.findUnique({
      where: { id: data.campaignId },
      select: {
        status: true, reconfirmationDeadline: true, reconfirmationRequestedAt: true, reconfirmationQuantity: true,
        supplierAccount: { select: { userId: true } },
        supplier: { select: { vendor: { select: { userId: true } } } },
      },
    }),
    prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { id: true, isSuspended: true } }),
  ]);
  const currentSupplierId = campaign?.supplierAccount?.userId ?? campaign?.supplier?.vendor.userId;
  return Boolean(campaign && recipient && !recipient.isSuspended && currentSupplierId === recipient.id
    && campaign.status === "AWAITING_SUPPLIER_RECONFIRMATION"
    && campaign.reconfirmationDeadline?.getTime() === deadline.getTime()
    && campaign.reconfirmationRequestedAt?.getTime() === requestedAt.getTime()
    && campaign.reconfirmationQuantity === data.quantity);
}

async function notificationStillEligible(delivery: NotificationDelivery & { notification: { userId: string; readAt: Date | null; data: unknown } }): Promise<boolean> {
  const data = delivery.notification.data;
  if (!isRecord(data)) return false;
  if (data.type === "buyer_order_dispatched" && data.ruleKey === "R22_ORDER_DISPATCHED") return dispatchedOrderStillEligible(delivery);
  if (data.type === "buyer_order_confirmed" && data.ruleKey === "R21_ORDER_CONFIRMED") return buyerOrderConfirmationStillEligible(delivery);
  if (data.type === "vendor_order_paid" && data.ruleKey === "R12_FIRST_PAID_ORDER") return paidOrderStillEligible(delivery);
  if (data.type === "critical_incident" && data.ruleKey === "R40_CRITICAL_INCIDENT") {
    return criticalIncidentStillEligible(delivery);
  }
  if (data.type === "support_case_response" && data.ruleKey === "R28_SUPPORT_RESPONSE") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.support_response_received, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await supportReplyStillEligible(delivery));
  }
  if (data.type === "product_stock_depleted" && data.ruleKey === "R17_STOCK_DEPLETED") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.product_stock_depleted, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await productStockAlertStillEligible(delivery));
  }
  if (data.type === "product_inventory_conflict" && data.ruleKey === "R18_STOCK_CONFLICT") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.product_inventory_conflict_detected, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await productInventoryConflictStillEligible(delivery));
  }
  if (data.type === "community_campaign_update" && data.event === "minimum_reached" && data.ruleKey === "R35_COMMUNITY_BUY_MINIMUM_REACHED") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.community_buy_minimum_reached, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await communityBuyMinimumStillEligible(delivery));
  }
  if (data.type === "community_buy_payment_action_required" && data.ruleKey === "R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.community_buy_payment_action_required, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await communityBuyPaymentActionStillEligible(delivery));
  }
  if (data.type === "supplier_reconfirmation_requested" && data.ruleKey === "R37_SUPPLIER_RECONFIRMATION") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.community_buy_supplier_reconfirmation_requested, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await supplierReconfirmationStillEligible(delivery));
  }
  if (data.type === "payout_action_required" && data.ruleKey === "R25_PAYOUT_ACTION_REQUIRED") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.payout_action_required, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await payoutActionStillEligible(delivery));
  }
  if (data.type === "subscription_update" && data.event === "vendor_subscription_payment_failed" && data.ruleKey === "R29_MEMBERSHIP_PAYMENT_FAILED") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.vendor_membership_payment_failed, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await vendorMembershipPaymentStillEligible(delivery));
  }
  if (data.type === "community_campaign_update" && data.event === "below_minimum" && data.ruleKey === "R34_COMMUNITY_BUY_BELOW_MINIMUM") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.community_buy_below_minimum, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await communityBuyBelowMinimumStillEligible(delivery));
  }
  if (data.type === "payout_confirmed" && data.ruleKey === "R26_PAYOUT_CONFIRMED") {
    const rule = resolveNotificationRule({ name: EVENT_NAMES.payout_confirmed, schemaVersion: Number(data.ruleVersion) });
    return Boolean(rule?.enabled && await payoutConfirmedStillEligible(delivery));
  }
  return false;
}

export const notificationDeliveryService = {
  /** Process durable push deliveries. Expo receipt checks finalize SENT rows. */
  async dispatchBatch(limit = 50, now = new Date()): Promise<{ claimed: number; sent: number; retried: number; cancelled: number; dead: number }> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    await prisma.notificationDelivery.updateMany({
      where: { status: "PROCESSING", lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
      data: { status: "PENDING", lockedAt: null, availableAt: now },
    });
    const due = await prisma.notificationDelivery.findMany({
      where: { status: "PENDING", availableAt: { lte: now } },
      include: { notification: { select: { id: true, userId: true, title: true, body: true, data: true, readAt: true } } },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      take: boundedLimit,
    });
    const result = { claimed: 0, sent: 0, retried: 0, cancelled: 0, dead: 0 };

    for (const delivery of due) {
      const claim = await prisma.notificationDelivery.updateMany({
        where: { id: delivery.id, status: "PENDING", availableAt: { lte: now } },
        data: { status: "PROCESSING", lockedAt: now, attempt: { increment: 1 } },
      });
      if (!claim.count) continue;
      result.claimed++;
      const attempt = delivery.attempt + 1;

      if (!(await notificationStillEligible(delivery))) {
        await prisma.notificationDelivery.updateMany({
          where: { id: delivery.id, status: "PROCESSING", lockedAt: now },
          data: { status: "CANCELLED", lockedAt: null, lastError: "send_time_ineligible" },
        });
        result.cancelled++;
        continue;
      }

      const role = await prisma.user.findUnique({ where: { id: delivery.notification.userId }, select: { role: true } });
      const data = isRecord(delivery.notification.data) ? delivery.notification.data : {};
      const communication = await prisma.$transaction(async (tx) => {
        const log = await tx.communicationLog.create({
          data: {
            recipientId: delivery.notification.userId,
            recipientType: role?.role ?? "UNKNOWN",
            eventKey: `notification_delivery:${delivery.id}:attempt:${attempt}`,
            channel: "push",
            title: delivery.notification.title,
            body: delivery.notification.body ?? "",
            status: "QUEUED",
            metadata: { deliveryId: delivery.id, notificationId: delivery.notification.id, ...data },
          },
        });
        await tx.notificationDelivery.updateMany({
          where: { id: delivery.id, status: "PROCESSING", lockedAt: now },
          data: { communicationLogId: log.id },
        });
        return log;
      });

      const push = await sendPushToUser(delivery.notification.userId, {
        title: delivery.notification.title,
        body: delivery.notification.body ?? "",
        data: { ...data, notificationId: delivery.notification.id },
      }, { logId: communication.id });

      if (push.accepted > 0) {
        await prisma.communicationLog.update({
          where: { id: communication.id },
          data: { status: "SENT", providerRef: push.ticketIds[0] ?? null, statusDetail: "expo_accepted_receipt_pending" },
        });
        await prisma.notificationDelivery.updateMany({
          where: { id: delivery.id, status: "PROCESSING", lockedAt: now },
          data: { status: "SENT", lockedAt: null, communicationLogId: communication.id, providerRef: push.ticketIds[0] ?? null, lastError: null },
        });
        result.sent++;
      } else {
        const dead = attempt >= MAX_ATTEMPTS;
        const error = push.error ?? (push.tokens === 0 ? "no_push_tokens" : "provider_rejected");
        const next = new Date(now.getTime() + retryDelayMs(attempt));
        await prisma.communicationLog.update({ where: { id: communication.id }, data: { status: "FAILED", statusDetail: error } });
        await prisma.notificationDelivery.updateMany({
          where: { id: delivery.id, status: "PROCESSING", lockedAt: now },
          data: { status: dead ? "DEAD" : "PENDING", lockedAt: null, availableAt: next, communicationLogId: communication.id, lastError: error },
        });
        if (dead) result.dead++;
        else result.retried++;
        logger.warn("Notification push delivery did not reach Expo", { deliveryId: delivery.id, attempt, error, retryAt: dead ? undefined : next.toISOString() });
      }
    }
    return result;
  },

  /** Provider receipt callback: acceptance is not delivery. */
  async recordReceipt(logId: string, delivered: boolean, detail: string): Promise<void> {
    const delivery = await prisma.notificationDelivery.findUnique({ where: { communicationLogId: logId }, select: { id: true, attempt: true, status: true } });
    if (!delivery || delivery.status !== "SENT") return;
    if (delivered) {
      await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, status: "SENT" }, data: { status: "DELIVERED", deliveredAt: new Date(), lastError: null } });
      return;
    }
    const dead = delivery.attempt >= MAX_ATTEMPTS;
    await prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, status: "SENT" },
      data: {
        status: dead ? "DEAD" : "PENDING",
        availableAt: dead ? new Date() : new Date(Date.now() + retryDelayMs(delivery.attempt)),
        lastError: detail,
      },
    });
  },
};

