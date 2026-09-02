import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
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

export async function getPublicSubscriptionOffer(request: Request, response: Response): Promise<void> {
  const offer = await subscriptionOffersService.getPublic(requireIdParam(request));
  response.json({ offer });
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
  const renewal = await renewalsService.confirmStock(userId, requireIdParam(request));
  response.json({ renewal });
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

// ─── Admin ─────────────────────────────────────────────────────────────────

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
