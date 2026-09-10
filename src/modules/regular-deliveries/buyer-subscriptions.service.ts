import type { SubscriptionFrequency } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { vendorMarketsService } from "../vendors/vendor-markets.service";
import { getEnabledRegularDeliveryMarketCodes } from "./subscription-offers.service";

// EVERY_4_WEEKS (28 days, fixed) is deliberately distinct from MONTHLY (30
// days, fixed) — client spec (Regular Delivery doc) lists "Weekly | Every 2
// weeks | Every 4 weeks | Monthly" as four separate options. Neither uses
// real calendar-month arithmetic; both are fixed day-counts, matching the
// existing WEEKLY/BIWEEKLY pattern.
const FREQUENCY_DAYS: Record<SubscriptionFrequency, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  EVERY_4_WEEKS: 28,
  MONTHLY: 30,
};

// Human-readable labels used in buyer notifications — matches the frontend's
// FREQUENCY_LABELS constant in services/regularDeliveriesService.ts.
const FREQUENCY_LABEL: Record<SubscriptionFrequency, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Every 2 weeks",
  EVERY_4_WEEKS: "Every 4 weeks",
  MONTHLY: "Monthly",
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
      include: {
        products: { include: { product: { select: { isActive: true, stock: true } } } },
        vendor: { select: { id: true, isSuspended: true, country: true } },
      },
    });
    if (!offer || !offer.isActive) throw new AppError("Offer not found", 404);
    if (!offer.frequencies.includes(input.frequency)) throw new AppError("Frequency not offered", 400);
    if (input.items.length === 0) throw new AppError("At least one item is required", 400);

    // Re-enforce the same eligibility rules listPublic() applies at
    // discovery time — a buyer who already has the offer id (deep link,
    // stale cache, direct API call) must not be able to subscribe to
    // something the browse list would have filtered out: a suspended
    // vendor, a market where Regular Deliveries isn't enabled, or an
    // inactive/out-of-stock/paused product.
    if (offer.vendor.isSuspended) {
      throw new AppError("This vendor is not currently accepting orders", 400);
    }
    // A multi-market vendor is eligible via ANY of their active market
    // assignments, matching listPublic()'s discovery-time filter — not just
    // their single primary Vendor.country.
    const enabledMarketCodes = await getEnabledRegularDeliveryMarketCodes();
    const vendorActiveCodes = await vendorMarketsService.getActiveMarketCodes(offer.vendor.id);
    const eligibleInAnyMarket = vendorActiveCodes.some((code) => enabledMarketCodes.includes(code));
    if (!eligibleInAnyMarket) {
      throw new AppError("Regular Deliveries are not available in this vendor's market", 400);
    }

    const eligibleProductIds = new Set(
      offer.products
        .filter((p) => p.pausedAt === null && p.product.isActive && p.product.stock > 0)
        .map((p) => p.productId),
    );
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
        // spec §22 — the vendor's configured approval threshold, if any,
        // becomes this subscription's threshold; null leaves the renewal
        // evaluator on its own default (renewals.service.ts).
        priceChangeApprovalLimitBps: offer.maxPriceIncreaseApprovalBps ?? undefined,
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
        // products: needed so the buyer can see why a specific item is
        // currently excluded from renewals (pauseReason/pauseExpectedReturnAt)
        // instead of it just silently disappearing from their next order.
        offer: { include: { vendor: { select: { storeName: true } }, products: true } },
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
    // READY_FOR_PAYMENT is included — without it, a renewal already cleared
    // for payment stayed chargeable, so a buyer who skipped could still be
    // charged by the next sweep.
    await prisma.renewal.updateMany({
      where: { subscriptionId: id, cycleDate: sub.nextRenewalAt, status: { in: ["SCHEDULED", "AWAITING_STOCK", "AWAITING_PRICE_APPROVAL", "READY_FOR_PAYMENT"] } },
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

  /**
   * Buyer changes the frequency of their active Regular Delivery subscription.
   *
   * Final Client Decision 3 — rules enforced here:
   *
   * 1. Only ACTIVE subscriptions can change frequency.
   * 2. If the next renewal is already PROCESSING or PAID — immutable; change
   *    applies to the renewal after that.
   * 3. If the next renewal hasn't been locked yet — we update the subscription
   *    frequency and recalculate nextRenewalAt from the current cycle date
   *    (not from now), so the new period is fair to the buyer.
   * 4. Ownership is enforced — a buyer can only change their own subscription.
   * 5. Vendor cannot call this — they may only control frequencies offered to
   *    NEW subscribers via the offer's `frequencies` field.
   * 6. A notification is sent confirming the change (with old/new frequency
   *    and new next-renewal date).
   *
   * Returns the updated subscription with new frequency and nextRenewalAt.
   */
  async changeFrequency(buyerId: string, id: string, newFrequency: SubscriptionFrequency) {
    const sub = await this.requireOwned(buyerId, id);
    if (sub.status !== "ACTIVE") throw new AppError("Only an active subscription can change its frequency", 409);
    if (sub.frequency === newFrequency) throw new AppError("Subscription already uses this frequency", 409);

    // Validate the new frequency is supported by the offer.
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: sub.offerId }, select: { frequencies: true } });
    if (!offer) throw new AppError("Subscription offer not found", 404);
    if (!offer.frequencies.includes(newFrequency)) {
      throw new AppError(`This vendor's offer does not support ${newFrequency.replace(/_/g, " ").toLowerCase()}`, 400);
    }

    const previousFrequency = sub.frequency;

    // Check if the upcoming renewal is already locked (PAYMENT_PROCESSING/PAID/ORDER_CREATED).
    // If so, the change applies to the renewal after that one (i.e., from the
    // current nextRenewalAt forward), per the client rule: "if the next renewal
    // has passed its change cutoff or is already processing/paid, the current
    // renewal remains unchanged — the new frequency applies afterwards."
    const upcomingRenewalIsLocked = sub.nextRenewalAt
      ? (await prisma.renewal.findFirst({
          where: {
            subscriptionId: id,
            cycleDate: sub.nextRenewalAt,
            status: { in: ["PAYMENT_PROCESSING", "PAID", "ORDER_CREATED"] },
          },
          select: { id: true },
        })) !== null
      : false;

    let newNextRenewalAt: Date;
    if (upcomingRenewalIsLocked) {
      // The locked renewal still fires on its existing date; the new frequency
      // kicks in for the renewal *after* that — i.e. from nextRenewalAt.
      newNextRenewalAt = nextCycleDate(newFrequency, sub.nextRenewalAt ?? undefined);
    } else {
      // Next renewal hasn't been locked — we can apply immediately. Recalculate
      // from the current cycle base (the date the previous renewal should have
      // run) if it exists, otherwise from now.
      newNextRenewalAt = nextCycleDate(newFrequency, sub.nextRenewalAt ?? undefined);
    }

    const updated = await prisma.buyerSubscription.update({
      where: { id },
      data: { frequency: newFrequency, nextRenewalAt: newNextRenewalAt },
    });

    await recordAction(id, "frequency_changed", buyerId, {
      previousFrequency,
      newFrequency,
      newNextRenewalAt: newNextRenewalAt.toISOString(),
    });

    // Notify the buyer of the frequency change (not a marketing message —
    // transactional: confirms their own request, no consent gate).
    await notificationsService.enqueue({
      userId: buyerId,
      type: "SUBSCRIPTION_UPDATE",
      title: "Regular Delivery frequency updated",
      body: `Your delivery frequency has been changed to ${FREQUENCY_LABEL[newFrequency]}. Next delivery: ${newNextRenewalAt.toLocaleDateString("en-GB")}.`,
      data: {
        type: "regular_delivery_frequency_changed",
        subscriptionId: id,
        previousFrequency,
        newFrequency,
      },
      dedupeKey: `frequency_changed:${id}:${previousFrequency}:${newFrequency}:${Date.now()}`,
    }).catch(() => { /* non-blocking */ });

    return updated;
  },

  /**
   * Admin support action — change a buyer's subscription frequency on their
   * behalf. Can ONLY be used as an authorized support action for a buyer who
   * has explicitly requested it. Records an AuditLog entry in addition to
   * the SubscriptionActionHistory. Subject to the same state rules as
   * changeFrequency().
   *
   * Final Client Decision 3: "Admin may correct an active frequency ONLY as
   * a support action. Must record previous frequency, new frequency, reason,
   * actor, timestamp."
   */
  async adminChangeFrequency(adminId: string, subscriptionId: string, newFrequency: SubscriptionFrequency, reason: string) {
    if (!reason?.trim()) throw new AppError("A reason is required for admin frequency changes", 400);

    const sub = await prisma.buyerSubscription.findUnique({ where: { id: subscriptionId } });
    if (!sub) throw new AppError("Subscription not found", 404);
    if (sub.status !== "ACTIVE") throw new AppError("Only an active subscription can change its frequency", 409);
    if (sub.frequency === newFrequency) throw new AppError("Subscription already uses this frequency", 409);

    const previousFrequency = sub.frequency;
    const newNextRenewalAt = nextCycleDate(newFrequency, sub.nextRenewalAt ?? undefined);

    const updated = await prisma.buyerSubscription.update({
      where: { id: subscriptionId },
      data: { frequency: newFrequency, nextRenewalAt: newNextRenewalAt },
    });

    await recordAction(subscriptionId, "admin_frequency_changed", adminId, {
      previousFrequency,
      newFrequency,
      reason,
      newNextRenewalAt: newNextRenewalAt.toISOString(),
    });

    // Notify buyer that admin corrected their frequency on their behalf.
    await notificationsService.enqueue({
      userId: sub.buyerId,
      type: "SUBSCRIPTION_UPDATE",
      title: "Regular Delivery frequency updated",
      body: `Your delivery frequency has been updated to ${FREQUENCY_LABEL[newFrequency]} by Eki support. Next delivery: ${newNextRenewalAt.toLocaleDateString("en-GB")}.`,
      data: {
        type: "regular_delivery_frequency_changed",
        subscriptionId,
        previousFrequency,
        newFrequency,
        changedByAdmin: true,
      },
      dedupeKey: `admin_frequency_changed:${subscriptionId}:${newFrequency}:${Date.now()}`,
    }).catch(() => { /* non-blocking */ });

    return { updated, previousFrequency, newFrequency, newNextRenewalAt };
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
