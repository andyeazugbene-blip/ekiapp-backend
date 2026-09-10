import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";
import { subscriptionOffersService } from "./subscription-offers.service";
import { buyerSubscriptionsService } from "./buyer-subscriptions.service";
import { buyerPaymentMethodsService } from "./payment-methods.service";
import { renewalsService } from "./renewals.service";

function requireUserId(request: Request): string {
  if (!request.user) throw new AppError("Unauthorized", 401);
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

async function requireVendorId(userId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  if (!vendor) throw new AppError("Vendor profile required", 403);
  return vendor.id;
}

// ─── Vendor: subscription offers ──────────────────────────────────────────

export async function createSubscriptionOffer(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const offer = await subscriptionOffersService.create(vendorId, request.body);
  response.status(201).json({ offer });
}

export async function listVendorSubscriptionOffers(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  response.json({ items: await subscriptionOffersService.listForVendor(vendorId) });
}

export async function updateSubscriptionOffer(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const offer = await subscriptionOffersService.update(vendorId, requireIdParam(request), request.body);
  response.json({ offer });
}

export async function publishSubscriptionOffer(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const offer = await subscriptionOffersService.publish(vendorId, requireIdParam(request));
  response.json({ offer });
}

export async function unpublishSubscriptionOffer(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const offer = await subscriptionOffersService.unpublish(vendorId, requireIdParam(request));
  response.json({ offer });
}

export async function pauseSubscriptionOfferRenewals(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendorId = await requireVendorId(userId);
  const offerId = requireIdParam(request);
  const offer = await subscriptionOffersService.pauseRenewals(vendorId, offerId);
  await recordAudit({ actorId: userId, action: "subscription_offer.pause_renewals", entityType: "SubscriptionOffer", entityId: offerId, request });
  response.json({ offer });
}

export async function resumeSubscriptionOfferRenewals(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendorId = await requireVendorId(userId);
  const offerId = requireIdParam(request);
  const offer = await subscriptionOffersService.resumeRenewals(vendorId, offerId);
  await recordAudit({ actorId: userId, action: "subscription_offer.resume_renewals", entityType: "SubscriptionOffer", entityId: offerId, request });
  response.json({ offer });
}

function requireProductIdParam(request: Request): string {
  const id = request.params.productId;
  if (typeof id !== "string" || id.length === 0) throw new AppError("Invalid productId", 400);
  return id;
}

export async function pauseSubscriptionOfferProduct(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendorId = await requireVendorId(userId);
  const offerId = requireIdParam(request);
  const productId = requireProductIdParam(request);
  const { reason, expectedReturnAt } = request.body ?? {};
  const link = await subscriptionOffersService.pauseProduct(
    vendorId,
    offerId,
    productId,
    typeof reason === "string" ? reason : undefined,
    typeof expectedReturnAt === "string" ? new Date(expectedReturnAt) : undefined,
  );
  await recordAudit({
    actorId: userId,
    action: "subscription_offer_product.pause",
    entityType: "SubscriptionOfferProduct",
    entityId: `${offerId}:${productId}`,
    metadata: { reason: typeof reason === "string" ? reason : null },
    request,
  });
  response.json({ product: link });
}

export async function resumeSubscriptionOfferProduct(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const vendorId = await requireVendorId(userId);
  const offerId = requireIdParam(request);
  const productId = requireProductIdParam(request);
  const link = await subscriptionOffersService.resumeProduct(vendorId, offerId, productId);
  await recordAudit({ actorId: userId, action: "subscription_offer_product.resume", entityType: "SubscriptionOfferProduct", entityId: `${offerId}:${productId}`, request });
  response.json({ product: link });
}

export async function getPublicSubscriptionOffer(request: Request, response: Response): Promise<void> {
  const offer = await subscriptionOffersService.getPublic(requireIdParam(request));
  response.json({ offer });
}

/** GET /subscription-offers/public — real discovery, no purchase/deep-link/subscription required. */
export async function listPublicSubscriptionOffers(request: Request, response: Response): Promise<void> {
  const country = typeof request.query.country === "string" ? request.query.country : undefined;
  const vendorId = typeof request.query.vendorId === "string" ? request.query.vendorId : undefined;
  const items = await subscriptionOffersService.listPublic({ country, vendorId });
  response.json({ items });
}

// ─── Vendor: subscribers & renewals ───────────────────────────────────────

export async function listVendorSubscribers(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const offers = await prisma.subscriptionOffer.findMany({ where: { vendorId }, select: { id: true } });
  const offerIds = offers.map((o) => o.id);
  const items = await prisma.buyerSubscription.findMany({
    where: { offerId: { in: offerIds } },
    include: { buyer: { select: { name: true, email: true } }, items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
  });
  response.json({ items });
}

export async function listVendorRenewals(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const offers = await prisma.subscriptionOffer.findMany({ where: { vendorId }, select: { id: true } });
  const offerIds = offers.map((o) => o.id);
  const items = await prisma.renewal.findMany({
    where: { subscription: { offerId: { in: offerIds } } },
    include: { items: { include: { product: true } }, subscription: { include: { buyer: { select: { name: true } } } } },
    orderBy: { cycleDate: "desc" },
    take: 200,
  });
  response.json({ items });
}

export async function confirmRenewalStock(request: Request, response: Response): Promise<void> {
  const userId = requireUserId(request);
  const renewalId = requireIdParam(request);
  const renewal = await renewalsService.confirmStock(userId, renewalId);
  await recordAudit({
    actorId: userId,
    action: "renewal.stock_confirmed",
    entityType: "Renewal",
    entityId: renewalId,
    metadata: { newStatus: renewal?.status ?? null },
    request,
  });
  response.json({ renewal });
}

export async function getVendorSubscriberDetail(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const subscriptionId = requireIdParam(request);
  const subscription = await prisma.buyerSubscription.findUnique({
    where: { id: subscriptionId },
    include: {
      buyer: { select: { name: true, email: true } },
      offer: { select: { id: true, vendorId: true, title: true } },
      items: { include: { product: true } },
      deliveryAddress: true,
      renewals: {
        orderBy: { cycleDate: "desc" },
        take: 24,
        include: { items: { include: { product: true } } },
      },
    },
  });
  if (!subscription || subscription.offer.vendorId !== vendorId) {
    throw new AppError("Subscriber not found", 404);
  }
  response.json({ subscription });
}

/** Real, directly-observable Regular Delivery metrics for the vendor — no projections, no invented figures. */
export async function getVendorRegularDeliveryInsights(request: Request, response: Response): Promise<void> {
  const vendorId = await requireVendorId(requireUserId(request));
  const offers = await prisma.subscriptionOffer.findMany({ where: { vendorId }, select: { id: true } });
  const offerIds = offers.map((o) => o.id);

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const in7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [activeCount, pausedCount, cancelledLast30d, paidRenewalsLast30d, upcomingRenewalsCount] = await Promise.all([
    prisma.buyerSubscription.count({ where: { offerId: { in: offerIds }, status: "ACTIVE" } }),
    prisma.buyerSubscription.count({ where: { offerId: { in: offerIds }, status: "PAUSED" } }),
    prisma.buyerSubscription.count({ where: { offerId: { in: offerIds }, status: "CANCELLED", cancelledAt: { gte: since30d } } }),
    prisma.renewal.findMany({
      where: { subscription: { offerId: { in: offerIds } }, status: { in: ["PAID", "ORDER_CREATED"] }, updatedAt: { gte: since30d } },
      select: { subtotalAmount: true, currency: true },
    }),
    prisma.buyerSubscription.count({ where: { offerId: { in: offerIds }, status: "ACTIVE", nextRenewalAt: { lte: in7d } } }),
  ]);

  const revenueByCurrency = new Map<string, number>();
  for (const r of paidRenewalsLast30d) {
    revenueByCurrency.set(r.currency, (revenueByCurrency.get(r.currency) ?? 0) + (r.subtotalAmount ?? 0));
  }

  response.json({
    activeSubscribers: activeCount,
    pausedSubscribers: pausedCount,
    cancelledLast30Days: cancelledLast30d,
    paidRenewalsLast30Days: paidRenewalsLast30d.length,
    revenueLast30Days: [...revenueByCurrency.entries()].map(([currency, amount]) => ({ currency, amount })),
    upcomingRenewalsNext7Days: upcomingRenewalsCount,
  });
}

// ─── Buyer: payment methods ────────────────────────────────────────────────

export async function createSetupIntent(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json(await buyerPaymentMethodsService.createSetupIntent(buyerId));
}

export async function confirmSetupIntent(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  const setupIntentId = request.body?.setupIntentId;
  if (typeof setupIntentId !== "string") throw new AppError("setupIntentId is required", 400);
  response.status(201).json(await buyerPaymentMethodsService.confirmSetupIntent(buyerId, setupIntentId));
}

export async function listPaymentMethods(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json({ items: await buyerPaymentMethodsService.list(buyerId) });
}

export async function removePaymentMethod(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  await buyerPaymentMethodsService.remove(buyerId, requireIdParam(request));
  response.status(204).send();
}

// ─── Buyer: subscriptions ──────────────────────────────────────────────────

export async function createBuyerSubscription(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  const subscription = await buyerSubscriptionsService.create(buyerId, request.body);
  response.status(201).json({ subscription });
}

export async function listBuyerSubscriptions(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json({ items: await buyerSubscriptionsService.listForBuyer(buyerId) });
}

export async function getBuyerSubscription(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json({ subscription: await buyerSubscriptionsService.get(buyerId, requireIdParam(request)) });
}

export async function updateBuyerSubscription(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  if (!Array.isArray(request.body?.items)) throw new AppError("items is required", 400);
  response.json({ subscription: await buyerSubscriptionsService.updateItems(buyerId, requireIdParam(request), request.body.items) });
}

export async function pauseBuyerSubscription(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  const resumeAt = request.body?.resumeAt ? new Date(request.body.resumeAt) : undefined;
  response.json({ subscription: await buyerSubscriptionsService.pause(buyerId, requireIdParam(request), resumeAt) });
}

export async function resumeBuyerSubscription(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json({ subscription: await buyerSubscriptionsService.resume(buyerId, requireIdParam(request)) });
}

export async function cancelBuyerSubscription(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json({ subscription: await buyerSubscriptionsService.cancel(buyerId, requireIdParam(request)) });
}

export async function skipNextRenewal(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json({ subscription: await buyerSubscriptionsService.skipNext(buyerId, requireIdParam(request)) });
}

export async function getReorderSuggestions(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  response.json({ items: await buyerSubscriptionsService.getReorderSuggestions(buyerId) });
}

export async function decideRenewalPriceChange(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  const decision = request.body?.decision;
  if (decision !== "accepted" && decision !== "declined") throw new AppError("decision must be accepted or declined", 400);
  const renewal = await renewalsService.buyerDecidePriceChange(buyerId, requireIdParam(request), decision);
  response.json({ renewal });
}

export async function retryRenewalPayment(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  const renewal = await renewalsService.retryPayment(buyerId, requireIdParam(request));
  response.json({ renewal });
}

// ─── Buyer: frequency editing (Final Client Decision 3) ────────────────────

export async function changeBuyerSubscriptionFrequency(request: Request, response: Response): Promise<void> {
  const buyerId = requireUserId(request);
  const id = requireIdParam(request);
  const { frequency } = request.body ?? {};
  if (typeof frequency !== "string") throw new AppError("frequency is required", 400);
  const subscription = await buyerSubscriptionsService.changeFrequency(buyerId, id, frequency as any);
  response.json({ subscription });
}

// ─── Admin ─────────────────────────────────────────────────────────────────

/** RD-08 (retry-payment slice only) — see renewalsService.adminRetryPayment() for scope notes. */
export async function adminRetryRenewalPayment(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const renewalId = requireIdParam(request);
  const before = await prisma.renewal.findUnique({ where: { id: renewalId }, select: { status: true, failureReason: true } });
  const renewal = await renewalsService.adminRetryPayment(renewalId);
  await recordAudit({
    actorId: adminId,
    action: "renewal.admin_retry_payment",
    entityType: "Renewal",
    entityId: renewalId,
    beforeState: before ? { status: before.status, failureReason: before.failureReason } : undefined,
    afterState: renewal ? { status: renewal.status } : undefined,
    request,
  });
  response.json({ renewal });
}

/**
 * Admin forced cancellation of a Regular Delivery subscription (Final Client Decision 2).
 * Exceptional action only: support, fraud, compliance, safety.
 * Cancels ONLY future unpaid renewals. Never touches paid/dispatched orders.
 */
export async function adminForceCancelSubscription(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const subscriptionId = requireIdParam(request);
  const { reason, internalNote } = request.body ?? {};
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  if (typeof internalNote !== "string" || !internalNote.trim()) throw new AppError("internalNote is required", 400);
  const result = await renewalsService.adminForceCancel(adminId, subscriptionId, reason, internalNote);
  response.json(result);
}

/**
 * Admin contact buyer from a subscription context (Final Client Decision 2).
 * Uses the existing Eki notification infrastructure — does NOT expose card
 * details, payment credentials, or private secrets. Records: message,
 * administrator, date/time, subscription, delivery status.
 */
export async function adminContactBuyerFromSubscription(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const subscriptionId = requireIdParam(request);
  const { message } = request.body ?? {};
  if (typeof message !== "string" || !message.trim()) throw new AppError("message is required", 400);

  const sub = await prisma.buyerSubscription.findUnique({
    where: { id: subscriptionId },
    select: { buyerId: true, buyer: { select: { id: true } } },
  });
  if (!sub) throw new AppError("Subscription not found", 404);

  const notif = await prisma.notification.create({
    data: {
      userId: sub.buyerId,
      type: "SUBSCRIPTION_UPDATE",
      title: "Message from Eki support",
      body: message.trim(),
      data: {
        type: "admin_contact",
        context: "subscription",
        subscriptionId,
        sentByAdminId: adminId,
      },
    },
  });

  await recordAudit({
    actorId: adminId,
    action: "subscription.admin_contact_buyer",
    entityType: "BuyerSubscription",
    entityId: subscriptionId,
    afterState: { message: message.trim(), notificationId: notif.id },
    request,
  });

  response.json({ notificationId: notif.id });
}

/**
 * Admin contact buyer from a renewal context (Final Client Decision 2).
 */
export async function adminContactBuyerFromRenewal(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const renewalId = requireIdParam(request);
  const { message } = request.body ?? {};
  if (typeof message !== "string" || !message.trim()) throw new AppError("message is required", 400);

  const renewal = await prisma.renewal.findUnique({
    where: { id: renewalId },
    include: { subscription: { select: { buyerId: true, id: true } } },
  });
  if (!renewal) throw new AppError("Renewal not found", 404);

  const notif = await prisma.notification.create({
    data: {
      userId: renewal.subscription.buyerId,
      type: "SUBSCRIPTION_UPDATE",
      title: "Message from Eki support",
      body: message.trim(),
      data: {
        type: "admin_contact",
        context: "renewal",
        subscriptionId: renewal.subscription.id,
        renewalId,
        sentByAdminId: adminId,
      },
    },
  });

  await recordAudit({
    actorId: adminId,
    action: "renewal.admin_contact_buyer",
    entityType: "Renewal",
    entityId: renewalId,
    afterState: { message: message.trim(), notificationId: notif.id },
    request,
  });

  response.json({ notificationId: notif.id });
}

/** Admin resend price-change approval notification — Decision 2. */
export async function adminResendPriceChangeNotification(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  await renewalsService.adminResendPriceChangeNotification(adminId, requireIdParam(request));
  response.status(204).send();
}

/** Admin cancel an invalid vendor price-change request — Decision 2. */
export async function adminCancelInvalidPriceChange(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const { reason } = request.body ?? {};
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const renewal = await renewalsService.adminCancelInvalidPriceChange(adminId, requireIdParam(request), reason);
  response.json({ renewal });
}

/** Admin skip a renewal where policy permits — Decision 2. */
export async function adminSkipRenewal(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const { reason } = request.body ?? {};
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required", 400);
  const renewal = await renewalsService.adminSkipRenewal(adminId, requireIdParam(request), reason);
  response.json({ renewal });
}

/**
 * Admin frequency correction — Final Client Decision 3.
 * Support action only — must have been requested/authorized by buyer.
 */
export async function adminChangeSubscriptionFrequency(request: Request, response: Response): Promise<void> {
  const adminId = requireUserId(request);
  const subscriptionId = requireIdParam(request);
  const { frequency, reason } = request.body ?? {};
  if (typeof frequency !== "string") throw new AppError("frequency is required", 400);
  if (typeof reason !== "string" || !reason.trim()) throw new AppError("reason is required — admin frequency changes must have a stated reason", 400);
  const result = await buyerSubscriptionsService.adminChangeFrequency(adminId, subscriptionId, frequency as any, reason);
  response.json(result);
}

export async function adminListSubscriptionExceptions(_request: Request, response: Response): Promise<void> {
  const items = await prisma.renewal.findMany({
    where: { status: { in: ["AWAITING_PRICE_APPROVAL", "PAYMENT_FAILED", "AWAITING_STOCK"] } },
    include: {
      subscription: { include: { buyer: { select: { name: true, email: true } } } },
      items: { include: { product: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  response.json({ items });
}

