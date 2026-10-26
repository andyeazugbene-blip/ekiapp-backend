import type { Event, Prisma } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { eventOutboxService } from "./event-outbox.service";
import { EVENT_NAMES } from "./events.service";
import { resolveNotificationRule } from "./notification-event-rules";

function requiredId(payload: unknown, field: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AppError("Invalid support response event payload", 400);
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim()) throw new AppError(`Missing support response ${field}`, 400);
  return value;
}

/**
 * R28 consumer for the real general SUPPORT conversation model. This only
 * materializes the in-app candidate. Outbox delivery and candidate creation
 * commit together; external push remains a post-commit delivery concern.
 */
export async function handleSupportResponseReceived(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const conversationId = requiredId(event.payload, "conversationId");
  const messageId = requiredId(event.payload, "messageId");
  const message = await tx.message.findUnique({
    where: { id: messageId },
    include: { conversation: { select: { id: true, type: true, status: true, participantA: true, participantB: true } } },
  });

  // The event is authoritative only while it still describes an unread,
  // customer-visible reply in an open general support thread.
  if (!message || message.conversationId !== conversationId || message.isInternal
    || message.conversation.type !== "SUPPORT"
    || message.conversation.status !== "OPEN" || message.readAt) return;

  const [sender, a, b] = await Promise.all([
    tx.user.findUnique({ where: { id: message.senderId }, select: { id: true, role: true } }),
    tx.user.findUnique({ where: { id: message.conversation.participantA }, select: { id: true, role: true } }),
    tx.user.findUnique({ where: { id: message.conversation.participantB }, select: { id: true, role: true } }),
  ]);
  if (sender?.role !== "ADMIN") return;
  const recipient = a?.role === "ADMIN" ? b : a;
  if (!recipient || recipient.role === "ADMIN") return;

  const dedupeKey = `R28_SUPPORT_THREAD_REPLY:${messageId}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "NEW_MESSAGE",
    title: "Eki Support has replied",
    body: "Open your case to read the update.",
    data: {
      type: "support_case_response",
      ruleKey: rule.key,
      ruleVersion: rule.version,
      eventId: event.id,
      templateVersion: 1,
      destination: "support_case",
      conversationId,
      messageId,
    },
    dedupeKey,
  }, tx);
  const candidate = created ?? await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (candidate) {
    await tx.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId: candidate.id, channel: "push" } },
      create: { notificationId: candidate.id, channel: "push" },
      update: {},
    });
  }
}

/** R17 rule handler: exact vendor alert for an active listing that truly reached zero. */
export async function handleProductStockDepleted(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const productId = requiredId(event.payload, "productId");
  const stockVersion = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>).stockVersion
    : undefined;
  if (!Number.isSafeInteger(stockVersion) || Number(stockVersion) < 1) throw new AppError("Invalid product stock version", 400);

  const product = await tx.product.findUnique({
    where: { id: productId },
    include: { vendor: { select: { userId: true } } },
  });
  if (!product || !product.isActive || product.status !== "PUBLISHED" || product.stock !== 0 || product.stockVersion !== stockVersion) return;

  const recipient = await tx.user.findUnique({
    where: { id: product.vendor.userId },
    select: { id: true, role: true, isSuspended: true },
  });
  if (!recipient || recipient.role !== "VENDOR" || recipient.isSuspended) return;

  const dedupeKey = `R17_STOCK_DEPLETED:${product.id}:v${stockVersion}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "AUTOMATION_MESSAGE",
    title: `${product.title} is out of stock`,
    body: "Restock it when available.",
    data: {
      type: "product_stock_depleted",
      ruleKey: rule.key,
      ruleVersion: rule.version,
      eventId: event.id,
      templateVersion: 1,
      destination: "inventory_detail",
      productId: product.id,
      stockVersion,
    },
    dedupeKey,
  }, tx);
  const candidate = created ?? await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (candidate) {
    await tx.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId: candidate.id, channel: "push" } },
      create: { notificationId: candidate.id, channel: "push" },
      update: {},
    });
  }
}

/** R35: notify only the campaign organiser after a confirmed minimum threshold. */
export async function handleCommunityBuyMinimumReached(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const campaignId = requiredId(event.payload, "campaignId");
  const payload = event.payload as Record<string, unknown>;
  const confirmedShares = payload.confirmedShares;
  const minimumShares = payload.minimumShares;
  if (!Number.isSafeInteger(confirmedShares) || !Number.isSafeInteger(minimumShares)
    || Number(minimumShares) < 1 || Number(confirmedShares) < Number(minimumShares)) {
    throw new AppError("Invalid Community Buy minimum-reached event quantities", 400);
  }

  const campaign = await tx.communityCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true, title: true, minimumShares: true, confirmedShares: true, paymentMode: true, status: true, organiser: { select: { userId: true } } },
  });
  if (!campaign || !campaign.minimumShares || campaign.minimumShares !== minimumShares
    || (campaign.confirmedShares < campaign.minimumShares
      && !(campaign.paymentMode === "AUTHORISE_THEN_CAPTURE"
        && ["PAYMENT_CAPTURE", "FULFILLING", "COMPLETED"].includes(campaign.status)
        && Number(confirmedShares) >= campaign.minimumShares))
    || ["CANCELLED", "FAILED", "FINANCIALLY_CLOSED"].includes(campaign.status)) return;
  const recipient = await tx.user.findUnique({
    where: { id: campaign.organiser.userId },
    select: { id: true, role: true, isSuspended: true },
  });
  if (!recipient || recipient.role !== "BUYER" || recipient.isSuspended) return;

  const dedupeKey = `R35_COMMUNITY_BUY_MINIMUM_REACHED:${campaign.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title: "Your Community Buy reached its minimum",
    body: "Review the campaign's next step.",
    data: {
      type: "community_campaign_update",
      event: "minimum_reached",
      audience: "organiser",
      ruleKey: rule.key,
      ruleVersion: rule.version,
      eventId: event.id,
      templateVersion: 1,
      destination: "community_buy_campaign",
      campaignId: campaign.id,
      confirmedShares: Number(confirmedShares),
      minimumShares: campaign.minimumShares,
      paymentMode: campaign.paymentMode,
    },
    dedupeKey,
  }, tx);
  const candidate = created ?? await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (candidate) {
    await tx.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId: candidate.id, channel: "push" } },
      create: { notificationId: candidate.id, channel: "push" },
      update: {},
    });
  }
}

/** R25: a real Stripe payout hold requires the vendor to review next steps. */
export async function handlePayoutActionRequired(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const payoutRequestId = requiredId(event.payload, "payoutRequestId");
  const payout = await tx.payoutRequest.findUnique({
    where: { id: payoutRequestId },
    select: { id: true, vendorId: true, status: true, vendor: { select: { userId: true } } },
  });
  if (!payout || payout.status !== "ON_HOLD") return;
  const recipient = await tx.user.findUnique({
    where: { id: payout.vendor.userId },
    select: { id: true, role: true, isSuspended: true },
  });
  if (!recipient || recipient.role !== "VENDOR" || recipient.isSuspended) return;

  const dedupeKey = `R25_PAYOUT_ACTION_REQUIRED:${payout.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "PAYOUT_REQUESTED",
    title: "Your payout needs attention",
    body: "Review the secure payment-provider requirement.",
    data: {
      type: "payout_action_required",
      ruleKey: rule.key,
      ruleVersion: rule.version,
      eventId: event.id,
      templateVersion: 1,
      destination: "membership",
      payoutRequestId: payout.id,
    },
    dedupeKey,
  }, tx);
  const candidate = created ?? await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (candidate) {
    await tx.notificationDelivery.upsert({
      where: { notificationId_channel: { notificationId: candidate.id, channel: "push" } },
      create: { notificationId: candidate.id, channel: "push" },
      update: {},
    });
  }
}

/** R26: a confirmed payout gets one vendor-targeted candidate. */
export async function handlePayoutConfirmed(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const payoutRequestId = requiredId(event.payload, "payoutRequestId");
  const payout = await tx.payoutRequest.findUnique({
    where: { id: payoutRequestId },
    select: { id: true, status: true, vendor: { select: { userId: true } } },
  });
  if (!payout || payout.status !== "PAID") return;
  const recipient = await tx.user.findUnique({ where: { id: payout.vendor.userId }, select: { id: true, role: true, isSuspended: true } });
  if (!recipient || recipient.role !== "VENDOR" || recipient.isSuspended) return;
  const dedupeKey = `R26_PAYOUT_CONFIRMED:${payout.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "PAYOUT_PAID",
    title: "Your payout has been completed",
    body: "View the transaction details.",
    data: {
      type: "payout_confirmed", ruleKey: rule.key, ruleVersion: rule.version,
      eventId: event.id, templateVersion: 1, destination: "membership", payoutRequestId: payout.id,
    },
    dedupeKey,
  }, tx);
  const candidate = created ?? await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (candidate) await tx.notificationDelivery.upsert({
    where: { notificationId_channel: { notificationId: candidate.id, channel: "push" } },
    create: { notificationId: candidate.id, channel: "push" },
    update: {},
  });
}

let registered = false;
export function registerCoreEventHandlers(): void {
  if (registered) return;
  eventOutboxService.registerHandler(EVENT_NAMES.support_response_received, handleSupportResponseReceived);
  eventOutboxService.registerHandler(EVENT_NAMES.product_stock_depleted, handleProductStockDepleted);
  eventOutboxService.registerHandler(EVENT_NAMES.community_buy_minimum_reached, handleCommunityBuyMinimumReached);
  eventOutboxService.registerHandler(EVENT_NAMES.payout_action_required, handlePayoutActionRequired);
  eventOutboxService.registerHandler(EVENT_NAMES.payout_confirmed, handlePayoutConfirmed);
  registered = true;
}

