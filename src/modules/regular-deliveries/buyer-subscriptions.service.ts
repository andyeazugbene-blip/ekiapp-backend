import type { SubscriptionFrequency } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const FREQUENCY_DAYS: Record<SubscriptionFrequency, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 30,
};

export function nextCycleDate(frequency: SubscriptionFrequency, from: Date = new Date()): Date {
  const next = new Date(from);
  next.setUTCDate(next.getUTCDate() + FREQUENCY_DAYS[frequency]);
  return next;
}

async function recordAction(subscriptionId: string, action: string, actorUserId?: string, metadata?: Record<string, unknown>) {
  await prisma.subscriptionActionHistory.create({
    data: { subscriptionId, action, actorUserId, metadata: metadata as any },
  });
}

export interface CreateBuyerSubscriptionInput {
  offerId: string;
  frequency: SubscriptionFrequency;
  deliveryAddressId: string;
  paymentMethodId: string;
  items: { productId: string; quantity: number }[];
}

export const buyerSubscriptionsService = {
  async create(buyerId: string, input: CreateBuyerSubscriptionInput) {
    const offer = await prisma.subscriptionOffer.findUnique({
      where: { id: input.offerId },
      include: { products: true },
    });
    if (!offer || !offer.isActive) throw new AppError("Offer not found", 404);
    if (!offer.frequencies.includes(input.frequency)) throw new AppError("Frequency not offered", 400);
    if (input.items.length === 0) throw new AppError("At least one item is required", 400);

    const eligibleProductIds = new Set(offer.products.map((p) => p.productId));
    for (const item of input.items) {
      if (!eligibleProductIds.has(item.productId)) throw new AppError("Product not eligible for this offer", 400);
      if (item.quantity < 1) throw new AppError("Quantity must be at least 1", 400);
    }

    const address = await prisma.buyerAddress.findUnique({ where: { id: input.deliveryAddressId } });
    if (!address || address.buyerId !== buyerId) throw new AppError("Delivery address not found", 404);

    const paymentMethod = await prisma.buyerPaymentMethod.findUnique({ where: { id: input.paymentMethodId } });
    if (!paymentMethod || paymentMethod.buyerId !== buyerId) throw new AppError("Payment method not found", 404);

    const subscription = await prisma.buyerSubscription.create({
      data: {
        buyerId,
        offerId: input.offerId,
        status: "ACTIVE",
        frequency: input.frequency,
        deliveryAddressId: input.deliveryAddressId,
        paymentMethodId: input.paymentMethodId,
        nextRenewalAt: nextCycleDate(input.frequency),
        items: { create: input.items },
      },
      include: { items: { include: { product: true } }, offer: true },
    });
    await recordAction(subscription.id, "created", buyerId);
    return subscription;
  },

  async listForBuyer(buyerId: string) {
    return prisma.buyerSubscription.findMany({
      where: { buyerId },
      include: { items: { include: { product: true } }, offer: { include: { vendor: { select: { storeName: true } } } } },
      orderBy: { createdAt: "desc" },
    });
  },

  async get(buyerId: string, id: string) {
    const sub = await prisma.buyerSubscription.findUnique({
      where: { id },
      include: {
        items: { include: { product: true } },
        offer: { include: { vendor: { select: { storeName: true } } } },
        renewals: { orderBy: { cycleDate: "desc" }, take: 12 },
      },
    });
    if (!sub || sub.buyerId !== buyerId) throw new AppError("Subscription not found", 404);
    return sub;
  },

  async requireOwned(buyerId: string, id: string) {
    const sub = await prisma.buyerSubscription.findUnique({ where: { id } });
    if (!sub || sub.buyerId !== buyerId) throw new AppError("Subscription not found", 404);
    return sub;
  },

  async pause(buyerId: string, id: string, resumeAt?: Date) {
    const sub = await this.requireOwned(buyerId, id);
    if (sub.status !== "ACTIVE") throw new AppError("Only an active subscription can be paused", 409);
    const updated = await prisma.buyerSubscription.update({
      where: { id },
      data: { status: "PAUSED", pausedUntil: resumeAt ?? null },
    });
    await recordAction(id, "paused", buyerId, { resumeAt });
    return updated;
  },

  async resume(buyerId: string, id: string) {
    const sub = await this.requireOwned(buyerId, id);
    if (sub.status !== "PAUSED") throw new AppError("Only a paused subscription can be resumed", 409);
    const updated = await prisma.buyerSubscription.update({
      where: { id },
      data: { status: "ACTIVE", pausedUntil: null, nextRenewalAt: nextCycleDate(sub.frequency) },
    });
    await recordAction(id, "resumed", buyerId);
    return updated;
  },

  async skipNext(buyerId: string, id: string) {
    const sub = await this.requireOwned(buyerId, id);
    if (sub.status !== "ACTIVE") throw new AppError("Only an active subscription can skip its next renewal", 409);
    if (!sub.nextRenewalAt) throw new AppError("No upcoming renewal to skip", 409);

    // If a renewal already exists for that cycle (scheduler ran first), mark
    // it skipped instead of silently leaving an orphaned scheduled renewal.
    await prisma.renewal.updateMany({
      where: { subscriptionId: id, cycleDate: sub.nextRenewalAt, status: { in: ["SCHEDULED", "AWAITING_STOCK", "AWAITING_PRICE_APPROVAL"] } },
      data: { status: "SKIPPED" },
    });

    const updated = await prisma.buyerSubscription.update({
      where: { id },
      data: { nextRenewalAt: nextCycleDate(sub.frequency, sub.nextRenewalAt) },
    });
    await recordAction(id, "skipped_next", buyerId);
    return updated;
  },

  async cancel(buyerId: string, id: string) {
    const sub = await this.requireOwned(buyerId, id);
    if (sub.status === "CANCELLED") throw new AppError("Already cancelled", 409);

    // Cancels future unpaid renewals only — never touches a renewal that
    // already produced a real order (spec §6.7).
    await prisma.renewal.updateMany({
      where: { subscriptionId: id, status: { in: ["SCHEDULED", "AWAITING_STOCK", "AWAITING_PRICE_APPROVAL", "READY_FOR_PAYMENT"] } },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    const updated = await prisma.buyerSubscription.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), nextRenewalAt: null },
    });
    await recordAction(id, "cancelled", buyerId);
    return updated;
  },

  async updateItems(buyerId: string, id: string, items: { productId: string; quantity: number }[]) {
    const sub = await this.requireOwned(buyerId, id);
    if (sub.status !== "ACTIVE" && sub.status !== "PAUSED") {
      throw new AppError("This subscription can no longer be edited", 409);
    }
    if (items.length === 0) throw new AppError("At least one item is required", 400);

    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: sub.offerId }, include: { products: true } });
    const eligible = new Set(offer?.products.map((p) => p.productId));
    for (const item of items) {
      if (!eligible.has(item.productId)) throw new AppError("Product not eligible for this offer", 400);
    }

    await prisma.subscriptionItem.deleteMany({ where: { subscriptionId: id } });
    await prisma.subscriptionItem.createMany({ data: items.map((i) => ({ subscriptionId: id, ...i })) });
    await recordAction(id, "edited", buyerId, { items });
    return this.get(buyerId, id);
  },

  /**
   * Real, purchase-history-driven suggestions — products a buyer has
   * actually bought at least twice in the last 90 days, that they aren't
   * already subscribed to, and that a vendor has actually made available
   * as a Regular Delivery offer. No invented "AI recommendation" logic —
   * just a count over the buyer's own completed orders.
   */
  async getReorderSuggestions(buyerId: string, limit = 10) {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const purchasedItems = await prisma.orderItem.findMany({
      where: { order: { buyerId, status: { in: ["DELIVERED", "COMPLETED", "AUTO_RELEASED"] }, createdAt: { gte: since } } },
      select: { productId: true },
    });
    if (purchasedItems.length === 0) return [];

    const countByProduct = new Map<string, number>();
    for (const item of purchasedItems) countByProduct.set(item.productId, (countByProduct.get(item.productId) ?? 0) + 1);
    const repeatedProductIds = [...countByProduct.entries()].filter(([, count]) => count >= 2).map(([id]) => id);
    if (repeatedProductIds.length === 0) return [];

    const activeSubs = await prisma.buyerSubscription.findMany({
      where: { buyerId, status: "ACTIVE" },
      select: { items: { select: { productId: true } } },
    });
    const alreadySubscribed = new Set(activeSubs.flatMap((s) => s.items.map((i) => i.productId)));
    const candidateProductIds = repeatedProductIds.filter((id) => !alreadySubscribed.has(id));
    if (candidateProductIds.length === 0) return [];

    const offerProducts = await prisma.subscriptionOfferProduct.findMany({
      where: { productId: { in: candidateProductIds }, offer: { isActive: true, renewalsPaused: false } },
      include: {
        product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true } },
        offer: { select: { id: true, title: true, frequencies: true, vendor: { select: { storeName: true } } } },
      },
    });

    return offerProducts.slice(0, limit).map((op) => ({
      product: op.product,
      offer: { id: op.offer.id, title: op.offer.title, frequencies: op.offer.frequencies, vendorStoreName: op.offer.vendor.storeName },
      orderCount: countByProduct.get(op.productId) ?? 0,
    }));
  },
};
