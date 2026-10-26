import type { Event, Prisma } from "@prisma/client";

import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { eventOutboxService } from "./event-outbox.service";
import { EVENT_NAMES } from "./events.service";
import { resolveNotificationRule } from "./notification-event-rules";
import { COMMUNITY_BUY_ORGANISER_DECISION_WINDOW_MS } from "../community-buy/community-buy-timing";
import { getCurrentInventoryConflict } from "../products/inventory-conflict";

function requiredId(payload: unknown, field: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AppError("Invalid support response event payload", 400);
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== "string" || !value.trim()) throw new AppError(`Missing support response ${field}`, 400);
  return value;
}

/** R12: tell the current vendor about a newly paid, still-unacknowledged order. */
export async function handleFirstPaidOrder(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const orderId = requiredId(event.payload, "orderId");
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, status: true, vendorConfirmedAt: true, vendorId: true, items: { select: { vendorId: true } } },
  });
  const vendorId = order?.vendorId ?? order?.items[0]?.vendorId;
  if (!order || order.status !== "PAID" || order.vendorConfirmedAt || !vendorId) return;
  const vendor = await tx.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
  if (!vendor) return;
  const recipient = await tx.user.findUnique({ where: { id: vendor.userId }, select: { id: true, role: true, isSuspended: true } });
  if (!recipient || recipient.role !== "VENDOR" || recipient.isSuspended) return;

  const dedupeKey = `R12_FIRST_PAID_ORDER:${order.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "ORDER_PAID",
    title: "You have a new paid order",
    body: "Review the order and confirm fulfilment.",
    data: {
      type: "vendor_order_paid", ruleKey: rule.key, ruleVersion: rule.version,
      eventId: event.id, templateVersion: 1, destination: "order_detail", orderId: order.id,
      orderNumber: order.orderNumber,
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

/** R21: confirm the paid order to its buyer once. */
export async function handleOrderConfirmed(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const orderId = requiredId(event.payload, "orderId");
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, buyerId: true, status: true } });
  if (!order || !["CONFIRMED", "PROCESSING", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED", "AUTO_RELEASED", "VENDOR_CONFIRMED", "DISPUTED"].includes(order.status)) return;
  const recipient = await tx.user.findUnique({ where: { id: order.buyerId }, select: { id: true, role: true, isSuspended: true } });
  if (!recipient || recipient.role !== "BUYER" || recipient.isSuspended) return;

  const dedupeKey = `R21_ORDER_CONFIRMED:${order.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "ORDER_PAID",
    title: "Your order is confirmed",
    body: "Track your foodstuff order in Eki.",
    data: {
      type: "buyer_order_confirmed", ruleKey: rule.key, ruleVersion: rule.version,
      eventId: event.id, templateVersion: 1, destination: "order_detail", orderId: order.id,
      orderNumber: order.orderNumber,
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

/** R22: tell the buyer when the vendor confirms dispatch. */
export async function handleOrderDispatched(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const orderId = requiredId(event.payload, "orderId");
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, orderNumber: true, buyerId: true, status: true } });
  if (!order || !["DISPATCHED", "IN_TRANSIT", "DELIVERED", "COMPLETED", "AUTO_RELEASED", "DISPUTED"].includes(order.status)) return;
  const recipient = await tx.user.findUnique({ where: { id: order.buyerId }, select: { id: true, role: true, isSuspended: true } });
  if (!recipient || recipient.role !== "BUYER" || recipient.isSuspended) return;

  const dedupeKey = `R22_ORDER_DISPATCHED:${order.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "ORDER_PAID",
    title: "Your foodstuff is on its way",
    body: "View the latest delivery information.",
    data: {
      type: "buyer_order_dispatched", ruleKey: rule.key, ruleVersion: rule.version,
      eventId: event.id, templateVersion: 1, destination: "order_detail", orderId: order.id,
      orderNumber: order.orderNumber,
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

/** R18: notify the listing owner only when an explicit stocktake proves a real shortfall. */
export async function handleProductInventoryConflictDetected(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const productId = requiredId(event.payload, "productId");
  const inventoryCountId = requiredId(event.payload, "inventoryCountId");
  const payload = event.payload as Record<string, unknown>;
  if (!Number.isSafeInteger(payload.stockVersion)) throw new AppError("Invalid inventory stock version", 400);
  const conflict = await getCurrentInventoryConflict(tx, inventoryCountId);
  if (!conflict || conflict.count.productId !== productId || conflict.shortfall < 1) return;
  const product = await tx.product.findUnique({
    where: { id: productId },
    include: { vendor: { select: { userId: true } } },
  });
  if (!product || product.stockVersion !== payload.stockVersion || !product.isActive || product.status !== "PUBLISHED") return;
  const recipient = await tx.user.findUnique({ where: { id: product.vendor.userId }, select: { id: true, role: true, isSuspended: true } });
  if (!recipient || recipient.role !== "VENDOR" || recipient.isSuspended) return;

  const dedupeKey = `R18_STOCK_CONFLICT:${inventoryCountId}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "INVENTORY_ALERT",
    title: "Check stock for an active order",
    body: "Available quantity may not cover outstanding orders.",
    data: {
      type: "product_inventory_conflict", ruleKey: rule.key, ruleVersion: rule.version,
      eventId: event.id, templateVersion: 1, destination: "inventory_detail", productId,
      inventoryCountId, shortfallQuantity: conflict.shortfall,
    },
    dedupeKey,
  }, tx);
  const candidate = created ?? await tx.notification.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (candidate) await tx.notificationDelivery.upsert({
    where: { notificationId_channel: { notificationId: candidate.id, channel: "push" } },
    create: { notificationId: candidate.id, channel: "push" }, update: {},
  });
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

/** R36: route a real Community Buy authentication requirement to its participant. */
export async function handleCommunityBuyPaymentActionRequired(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const authorisationId = requiredId(event.payload, "authorisationId");
  const authorisation = await tx.communityBuyPaymentAuthorisation.findUnique({
    where: { id: authorisationId },
    select: { id: true, holdStatus: true, campaignId: true, contribution: { select: { participant: { select: { userId: true } } } } },
  });
  if (!authorisation || authorisation.holdStatus !== "REQUIRES_ACTION") return;
  const recipient = await tx.user.findUnique({
    where: { id: authorisation.contribution.participant.userId },
    select: { id: true, role: true, isSuspended: true },
  });
  if (!recipient || recipient.role !== "BUYER" || recipient.isSuspended) return;

  const dedupeKey = `R36_COMMUNITY_BUY_PAYMENT_ACTION_REQUIRED:${authorisation.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title: "Your Community Buy payment needs attention",
    body: "Complete the required secure payment step.",
    data: {
      type: "community_buy_payment_action_required",
      audience: "participant",
      ruleKey: rule.key,
      ruleVersion: rule.version,
      eventId: event.id,
      templateVersion: 1,
      destination: "community_buy_campaign",
      campaignId: authorisation.campaignId,
      authorisationId: authorisation.id,
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

/** R37: ask the currently assigned supplier to reconfirm a real reduced quantity. */
export async function handleSupplierReconfirmationRequested(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const campaignId = requiredId(event.payload, "campaignId");
  const payload = event.payload as Record<string, unknown>;
  const quantity = payload.quantity;
  const deadline = typeof payload.deadline === "string" ? new Date(payload.deadline) : null;
  const requestedAt = typeof payload.requestedAt === "string" ? new Date(payload.requestedAt) : null;
  if (!Number.isSafeInteger(quantity) || Number(quantity) < 1 || !deadline || Number.isNaN(deadline.getTime())
    || !requestedAt || Number.isNaN(requestedAt.getTime())) {
    throw new AppError("Invalid supplier reconfirmation event payload", 400);
  }

  const campaign = await tx.communityCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true, status: true, title: true, reconfirmationDeadline: true,
      reconfirmationRequestedAt: true, reconfirmationQuantity: true,
      supplierAccount: { select: { userId: true } },
      supplier: { select: { vendor: { select: { userId: true } } } },
    },
  });
  if (!campaign || campaign.status !== "AWAITING_SUPPLIER_RECONFIRMATION"
    || campaign.reconfirmationDeadline?.getTime() !== deadline.getTime()
    || campaign.reconfirmationRequestedAt?.getTime() !== requestedAt.getTime()
    || campaign.reconfirmationQuantity !== quantity || deadline <= new Date()) return;

  const recipientUserId = campaign.supplierAccount?.userId ?? campaign.supplier?.vendor.userId;
  if (!recipientUserId) return;
  const recipient = await tx.user.findUnique({ where: { id: recipientUserId }, select: { id: true, isSuspended: true } });
  if (!recipient || recipient.isSuspended) return;

  const dedupeKey = `R37_SUPPLIER_RECONFIRMATION:${campaign.id}:${requestedAt.toISOString()}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title: "Please confirm your Community Buy supply",
    body: "Review quantity and fulfilment terms.",
    data: {
      type: "supplier_reconfirmation_requested",
      audience: "supplier",
      ruleKey: rule.key,
      ruleVersion: rule.version,
      eventId: event.id,
      templateVersion: 1,
      destination: "community_buy_campaign",
      campaignId: campaign.id,
      quantity: Number(quantity),
      requestedAt: requestedAt.toISOString(),
      deadline: deadline.toISOString(),
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

/** R29: notify the current owner when a Stripe-confirmed Membership invoice is past due. */
export async function handleVendorMembershipPaymentFailed(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const payload = event.payload;
  const subscriptionId = requiredId(payload, "subscriptionId");
  const vendorId = requiredId(payload, "vendorId");
  const stripeEventId = requiredId(payload, "stripeEventId");
  const invoiceId = requiredId(payload, "invoiceId");
  const subscription = await tx.vendorSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, vendorId: true, status: true },
  });
  if (!subscription || subscription.vendorId !== vendorId || subscription.status !== "PAST_DUE") return;
  const vendor = await tx.vendor.findUnique({ where: { id: subscription.vendorId }, select: { userId: true } });
  if (!vendor) return;
  const recipient = await tx.user.findUnique({
    where: { id: vendor.userId },
    select: { id: true, role: true, isSuspended: true },
  });
  if (!recipient || recipient.role !== "VENDOR" || recipient.isSuspended) return;

  const dedupeKey = `R29_MEMBERSHIP_PAYMENT_FAILED:${stripeEventId}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "SUBSCRIPTION_UPDATE",
    title: "Your Eki Membership payment needs attention",
    body: "Update your billing details.",
    data: {
      type: "subscription_update",
      event: "vendor_subscription_payment_failed",
      ruleKey: rule.key,
      ruleVersion: rule.version,
      eventId: event.id,
      templateVersion: 1,
      destination: "membership",
      vendorSubscriptionId: subscription.id,
      invoiceId,
      stripeEventId,
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

/** R34: notify the organiser during the real below-minimum rescue window. */
export async function handleCommunityBuyBelowMinimum(tx: Prisma.TransactionClient, event: Event): Promise<void> {
  const rule = resolveNotificationRule(event);
  if (!rule?.enabled) return;
  const campaignId = requiredId(event.payload, "campaignId");
  const campaign = await tx.communityCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true, title: true, status: true, paymentMode: true, minimumShares: true, confirmedShares: true, rescueEndsAt: true, decisionRequiredAt: true, organiser: { select: { userId: true } } },
  });
  if (!campaign || campaign.minimumShares == null) return;
  const actualQuantity = campaign.paymentMode === "AUTHORISE_THEN_CAPTURE"
    ? (await tx.campaignContribution.findMany({
      where: { campaignId: campaign.id, paymentAuthorisation: { holdStatus: "HOLD_SUCCEEDED" } },
      select: { quantity: true },
    })).reduce((sum, contribution) => sum + contribution.quantity, 0)
    : campaign.confirmedShares;
  const deadline = campaign.status === "RESCUE_WINDOW" ? campaign.rescueEndsAt
    : campaign.status === "DECISION_REQUIRED" && campaign.decisionRequiredAt
      ? new Date(campaign.decisionRequiredAt.getTime() + COMMUNITY_BUY_ORGANISER_DECISION_WINDOW_MS)
      : null;
  if (!deadline || deadline <= new Date() || actualQuantity >= campaign.minimumShares) return;
  const recipient = await tx.user.findUnique({ where: { id: campaign.organiser.userId }, select: { id: true, role: true, isSuspended: true } });
  if (!recipient || recipient.role !== "BUYER" || recipient.isSuspended) return;
  const remaining = campaign.minimumShares - actualQuantity;
  const dedupeKey = `R34_COMMUNITY_BUY_BELOW_MINIMUM:${campaign.id}`;
  const created = await notificationsService.create({
    userId: recipient.id,
    type: "COMMUNITY_CAMPAIGN_UPDATE",
    title: `Your Community Buy needs ${remaining} shares`,
    body: `Review your available options before ${deadline.toISOString()}.`,
    data: {
      type: "community_campaign_update", event: "below_minimum", audience: "organiser",
      ruleKey: rule.key, ruleVersion: rule.version, eventId: event.id, templateVersion: 1,
      destination: "community_buy_campaign", campaignId: campaign.id, remainingShares: remaining,
      deadline: deadline.toISOString(),
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
  eventOutboxService.registerHandler(EVENT_NAMES.payment_succeeded, handleFirstPaidOrder);
  eventOutboxService.registerHandler(EVENT_NAMES.order_accepted, handleOrderConfirmed);
  eventOutboxService.registerHandler(EVENT_NAMES.order_dispatched, handleOrderDispatched);
  eventOutboxService.registerHandler(EVENT_NAMES.support_response_received, handleSupportResponseReceived);
  eventOutboxService.registerHandler(EVENT_NAMES.product_stock_depleted, handleProductStockDepleted);
  eventOutboxService.registerHandler(EVENT_NAMES.product_inventory_conflict_detected, handleProductInventoryConflictDetected);
  eventOutboxService.registerHandler(EVENT_NAMES.community_buy_minimum_reached, handleCommunityBuyMinimumReached);
  eventOutboxService.registerHandler(EVENT_NAMES.community_buy_payment_action_required, handleCommunityBuyPaymentActionRequired);
  eventOutboxService.registerHandler(EVENT_NAMES.community_buy_supplier_reconfirmation_requested, handleSupplierReconfirmationRequested);
  eventOutboxService.registerHandler(EVENT_NAMES.payout_action_required, handlePayoutActionRequired);
  eventOutboxService.registerHandler(EVENT_NAMES.vendor_membership_payment_failed, handleVendorMembershipPaymentFailed);
  eventOutboxService.registerHandler(EVENT_NAMES.community_buy_below_minimum, handleCommunityBuyBelowMinimum);
  eventOutboxService.registerHandler(EVENT_NAMES.payout_confirmed, handlePayoutConfirmed);
  registered = true;
}

