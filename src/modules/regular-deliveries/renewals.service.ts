import type Stripe from "stripe";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { calculatePlatformFee } from "../../shared/pricing";
import { resolveStripeCurrency } from "../../shared/currency";
import { resolveVendorCommission } from "../subscriptions/subscription-plan-utils";
import { notificationsService } from "../notifications/notifications.service";
import { automationService } from "../automation/automation.service";
import { nextCycleDate } from "./buyer-subscriptions.service";

const MAX_PAYMENT_ATTEMPTS = 3;
const PRICE_CHANGE_APPROVAL_DEFAULT_BPS = 500; // 5%

/**
 * Regular Deliveries renewal engine. Reuses the same Stripe account as the
 * rest of the app; charges are off-session (the buyer isn't present),
 * confirmed synchronously and read directly off the returned PaymentIntent
 * — never inferred from a client redirect. See spec §6.4–§6.6.
 */
export const renewalsService = {
  /**
   * Scheduler entry point. One renewal per subscription per cycle date —
   * enforced by the DB unique constraint (subscriptionId, cycleDate), not
   * just application logic, so a job running twice can never double-book.
   */
  async generateDueRenewals(): Promise<{ created: number; skipped: number }> {
    const now = new Date();
    const due = await prisma.buyerSubscription.findMany({
      where: { status: "ACTIVE", nextRenewalAt: { lte: now } },
      include: { items: { include: { product: true } } },
    });

    let created = 0;
    let skipped = 0;
    for (const sub of due) {
      if (!sub.nextRenewalAt) continue;
      try {
        await this.createRenewalForCycle(sub.id, sub.nextRenewalAt);
        created++;
      } catch (error: any) {
        if (error?.code === "P2002") {
          skipped++; // Already exists for this cycle — another run got there first.
        } else {
          logger.error("Renewal generation failed", { subscriptionId: sub.id, error: String(error) });
        }
      }
    }
    return { created, skipped };
  },

  async createRenewalForCycle(subscriptionId: string, cycleDate: Date) {
    const sub = await prisma.buyerSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: { items: { include: { product: true } } },
    });

    // Snapshot current prices. "Previous" price is the last renewal's price
    // for that product if one exists, otherwise the product's current price
    // (no change flagged on a buyer's very first renewal).
    const lastRenewalItems = await prisma.renewalItem.findMany({
      where: { renewal: { subscriptionId, status: { in: ["PAID", "ORDER_CREATED"] } } },
      orderBy: { createdAt: "desc" },
    });
    const lastPriceByProduct = new Map<string, number>();
    for (const item of lastRenewalItems) {
      if (!lastPriceByProduct.has(item.productId)) lastPriceByProduct.set(item.productId, item.currentUnitPrice);
    }

    const renewal = await prisma.renewal.create({
      data: {
        subscriptionId,
        cycleDate,
        status: "SCHEDULED",
        currency: sub.items[0]?.product.currency ?? "GBP",
        items: {
          create: sub.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            previousUnitPrice: lastPriceByProduct.get(item.productId) ?? item.product.priceInCents,
            currentUnitPrice: item.product.priceInCents,
            currency: item.product.currency,
            stockAvailable: item.product.isActive && item.product.stock >= item.quantity,
          })),
        },
      },
      include: { items: true },
    });

    await this.advanceAfterStockSnapshot(renewal.id);
    return renewal;
  },

  /**
   * Moves a freshly-created renewal to AWAITING_STOCK. The vendor still
   * confirms explicitly even when every item already looks in stock — the
   * "Vendor confirms stock" step from spec §6.4 is a deliberate sign-off,
   * not an automated pass-through.
   */
  async advanceAfterStockSnapshot(renewalId: string) {
    await prisma.renewal.update({ where: { id: renewalId }, data: { status: "AWAITING_STOCK" } });
  },

  async confirmStock(vendorUserId: string, renewalId: string) {
    const vendor = await prisma.vendor.findUnique({ where: { userId: vendorUserId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor profile required", 403);

    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      include: { items: { include: { product: true } }, subscription: true },
    });
    if (!renewal) throw new AppError("Renewal not found", 404);
    const offer = await prisma.subscriptionOffer.findUnique({ where: { id: renewal.subscription.offerId }, select: { vendorId: true } });
    if (offer?.vendorId !== vendor.id) throw new AppError("Forbidden", 403);
    if (renewal.status !== "AWAITING_STOCK") throw new AppError("Renewal is not awaiting stock confirmation", 409);

    // Re-check real-time stock at confirmation time, not just at snapshot time.
    for (const item of renewal.items) {
      const stillAvailable = item.product.isActive && item.product.stock >= item.quantity;
      if (stillAvailable !== item.stockAvailable) {
        await prisma.renewalItem.update({ where: { id: item.id }, data: { stockAvailable: stillAvailable } });
      }
    }
    const refreshed = await prisma.renewalItem.findMany({ where: { renewalId } });
    if (refreshed.some((i) => !i.stockAvailable)) {
      throw new AppError("Some items are still out of stock — update stock before confirming", 409);
    }

    await prisma.renewal.update({ where: { id: renewalId }, data: { stockConfirmedAt: new Date(), stockConfirmedById: vendorUserId } });
    await this.evaluatePriceChange(renewalId);
    return prisma.renewal.findUnique({ where: { id: renewalId }, include: { items: true } });
  },

  /** spec §6.6 — a material price increase (above the buyer's approval limit) pauses the renewal for buyer approval. */
  async evaluatePriceChange(renewalId: string) {
    const renewal = await prisma.renewal.findUniqueOrThrow({
      where: { id: renewalId },
      include: { items: true, subscription: true },
    });
    const limitBps = renewal.subscription.priceChangeApprovalLimitBps ?? PRICE_CHANGE_APPROVAL_DEFAULT_BPS;

    let worstItem: (typeof renewal.items)[number] | null = null;
    let worstPct = 0;
    for (const item of renewal.items) {
      if (item.previousUnitPrice <= 0) continue;
      const pct = ((item.currentUnitPrice - item.previousUnitPrice) / item.previousUnitPrice) * 10000; // bps
      if (pct > worstPct) {
        worstPct = pct;
        worstItem = item;
      }
    }

    if (worstItem && worstPct > limitBps) {
      const request = await prisma.priceChangeRequest.create({
        data: {
          previousUnitPrice: worstItem.previousUnitPrice,
          proposedUnitPrice: worstItem.currentUnitPrice,
          percentageDifference: worstPct / 100,
          approvalLimitBps: limitBps,
          approvalRequired: true,
        },
      });
      await prisma.renewal.update({
        where: { id: renewalId },
        data: { status: "AWAITING_PRICE_APPROVAL", priceChangeRequestId: request.id },
      });
      await notifySubscriptionEvent(renewal.subscription.buyerId, "price_approval_required", renewalId);
      await automationService.scheduleAutomation({
        type: "PRICE_APPROVAL_REMINDER",
        recipientUserId: renewal.subscription.buyerId,
        subjectKey: renewalId,
        requiresMarketingConsent: false,
        title: "Price change needs your approval",
        body: "Review the price change on your upcoming Regular Delivery.",
      });
      return;
    }

    await prisma.renewal.update({ where: { id: renewalId }, data: { status: "READY_FOR_PAYMENT" } });
  },

  async buyerDecidePriceChange(buyerId: string, renewalId: string, decision: "accepted" | "declined") {
    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      include: { subscription: true, priceChangeRequest: true },
    });
    if (!renewal || renewal.subscription.buyerId !== buyerId) throw new AppError("Renewal not found", 404);
    if (renewal.status !== "AWAITING_PRICE_APPROVAL" || !renewal.priceChangeRequestId) {
      throw new AppError("This renewal is not awaiting price approval", 409);
    }

    await prisma.priceChangeRequest.update({
      where: { id: renewal.priceChangeRequestId },
      data: { buyerDecision: decision, decidedAt: new Date() },
    });

    if (decision === "accepted") {
      await prisma.renewal.update({ where: { id: renewalId }, data: { status: "READY_FOR_PAYMENT" } });
    } else {
      await prisma.renewal.update({ where: { id: renewalId }, data: { status: "SKIPPED" } });
      await prisma.buyerSubscription.update({
        where: { id: renewal.subscriptionId },
        data: { nextRenewalAt: nextCycleDate(renewal.subscription.frequency, renewal.cycleDate) },
      });
    }
    return prisma.renewal.findUnique({ where: { id: renewalId } });
  },

  /**
   * Idempotent charge attempt. Each attempt gets its own row + idempotency
   * key ("{renewalId}:{attemptNumber}") before Stripe is ever called, so a
   * crash mid-call can be safely retried without risking a double charge —
   * see spec §6.5.
   */
  async attemptPayment(renewalId: string) {
    const renewal = await prisma.renewal.findUniqueOrThrow({
      where: { id: renewalId },
      include: { items: true, subscription: { include: { paymentMethod: true } } },
    });
    if (renewal.status !== "READY_FOR_PAYMENT" && renewal.status !== "PAYMENT_FAILED") {
      throw new AppError("Renewal is not ready for payment", 409);
    }
    const paymentMethod = renewal.subscription.paymentMethod;
    if (!paymentMethod) throw new AppError("No saved payment method on this subscription", 409);

    const priorAttempts = await prisma.subscriptionPaymentAttempt.count({ where: { renewalId } });
    if (priorAttempts >= MAX_PAYMENT_ATTEMPTS) {
      await this.cancelAfterRetriesExhausted(renewalId);
      return prisma.renewal.findUnique({ where: { id: renewalId } });
    }
    const attemptNumber = priorAttempts + 1;
    const idempotencyKey = `${renewalId}:${attemptNumber}`;

    const subtotal = renewal.items.reduce((sum, i) => sum + i.currentUnitPrice * i.quantity, 0);

    const attempt = await prisma.subscriptionPaymentAttempt.create({
      data: { renewalId, attemptNumber, status: "PENDING", idempotencyKey },
    });
    await prisma.renewal.update({ where: { id: renewalId }, data: { status: "PAYMENT_PROCESSING", subtotalAmount: subtotal } });

    let intent: Stripe.PaymentIntent;
    try {
      // resolveStripeCurrency() falls back to EUR for currencies Stripe
      // doesn't support (e.g. GHS) without converting the amount, which
      // would silently charge the buyer's saved card in the wrong currency
      // for the same numeric amount. This runs unattended from the cron
      // sweep, so fail it the same way a real Stripe rejection would —
      // through the existing retry/exhaustion path — instead of ever
      // submitting a mismatched charge.
      if (resolveStripeCurrency(renewal.currency) !== renewal.currency.toLowerCase()) {
        throw new Error(`Card payments are not currently available in ${renewal.currency.toUpperCase()}.`);
      }

      intent = await stripe.paymentIntents.create(
        {
          amount: subtotal,
          currency: resolveStripeCurrency(renewal.currency),
          customer: paymentMethod.stripeCustomerId,
          payment_method: paymentMethod.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          metadata: { kind: "regular_delivery_renewal", renewalId, subscriptionId: renewal.subscriptionId },
        },
        { idempotencyKey },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.subscriptionPaymentAttempt.update({
        where: { id: attempt.id },
        data: { status: "FAILED", failureCode: (error as Stripe.StripeRawError)?.code, failureMessage: message },
      });
      return this.handlePaymentFailure(renewal.subscriptionId, renewalId, message);
    }

    if (intent.status === "succeeded") {
      await prisma.subscriptionPaymentAttempt.update({
        where: { id: attempt.id },
        data: { status: "SUCCEEDED", stripePaymentIntentId: intent.id },
      });
      return this.convertPaidRenewalToOrder(renewalId, intent.id);
    }

    // requires_action / processing / anything else — an off-session charge
    // with no buyer present can't complete extra authentication. Treat as
    // failed and let the controlled retry/recovery flow handle it.
    await prisma.subscriptionPaymentAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", stripePaymentIntentId: intent.id, failureCode: intent.status, failureMessage: "Payment requires additional authentication" },
    });
    return this.handlePaymentFailure(renewal.subscriptionId, renewalId, `Unexpected status: ${intent.status}`);
  },

  async handlePaymentFailure(subscriptionId: string, renewalId: string, reason: string) {
    await prisma.renewal.update({ where: { id: renewalId }, data: { status: "PAYMENT_FAILED", failureReason: reason } });
    const sub = await prisma.buyerSubscription.update({
      where: { id: subscriptionId },
      data: { status: "PAYMENT_ATTENTION" },
    });
    await notifySubscriptionEvent(sub.buyerId, "payment_failed", renewalId);
    await automationService.scheduleAutomation({
      type: "PAYMENT_RECOVERY",
      recipientUserId: sub.buyerId,
      subjectKey: `renewal:${renewalId}`,
      requiresMarketingConsent: false,
      title: "Your Regular Delivery payment didn't go through",
      body: "Retry now to keep your subscription active.",
    });
    return prisma.renewal.findUnique({ where: { id: renewalId } });
  },

  async cancelAfterRetriesExhausted(renewalId: string) {
    const renewal = await prisma.renewal.update({ where: { id: renewalId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const sub = await prisma.buyerSubscription.update({
      where: { id: renewal.subscriptionId },
      data: { status: "PAYMENT_ATTENTION" },
    });
    await notifySubscriptionEvent(sub.buyerId, "renewal_cancelled", renewalId);
  },

  async retryPayment(buyerId: string, renewalId: string) {
    const renewal = await prisma.renewal.findUnique({ where: { id: renewalId }, include: { subscription: true } });
    if (!renewal || renewal.subscription.buyerId !== buyerId) throw new AppError("Renewal not found", 404);
    if (renewal.status !== "PAYMENT_FAILED") throw new AppError("This renewal is not in a retryable state", 409);
    return this.attemptPayment(renewalId);
  },

  /**
   * Converts a verified-paid renewal into a real Order — reusing the same
   * Order/OrderItem/Payment tables and vendor wallet-crediting pattern as
   * normal checkout, not a parallel system. Only reachable after Stripe's
   * own PaymentIntent status has been read as "succeeded" directly from
   * the API response — never from a client redirect.
   */
  async convertPaidRenewalToOrder(renewalId: string, stripePaymentIntentId: string) {
    const renewal = await prisma.renewal.findUniqueOrThrow({
      where: { id: renewalId },
      include: {
        items: { include: { product: true } },
        subscription: { include: { deliveryAddress: true, offer: true } },
      },
    });
    if (renewal.status === "ORDER_CREATED" && renewal.orderId) {
      return prisma.order.findUnique({ where: { id: renewal.orderId } }); // Already converted — idempotent no-op.
    }

    const vendorId = renewal.subscription.offer.vendorId;
    const subtotal = renewal.items.reduce((sum, i) => sum + i.currentUnitPrice * i.quantity, 0);

    const zone = await prisma.deliveryZone.findFirst({
      where: { country: { equals: renewal.subscription.deliveryAddress.country, mode: "insensitive" }, isActive: true },
    });
    const deliveryFee = zone
      ? zone.baseFeeAmount +
        Math.ceil(renewal.items.reduce((sum, i) => sum + (i.product.weightGrams ?? 0) * i.quantity, 0) / 1000) * zone.feePerKgAmount
      : 0;

    const commission = await resolveVendorCommission(vendorId, subtotal);
    const platformFee = calculatePlatformFee(subtotal, commission.platformFeeBps);
    const totalAmount = subtotal + deliveryFee;
    const vendorEarnings = totalAmount - platformFee;

    const { order } = await prisma.$transaction(async (tx) => {
      for (const item of renewal.items) {
        const result = await tx.product.updateMany({
          where: { id: item.productId, isActive: true, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (result.count !== 1) {
          // Stock disappeared between confirmation and payment — the payment
          // already succeeded, so we still create the order (money moved),
          // but flag it for vendor/admin attention via zero-decrement skip.
          logger.error("Renewal order conversion: stock unavailable after payment succeeded", { renewalId, productId: item.productId });
        }
      }

      const order = await tx.order.create({
        data: {
          buyerId: renewal.subscription.buyerId,
          vendorId,
          status: "PAID",
          subtotalAmount: subtotal,
          deliveryFeeAmount: deliveryFee,
          platformFeeAmount: platformFee,
          vendorEarnings,
          sellerPlanId: commission.sellerPlanId,
          sellerPlanSlug: commission.sellerPlanSlug,
          commissionTierId: commission.commissionTierId,
          commissionBps: commission.platformFeeBps,
          withdrawalFeeBps: commission.withdrawalFeeBps,
          totalAmount,
          currency: renewal.currency,
          deliveryZoneId: zone?.id,
          deliveryAddress: `${renewal.subscription.deliveryAddress.line1}, ${renewal.subscription.deliveryAddress.city}, ${renewal.subscription.deliveryAddress.country}`,
          notes: "Regular Delivery renewal",
          items: {
            create: renewal.items.map((item) => ({
              productId: item.productId,
              vendorId,
              quantity: item.quantity,
              unitAmount: item.currentUnitPrice,
              totalAmount: item.currentUnitPrice * item.quantity,
              currency: item.currency,
              productTitle: item.product.title,
            })),
          },
          payment: {
            create: {
              amount: totalAmount,
              platformFeeAmount: platformFee,
              vendorEarningsAmount: vendorEarnings,
              sellerPlanId: commission.sellerPlanId,
              sellerPlanSlug: commission.sellerPlanSlug,
              commissionTierId: commission.commissionTierId,
              commissionBps: commission.platformFeeBps,
              withdrawalFeeBps: commission.withdrawalFeeBps,
              currency: renewal.currency,
              status: "SUCCEEDED",
              provider: "stripe",
              stripePaymentIntentId,
              processedAt: new Date(),
            },
          },
        },
      });

      let wallet = await tx.wallet.findUnique({ where: { vendorId } });
      if (!wallet) wallet = await tx.wallet.create({ data: { vendorId, currency: renewal.currency } });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id, vendorId, orderId: order.id,
          type: "PAYMENT_PENDING_CREDIT", amount: vendorEarnings, currency: renewal.currency,
          description: `Regular Delivery renewal for order ${order.orderNumber}`,
        },
      });
      await tx.wallet.update({ where: { id: wallet.id }, data: { pendingBalance: { increment: vendorEarnings } } });

      await tx.renewal.update({ where: { id: renewalId }, data: { status: "ORDER_CREATED", orderId: order.id } });
      await tx.buyerSubscription.update({
        where: { id: renewal.subscriptionId },
        data: { status: "ACTIVE", nextRenewalAt: nextCycleDate(renewal.subscription.frequency, renewal.cycleDate) },
      });

      return { order };
    });

    await notifySubscriptionEvent(renewal.subscription.buyerId, "order_created", renewalId, order.orderNumber);
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
    if (vendor) {
      await notificationsService.enqueue({
        userId: vendor.userId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Regular Delivery renewal paid",
        body: `Order ${order.orderNumber} was created from a subscription renewal.`,
        data: { type: "subscription_update", event: "vendor_renewal_paid", orderNumber: order.orderNumber },
      });
    }
    return order;
  },
};

async function notifySubscriptionEvent(buyerId: string, event: string, renewalId: string, orderNumber?: string) {
  const titles: Record<string, string> = {
    price_approval_required: "Price change needs your approval",
    payment_failed: "Your Regular Delivery payment failed",
    renewal_cancelled: "Your Regular Delivery was cancelled",
    order_created: "Your Regular Delivery order was created",
  };
  const bodies: Record<string, string> = {
    price_approval_required: "Review the updated price on your upcoming delivery.",
    payment_failed: "We couldn't collect payment for your upcoming delivery. Retry from the app.",
    renewal_cancelled: "We couldn't collect payment after several attempts. Your subscription needs attention.",
    order_created: orderNumber ? `Order ${orderNumber} has been created and is being prepared.` : "Your order was created.",
  };
  await notificationsService.enqueue({
    userId: buyerId,
    type: "SUBSCRIPTION_UPDATE",
    title: titles[event] ?? "Regular Delivery update",
    body: bodies[event] ?? "",
    data: { type: "subscription_update", event, renewalId },
  });
}
