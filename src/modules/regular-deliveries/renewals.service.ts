import type Stripe from "stripe";

import { env } from "../../config/env";
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
      include: { items: { include: { product: true } }, offer: { select: { renewalsPaused: true } } },
    });

    let created = 0;
    let skipped = 0;
    for (const sub of due) {
      if (!sub.nextRenewalAt) continue;
      if (sub.offer.renewalsPaused) {
        // Vendor has paused this offer's renewals — leave nextRenewalAt as
        // is so the subscription is picked up again the moment it resumes,
        // rather than silently drifting the buyer's cycle forward.
        skipped++;
        continue;
      }
      try {
        const renewal = await this.createRenewalForCycle(sub.id, sub.nextRenewalAt);
        if (renewal) created++;
        else skipped++; // every item this subscriber picked is currently vendor-paused
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

  /**
   * Proactive heads-up 1-3 days before a subscription's next renewal —
   * distinct from any of the reactive renewal-cycle notifications above,
   * which all fire once a Renewal row already exists. Dedupe key is
   * per subscription+cycle date, so a buyer gets at most one of these
   * per renewal even if the sweep runs more than once before it fires.
   */
  async sendUpcomingRenewalReminders(): Promise<number> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const upcoming = await prisma.buyerSubscription.findMany({
      where: { status: "ACTIVE", nextRenewalAt: { gte: now, lte: windowEnd } },
      select: {
        id: true,
        buyerId: true,
        nextRenewalAt: true,
        offer: { select: { title: true, vendor: { select: { storeName: true } } } },
      },
    });

    for (const sub of upcoming) {
      if (!sub.nextRenewalAt) continue;
      const storeName = sub.offer.vendor.storeName;
      await notificationsService.enqueue({
        userId: sub.buyerId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Upcoming Regular Delivery",
        body: `Your delivery from ${storeName} renews on ${sub.nextRenewalAt.toDateString()}.`,
        data: { type: "subscription_update", event: "renewal_upcoming", subscriptionId: sub.id },
      });
      await automationService.scheduleAutomation({
        type: "RENEWAL_REMINDER",
        recipientUserId: sub.buyerId,
        subjectKey: `${sub.id}:${sub.nextRenewalAt.toISOString().slice(0, 10)}`,
        frequencyCapDays: 3,
        requiresMarketingConsent: false,
        title: "Upcoming Regular Delivery",
        body: `Your delivery from ${storeName} renews soon.`,
        data: { store_name: storeName, renewal_date: sub.nextRenewalAt.toDateString() },
      });
    }
    return upcoming.length;
  },

  /**
   * Returns null (no renewal created, no charge) when every item the
   * subscriber picked is currently vendor-paused (spec §31) — the caller
   * must not treat that as an error, just nothing due this cycle.
   */
  async createRenewalForCycle(subscriptionId: string, cycleDate: Date) {
    const sub = await prisma.buyerSubscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: {
        items: { include: { product: true } },
        offer: { select: { discountPercent: true, products: { select: { productId: true, pausedAt: true } } } },
      },
    });
    // spec §22 "Offer a Regular Delivery discount" — a flat percentage off
    // the live product price, applied consistently every cycle so it never
    // itself looks like a vendor price change to the approval-gate below.
    const discountPercent = sub.offer.discountPercent ?? 0;
    const applyDiscount = (priceInCents: number) =>
      discountPercent > 0 ? Math.round(priceInCents * (1 - discountPercent / 100)) : priceInCents;

    // spec §31 "Pause Product Renewals" — a vendor-paused product is
    // dropped from this cycle only; the subscription itself is untouched.
    const pausedProductIds = new Set(sub.offer.products.filter((p) => p.pausedAt).map((p) => p.productId));
    const activeItems = sub.items.filter((item) => !pausedProductIds.has(item.productId));
    if (activeItems.length === 0) {
      // Nothing due this cycle — advance to the next one so the
      // subscription doesn't get stuck retrying a fully-paused cycle
      // forever (mirrors the SKIPPED/ORDER_CREATED advance below).
      await prisma.buyerSubscription.update({
        where: { id: subscriptionId },
        data: { nextRenewalAt: nextCycleDate(sub.frequency, cycleDate) },
      });
      return null;
    }

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
        currency: activeItems[0]?.product.currency ?? "GBP",
        items: {
          create: activeItems.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            previousUnitPrice: lastPriceByProduct.get(item.productId) ?? applyDiscount(item.product.priceInCents),
            currentUnitPrice: applyDiscount(item.product.priceInCents),
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
      await notifySubscriptionEvent(renewal.subscription.buyerId, "price_approval_required", renewalId, renewal.subscriptionId);
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
      include: { subscription: { include: { offer: { select: { vendorId: true } } } }, priceChangeRequest: true },
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

    // Architecture doc's vendor-notification list names "Buyer approved
    // price" explicitly — this module otherwise notifies only the buyer
    // (see notifySubscriptionEvent below), so without this the vendor had
    // no way to learn the buyer's decision short of checking the
    // subscriber list later.
    await notifyVendorPriceDecision(renewal.subscription.offer.vendorId, decision, renewal.subscriptionId).catch(() => {});

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
    // A buyer who paused their subscription after this renewal was already
    // cleared for payment must not still be charged for it — pause() only
    // flips the subscription record; it doesn't touch an in-flight renewal.
    if (renewal.subscription.status !== "ACTIVE") {
      throw new AppError(`Subscription is ${renewal.subscription.status.toLowerCase()}, not active — payment skipped`, 409);
    }
    const paymentMethod = renewal.subscription.paymentMethod;
    if (!paymentMethod) throw new AppError("No saved payment method on this subscription", 409);

    const subtotal = renewal.items.reduce((sum, i) => sum + i.currentUnitPrice * i.quantity, 0);

    // Atomic claim — mirrors the same fix applied to Community Buy's
    // attemptCharge(). Without this, two concurrent triggers (e.g. an
    // overlapping cron sweep and a buyer-initiated retryPayment) can both
    // pass the status guard above, then race to compute a DIFFERENT
    // attemptNumber each — which means a DIFFERENT Stripe idempotency key
    // each, so Stripe does not deduplicate them and the buyer's card can
    // genuinely be charged twice. Only one concurrent caller can win this
    // guarded transition; the loser returns immediately instead of racing
    // to Stripe.
    const claim = await prisma.renewal.updateMany({
      where: { id: renewalId, status: { in: ["READY_FOR_PAYMENT", "PAYMENT_FAILED"] } },
      data: { status: "PAYMENT_PROCESSING", subtotalAmount: subtotal },
    });
    if (claim.count !== 1) {
      return prisma.renewal.findUnique({ where: { id: renewalId } });
    }

    const priorAttempts = await prisma.subscriptionPaymentAttempt.count({ where: { renewalId } });
    if (priorAttempts >= MAX_PAYMENT_ATTEMPTS) {
      await this.cancelAfterRetriesExhausted(renewalId);
      return prisma.renewal.findUnique({ where: { id: renewalId } });
    }
    const attemptNumber = priorAttempts + 1;
    const idempotencyKey = `${renewalId}:${attemptNumber}`;

    const attempt = await prisma.subscriptionPaymentAttempt.create({
      data: { renewalId, attemptNumber, status: "PENDING", idempotencyKey },
    });

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
      const stripeErr = error as { type?: string; code?: string };

      // Reliability scenario #6 "provider timeout": a network/connection
      // error or a Stripe-side 5xx means we genuinely don't know whether
      // Stripe received and processed the charge — unlike a definitive
      // decline (StripeCardError etc), this is NOT a confirmed failure.
      // Treating it as one would let a later retry compute a NEW
      // attemptNumber (a different, undeduped idempotency key) and
      // genuinely double-charge the buyer if the original request actually
      // went through on Stripe's side. Instead this stays claimed exactly
      // like the "processing" branch below — unresolved, no new attempt
      // possible — and requeryAmbiguousAttempt() below is the real
      // recovery path: it replays the SAME idempotencyKey, which Stripe
      // itself guarantees is safe to repeat.
      if (stripeErr.type === "StripeConnectionError" || stripeErr.type === "StripeAPIError") {
        await prisma.subscriptionPaymentAttempt.update({
          where: { id: attempt.id },
          data: { failureCode: stripeErr.code, failureMessage: message },
        });
        return prisma.renewal.findUnique({ where: { id: renewalId } });
      }

      await prisma.subscriptionPaymentAttempt.update({
        where: { id: attempt.id },
        data: { status: "FAILED", failureCode: stripeErr.code, failureMessage: message },
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

    if (intent.status === "processing") {
      // Delayed-notification payment method (e.g. a bank debit) — genuinely
      // unresolved, not a failure. The renewal stays claimed in
      // PAYMENT_PROCESSING (set above) and the attempt stays PENDING, so
      // the status guard at the top of this method blocks any concurrent
      // or later attemptPayment()/retryPayment() call for this renewal —
      // reopening retry here would let a second, distinct Stripe
      // idempotency key double-charge the buyer if this one later settles
      // as succeeded (spec §18.4/§18.5). The eventual payment_intent
      // webhook resolves it — see stripe.service.ts's handler for
      // metadata.kind === "regular_delivery_renewal".
      await prisma.subscriptionPaymentAttempt.update({
        where: { id: attempt.id },
        data: { stripePaymentIntentId: intent.id },
      });
      return prisma.renewal.findUnique({ where: { id: renewalId } });
    }

    // requires_action / anything else — an off-session charge with no
    // buyer present can't complete extra authentication. Treat as failed
    // and let the controlled retry/recovery flow handle it.
    await prisma.subscriptionPaymentAttempt.update({
      where: { id: attempt.id },
      data: { status: "FAILED", stripePaymentIntentId: intent.id, failureCode: intent.status, failureMessage: "Payment requires additional authentication" },
    });
    return this.handlePaymentFailure(renewal.subscriptionId, renewalId, `Unexpected status: ${intent.status}`);
  },

  /**
   * Reliability scenario #6 "provider timeout" recovery path. Replays the
   * exact same Stripe request with the SAME stored idempotencyKey for an
   * attempt attemptPayment() left ambiguous after a connection/API error —
   * Stripe itself guarantees replaying an idempotency key is safe, so this
   * can never produce a second real charge even if the original request
   * actually succeeded. A no-op if there is nothing ambiguous to resolve
   * (already resolved by a webhook, or never went ambiguous).
   */
  async requeryAmbiguousAttempt(renewalId: string) {
    const attempt = await prisma.subscriptionPaymentAttempt.findFirst({
      where: { renewalId, status: "PENDING", stripePaymentIntentId: null },
      orderBy: { attemptNumber: "desc" },
    });
    if (!attempt) return { handled: false as const };

    const renewal = await prisma.renewal.findUniqueOrThrow({
      where: { id: renewalId },
      include: { subscription: { include: { paymentMethod: true } } },
    });
    if (renewal.status !== "PAYMENT_PROCESSING") return { handled: false as const };
    const paymentMethod = renewal.subscription.paymentMethod;
    if (!paymentMethod || renewal.subtotalAmount == null) return { handled: false as const };

    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: renewal.subtotalAmount,
          currency: resolveStripeCurrency(renewal.currency),
          customer: paymentMethod.stripeCustomerId,
          payment_method: paymentMethod.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          metadata: { kind: "regular_delivery_renewal", renewalId, subscriptionId: renewal.subscriptionId },
        },
        { idempotencyKey: attempt.idempotencyKey },
      );
    } catch (error) {
      // Still ambiguous (or a fresh connection failure) — leave it exactly
      // as it was for the next requery, never mark it FAILED from a
      // requery we can't actually confirm either.
      const stripeErr = error as { type?: string; code?: string };
      const message = error instanceof Error ? error.message : String(error);
      await prisma.subscriptionPaymentAttempt.update({ where: { id: attempt.id }, data: { failureCode: stripeErr.code, failureMessage: message } });
      return { handled: false as const };
    }

    if (intent.status === "succeeded") {
      const claim = await prisma.subscriptionPaymentAttempt.updateMany({ where: { id: attempt.id, status: "PENDING" }, data: { status: "SUCCEEDED", stripePaymentIntentId: intent.id } });
      if (claim.count !== 1) return { handled: false as const };
      const order = await this.convertPaidRenewalToOrder(renewalId, intent.id);
      return { handled: true as const, order };
    }

    if (intent.status === "processing") {
      await prisma.subscriptionPaymentAttempt.update({ where: { id: attempt.id }, data: { stripePaymentIntentId: intent.id } });
      return { handled: false as const };
    }

    const claim = await prisma.subscriptionPaymentAttempt.updateMany({
      where: { id: attempt.id, status: "PENDING" },
      data: { status: "FAILED", stripePaymentIntentId: intent.id, failureCode: intent.status, failureMessage: "Payment requires additional authentication" },
    });
    if (claim.count !== 1) return { handled: false as const };
    await this.handlePaymentFailure(renewal.subscriptionId, renewalId, `Unexpected status: ${intent.status}`);
    return { handled: true as const };
  },

  /**
   * Resolves a renewal payment whose PaymentIntent was left "processing" by
   * attemptPayment() above, once Stripe's webhook reports the real outcome.
   * Idempotent: a SUCCEEDED/non-PENDING attempt or a renewal already past
   * PAYMENT_PROCESSING means this already ran (or was never the winner of
   * the atomic claim), so it's a safe no-op.
   */
  async resolveProcessingPayment(renewalId: string, stripePaymentIntentId: string, succeeded: boolean, failureMessage?: string) {
    const attempt = await prisma.subscriptionPaymentAttempt.findFirst({
      where: { renewalId, stripePaymentIntentId },
    });
    if (!attempt || attempt.status !== "PENDING") return { handled: false as const };

    const renewal = await prisma.renewal.findUnique({ where: { id: renewalId } });
    if (!renewal || renewal.status !== "PAYMENT_PROCESSING") return { handled: false as const };

    if (succeeded) {
      // Same atomic-claim pattern as attemptPayment()'s claim above — the
      // conditional updateMany's count, not the findFirst read above, is
      // what actually proves this call won the transition, so a concurrent
      // duplicate resolution can never post the order/ledger twice.
      const claim = await prisma.subscriptionPaymentAttempt.updateMany({
        where: { id: attempt.id, status: "PENDING" },
        data: { status: "SUCCEEDED" },
      });
      if (claim.count !== 1) return { handled: false as const };
      const order = await this.convertPaidRenewalToOrder(renewalId, stripePaymentIntentId);
      return { handled: true as const, order };
    }

    const claim = await prisma.subscriptionPaymentAttempt.updateMany({
      where: { id: attempt.id, status: "PENDING" },
      data: { status: "FAILED", failureMessage: failureMessage ?? "Payment failed after processing" },
    });
    if (claim.count !== 1) return { handled: false as const };
    await this.handlePaymentFailure(renewal.subscriptionId, renewalId, failureMessage ?? "Payment failed after processing");
    return { handled: true as const };
  },

  async handlePaymentFailure(subscriptionId: string, renewalId: string, reason: string) {
    await prisma.renewal.update({ where: { id: renewalId }, data: { status: "PAYMENT_FAILED", failureReason: reason } });
    const sub = await prisma.buyerSubscription.update({
      where: { id: subscriptionId },
      data: { status: "PAYMENT_ATTENTION" },
    });
    await notifySubscriptionEvent(sub.buyerId, "payment_failed", renewalId, subscriptionId);
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

  /**
   * spec §18.11 "Buyer does not approve price": a renewal stuck in
   * AWAITING_PRICE_APPROVAL forever would block that cycle indefinitely.
   * The architecture doc defines the EXPIRED renewal status for exactly
   * this and requires it be tested, but names no duration a buyer has to
   * respond — see getPriceApprovalTimeoutHours() in config/env.ts. Until
   * PRICE_APPROVAL_TIMEOUT_HOURS is set, this is a genuine no-op: it never
   * expires a renewal on an invented default.
   */
  async expirePriceApprovalTimeouts(): Promise<{ configured: boolean; expired: number }> {
    if (env.priceApprovalTimeoutHours == null) {
      return { configured: false, expired: 0 };
    }
    const cutoff = new Date(Date.now() - env.priceApprovalTimeoutHours * 60 * 60 * 1000);
    const stale = await prisma.renewal.findMany({
      where: { status: "AWAITING_PRICE_APPROVAL", priceChangeRequest: { createdAt: { lte: cutoff } } },
      include: { subscription: true },
    });

    let expired = 0;
    for (const renewal of stale) {
      // Atomic claim — same pattern as attemptPayment()'s claim: only one
      // concurrent sweep run can win this transition for a given renewal.
      const claim = await prisma.renewal.updateMany({
        where: { id: renewal.id, status: "AWAITING_PRICE_APPROVAL" },
        data: { status: "EXPIRED" },
      });
      if (claim.count !== 1) continue;
      expired++;
      await prisma.buyerSubscription.update({
        where: { id: renewal.subscriptionId },
        data: { nextRenewalAt: nextCycleDate(renewal.subscription.frequency, renewal.cycleDate) },
      });
      await notifySubscriptionEvent(renewal.subscription.buyerId, "price_approval_expired", renewal.id, renewal.subscriptionId);
    }
    return { configured: true, expired };
  },

  async cancelAfterRetriesExhausted(renewalId: string) {
    const renewal = await prisma.renewal.update({ where: { id: renewalId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const sub = await prisma.buyerSubscription.update({
      where: { id: renewal.subscriptionId },
      data: { status: "PAYMENT_ATTENTION" },
    });
    await notifySubscriptionEvent(sub.buyerId, "renewal_cancelled", renewalId, renewal.subscriptionId);
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

    await notifySubscriptionEvent(renewal.subscription.buyerId, "order_created", renewalId, renewal.subscriptionId, order.orderNumber);
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

async function notifySubscriptionEvent(buyerId: string, event: string, renewalId: string, subscriptionId: string, orderNumber?: string) {
  const titles: Record<string, string> = {
    price_approval_required: "Price change needs your approval",
    payment_failed: "Your Regular Delivery payment failed",
    renewal_cancelled: "Your Regular Delivery was cancelled",
    price_approval_expired: "Your Regular Delivery was skipped",
    order_created: "Your Regular Delivery order was created",
  };
  const bodies: Record<string, string> = {
    price_approval_required: "Review the updated price on your upcoming delivery.",
    payment_failed: "We couldn't collect payment for your upcoming delivery. Retry from the app.",
    renewal_cancelled: "We couldn't collect payment after several attempts. Your subscription needs attention.",
    price_approval_expired: "We didn't hear back about the price change in time, so this delivery was skipped.",
    order_created: orderNumber ? `Order ${orderNumber} has been created and is being prepared.` : "Your order was created.",
  };
  await notificationsService.enqueue({
    userId: buyerId,
    type: "SUBSCRIPTION_UPDATE",
    title: titles[event] ?? "Regular Delivery update",
    body: bodies[event] ?? "",
    data: { type: "subscription_update", event, renewalId, subscriptionId },
  });
}

async function notifyVendorPriceDecision(vendorId: string, decision: "accepted" | "declined", subscriptionId: string): Promise<void> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
  if (!vendor) return;
  await notificationsService.enqueue({
    userId: vendor.userId,
    type: "SUBSCRIPTION_UPDATE",
    title: decision === "accepted" ? "Buyer approved your price change" : "Buyer declined your price change",
    body: decision === "accepted"
      ? "The buyer accepted the new price. This delivery will proceed at the updated price."
      : "The buyer declined the new price. This delivery was skipped.",
    data: { type: "subscription_update", event: "vendor_price_decision", subscriptionId },
  });
}
