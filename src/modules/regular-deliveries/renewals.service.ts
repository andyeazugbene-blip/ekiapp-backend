import type Stripe from "stripe";
import type { Request } from "express";

import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { calculatePlatformFee } from "../../shared/pricing";
import { resolveStripeCurrency } from "../../shared/currency";
import { resolveVendorCommission } from "../subscriptions/subscription-plan-utils";
import { notificationsService } from "../notifications/notifications.service";
import { automationService } from "../automation/automation.service";
import { recordAudit } from "../../shared/utils/audit";
import { eventsService, EVENT_NAMES } from "../events/events.service";
import { nextCycleDate, recordAction } from "./buyer-subscriptions.service";
import { adminPlatformSettingsService } from "../admin/admin-platform-settings.service";

// Regular Deliveries had zero AuditLog coverage for anything beyond buyer-
// initiated actions (those go to SubscriptionActionHistory instead, see
// buyer-subscriptions.service.ts — deliberately not duplicated here).
// Routine, expected, high-volume automation (a renewal simply being
// created on schedule, an internal PAYMENT_PROCESSING claim) is not
// audited — there's nothing to investigate about a scheduled job doing
// its job. What IS audited below are the transitions with real business/
// dispute relevance: a buyer's material price decision, a payment
// actually failing, a renewal being cancelled after exhausting retries,
// and a price-approval silently expiring.
const SYSTEM_CRON_ACTOR = "system:cron";

export const MAX_PAYMENT_ATTEMPTS = 3;
const PRICE_CHANGE_APPROVAL_DEFAULT_BPS = 500; // 5%

// Payment-recovery schedule (handbook section 9, gap B23). Delay applied after
// the Nth FAILED attempt: +1 day, then +2 more (cumulative +3d), then a final
// +2-day grace (cumulative +5d) during which the buyer can still fix their
// card and retry by hand before the renewal is finalised: renewal CANCELLED
// and the subscription PAUSED with reason "payment_failed" (never left stuck
// in PAYMENT_ATTENTION).
export const PAYMENT_RETRY_DELAY_DAYS = [1, 2, 2] as const;
export const PAYMENT_FAILED_PAUSE_REASON = "payment_failed";
// Used when the admin has not set PRICE_APPROVAL_TIMEOUT_HOURS (instead of "never expires").
export const DEFAULT_PRICE_APPROVAL_TIMEOUT_HOURS = 48;
// Admin-editable via AdminPlatformSetting key AWAITING_STOCK_TIMEOUT_HOURS.
export const AWAITING_STOCK_TIMEOUT_SETTING_KEY = "AWAITING_STOCK_TIMEOUT_HOURS";
export const DEFAULT_AWAITING_STOCK_TIMEOUT_HOURS = 72;
// Advance price-change notice goes out when the next cycle is due within this window.
const PRICE_NOTICE_WINDOW_HOURS = 36;
const DAY_MS = 24 * 60 * 60 * 1000;

export function nextRetryDate(failedAttempts: number, from: Date = new Date()): Date {
  const idx = Math.min(Math.max(failedAttempts, 1), PAYMENT_RETRY_DELAY_DAYS.length) - 1;
  return new Date(from.getTime() + PAYMENT_RETRY_DELAY_DAYS[idx] * DAY_MS);
}

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
   * which all fire once a Renewal row already exists.
   *
   * Both the in-app Notification and the AutomationRun below are keyed by
   * the SAME canonical identity — "RENEWAL_REMINDER:{subscriptionId}:
   * {cycleDate}" — and both dedupe at the DB level (Notification.dedupeKey
   * / AutomationRun.dedupeKey, each a unique column), not just in
   * application logic. That's what actually makes "a buyer gets at most
   * one of these per renewal" true even when the sweep runs more than
   * once (a retry, an overlapping cron trigger, two concurrent
   * invocations) before or after it first fires — a plain "does one
   * already exist" check here would still race under concurrent execution.
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
        offer: { select: { vendorId: true, title: true, vendor: { select: { storeName: true } } } },
      },
    });

    for (const sub of upcoming) {
      if (!sub.nextRenewalAt) continue;
      const storeName = sub.offer.vendor.storeName;
      const dedupeKey = `RENEWAL_REMINDER:${sub.id}:${sub.nextRenewalAt.toISOString().slice(0, 10)}`;
      await notificationsService.enqueue({
        userId: sub.buyerId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Upcoming Foodstuffs Subscription",
        body: `Your delivery from ${storeName} renews on ${sub.nextRenewalAt.toDateString()}.`,
        data: { type: "subscription_update", event: "renewal_upcoming", subscriptionId: sub.id },
        dedupeKey,
      });
      await automationService.scheduleAutomation({
        type: "RENEWAL_REMINDER",
        vendorId: sub.offer.vendorId,
        recipientUserId: sub.buyerId,
        subjectKey: `${sub.id}:${sub.nextRenewalAt.toISOString().slice(0, 10)}`,
        frequencyCapDays: 3,
        requiresMarketingConsent: false,
        title: "Upcoming Foodstuffs Subscription",
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

    // The DB unique (subscriptionId, cycleDate) means create() above succeeds once per cycle,
    // so this fires once; eventKey lets consumers dedupe the at-least-once delivery anyway.
    eventsService.emit({
      name: EVENT_NAMES.renewal_due, actorType: "system", entityType: "Renewal", entityId: renewal.id,
      secondaryEntities: { subscriptionId }, source: "generate_due_renewals", currency: renewal.currency,
      payload: { eventKey: `renewal_due:${subscriptionId}:${cycleDate.toISOString()}`, subscriptionId, cycleDate: cycleDate.toISOString() },
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
    await prisma.renewal.update({ where: { id: renewalId }, data: { status: "AWAITING_STOCK", awaitingStockSince: new Date() } });
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
      include: { items: true, subscription: { include: { offer: { select: { vendorId: true } } } } },
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
        // AUTO-06 fix — see the identical fix + comment on detectPaymentRecovery().
        vendorId: renewal.subscription.offer.vendorId,
        subjectKey: renewalId,
        requiresMarketingConsent: false,
        title: "Price change needs your approval",
        body: "Review the price change on your upcoming Foodstuffs Subscription delivery.",
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

    await recordAudit({
      actorId: buyerId,
      action: "renewal.price_decision",
      entityType: "Renewal",
      entityId: renewalId,
      metadata: { decision },
    });

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
      include: {
        items: { include: { product: { select: { weightGrams: true } } } },
        subscription: { include: { paymentMethod: true, offer: { select: { fulfilmentMethod: true } }, deliveryAddress: { select: { country: true } } } },
      },
    });
    if (renewal.status !== "READY_FOR_PAYMENT" && renewal.status !== "PAYMENT_FAILED") {
      throw new AppError("Renewal is not ready for payment", 409);
    }
    // A buyer who paused their subscription after this renewal was already
    // cleared for payment must not still be charged for it — pause() only
    // flips the subscription record; it doesn't touch an in-flight renewal.
    // PAYMENT_ATTENTION is the state handlePaymentFailure() puts the
    // subscription in, so a retry of a failed renewal MUST be allowed from it
    // (previously every buyer/admin retry died here with a 409 — part of B23).
    if (renewal.subscription.status !== "ACTIVE" && renewal.subscription.status !== "PAYMENT_ATTENTION") {
      throw new AppError(`Subscription is ${renewal.subscription.status.toLowerCase()}, not active — payment skipped`, 409);
    }
    const paymentMethod = renewal.subscription.paymentMethod;
    if (!paymentMethod) throw new AppError("No saved payment method on this subscription", 409);

    const subtotal = renewal.items.reduce((sum, i) => sum + i.currentUnitPrice * i.quantity, 0);

    // Resolve delivery fee ONCE, here, BEFORE the buyer is ever charged —
    // never re-derived later at order-conversion time. Previously the fee
    // was computed for the first time AFTER payment succeeded, defaulting
    // to £0 whenever no zone matched (a DELIVERY-fulfilment renewal could
    // be silently charged with no delivery coverage at all) — or, when a
    // zone DID exist, the buyer was still only ever charged `subtotal`
    // (see the Stripe call below) while the Order/Payment/vendor-wallet-
    // credit recorded subtotal+fee, permanently overstating vendor
    // earnings for a fee never actually collected. One-off checkout
    // refuses to charge a vendor with no delivery coverage in that
    // market; this now matches that.
    let deliveryFeeAmount = 0;
    let deliveryZoneId: string | null = null;
    if (renewal.subscription.offer.fulfilmentMethod === "DELIVERY") {
      const zone = await prisma.deliveryZone.findFirst({
        where: { country: { equals: renewal.subscription.deliveryAddress.country, mode: "insensitive" }, isActive: true },
      });
      if (!zone) {
        const reason = `No active delivery coverage configured for ${renewal.subscription.deliveryAddress.country}`;
        await prisma.renewal.update({ where: { id: renewalId }, data: { status: "PAYMENT_FAILED", failureReason: reason } });
        await recordAudit({
          actorId: SYSTEM_CRON_ACTOR,
          action: "renewal.payment_blocked_no_delivery_coverage",
          entityType: "Renewal",
          entityId: renewalId,
          metadata: { subscriptionId: renewal.subscriptionId, country: renewal.subscription.deliveryAddress.country },
        });
        await notifySubscriptionEvent(renewal.subscription.buyerId, "payment_failed", renewalId, renewal.subscriptionId);
        // Not a retryable payment failure in the normal sense — no card was
        // ever attempted, and retrying won't help until an admin adds
        // coverage — so no SubscriptionPaymentAttempt row is created here,
        // it doesn't count against MAX_PAYMENT_ATTEMPTS.
        return prisma.renewal.findUnique({ where: { id: renewalId } });
      }
      deliveryZoneId = zone.id;
      const totalWeightGrams = renewal.items.reduce((sum, i) => sum + (i.product.weightGrams ?? 0) * i.quantity, 0);
      deliveryFeeAmount = zone.baseFeeAmount + Math.ceil(totalWeightGrams / 1000) * zone.feePerKgAmount;
    }
    const totalToCharge = subtotal + deliveryFeeAmount;

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
      data: { status: "PAYMENT_PROCESSING", subtotalAmount: subtotal, deliveryFeeAmount, deliveryZoneId, nextRetryAt: null },
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
          amount: totalToCharge,
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
    // Must exactly match the amount attemptPayment() originally sent under
    // this same idempotencyKey (subtotal + the delivery fee resolved and
    // stored at that same claim) — Stripe rejects an idempotency-key
    // replay whose parameters don't match the original request, so this
    // requery would otherwise fail outright for any renewal with a real
    // delivery fee.
    const totalToCharge = renewal.subtotalAmount + (renewal.deliveryFeeAmount ?? 0);

    let intent: Stripe.PaymentIntent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: totalToCharge,
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
    // Schedule the next automatic retry (or the final grace deadline once the
    // attempts are used up) — see PAYMENT_RETRY_DELAY_DAYS.
    const failedAttempts = await prisma.subscriptionPaymentAttempt.count({ where: { renewalId, status: "FAILED" } });
    const retryAt = nextRetryDate(Math.max(failedAttempts, 1));
    const finalAttempt = failedAttempts >= MAX_PAYMENT_ATTEMPTS;
    await prisma.renewal.update({ where: { id: renewalId }, data: { status: "PAYMENT_FAILED", failureReason: reason, nextRetryAt: retryAt } });
    const sub = await prisma.buyerSubscription.update({
      where: { id: subscriptionId },
      data: { status: "PAYMENT_ATTENTION" },
      // AUTO-06 fix: this is a second PAYMENT_RECOVERY call site beyond the
      // one named in the original finding (automation.detectors.ts) — same
      // defect (no vendorId, so the run is real and sending but invisible
      // in the vendor's Automation Activity), fixed the same way.
      include: { offer: { select: { vendorId: true } } },
    });
    await recordAudit({
      actorId: SYSTEM_CRON_ACTOR,
      action: "renewal.payment_failed",
      entityType: "Renewal",
      entityId: renewalId,
      metadata: { subscriptionId, reason, failedAttempts, nextRetryAt: retryAt.toISOString(), finalAttempt },
    });
    await notifySubscriptionEvent(sub.buyerId, "payment_failed", renewalId, subscriptionId, undefined, { retryAt, finalAttempt, attempt: failedAttempts });
    await automationService.scheduleAutomation({
      type: "PAYMENT_RECOVERY",
      recipientUserId: sub.buyerId,
      vendorId: sub.offer.vendorId,
      subjectKey: `renewal:${renewalId}`,
      requiresMarketingConsent: false,
      title: "Your Foodstuffs Subscription payment didn't go through",
      body: "Update your payment method or retry now to keep your subscription active.",
    });
    return prisma.renewal.findUnique({ where: { id: renewalId } });
  },

  /**
   * spec §18.11 "Buyer does not approve price": a renewal stuck in
   * AWAITING_PRICE_APPROVAL forever would block that cycle indefinitely.
   * The architecture doc defines the EXPIRED renewal status for exactly
   * this and requires it be tested, but names no duration a buyer has to
   * respond — see the PRICE_APPROVAL_TIMEOUT_HOURS admin operational
   * setting (Settings -> Operational Thresholds in admin-web). When the
   * setting is unset the documented default (48h) applies instead of "never
   * expires" so a cycle can never be blocked indefinitely.
   */
  async expirePriceApprovalTimeouts(): Promise<{ configured: boolean; expired: number }> {
    const configuredHours = await adminPlatformSettingsService.getValue("PRICE_APPROVAL_TIMEOUT_HOURS");
    const priceApprovalTimeoutHours = configuredHours ?? DEFAULT_PRICE_APPROVAL_TIMEOUT_HOURS;
    const cutoff = new Date(Date.now() - priceApprovalTimeoutHours * 60 * 60 * 1000);
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
      await recordAudit({
        actorId: SYSTEM_CRON_ACTOR,
        action: "renewal.price_approval_expired",
        entityType: "Renewal",
        entityId: renewal.id,
        metadata: { subscriptionId: renewal.subscriptionId, timeoutHours: priceApprovalTimeoutHours },
      });
      await notifySubscriptionEvent(renewal.subscription.buyerId, "price_approval_expired", renewal.id, renewal.subscriptionId);
    }
    return { configured: configuredHours != null, expired };
  },

  /**
   * B23 dead-end fix. After the payment attempts are exhausted the renewal is
   * CANCELLED and the SUBSCRIPTION IS PAUSED with reason "payment_failed" — it
   * no longer sits in PAYMENT_ATTENTION forever. The buyer is told to update
   * their payment method; the buyer (resume) or an admin (resume) can restart
   * it, which schedules a fresh cycle immediately. Race-safe: only one caller
   * can win the CANCELLED transition, so notifications/audit fire once.
   */
  async cancelAfterRetriesExhausted(renewalId: string) {
    const claim = await prisma.renewal.updateMany({
      where: { id: renewalId, status: { in: ["PAYMENT_FAILED", "PAYMENT_PROCESSING"] } },
      data: { status: "CANCELLED", cancelledAt: new Date(), nextRetryAt: null },
    });
    if (claim.count !== 1) return null;
    const renewal = await prisma.renewal.findUniqueOrThrow({ where: { id: renewalId } });
    const now = new Date();
    const sub = await prisma.buyerSubscription.update({
      where: { id: renewal.subscriptionId },
      data: { status: "PAUSED", pausedReason: PAYMENT_FAILED_PAUSE_REASON, pausedAt: now, pausedUntil: null },
    });
    await prisma.subscriptionActionHistory.create({
      data: { subscriptionId: renewal.subscriptionId, action: "paused_payment_failed", metadata: { renewalId, reason: renewal.failureReason ?? null } as any },
    });
    await recordAudit({
      actorId: SYSTEM_CRON_ACTOR,
      action: "renewal.cancelled_retries_exhausted",
      entityType: "Renewal",
      entityId: renewalId,
      beforeState: { renewalStatus: "PAYMENT_FAILED", subscriptionStatus: "PAYMENT_ATTENTION" },
      afterState: { renewalStatus: "CANCELLED", subscriptionStatus: "PAUSED", pausedReason: PAYMENT_FAILED_PAUSE_REASON },
      metadata: { subscriptionId: renewal.subscriptionId },
    });
    await notifySubscriptionEvent(sub.buyerId, "renewal_cancelled", renewalId, renewal.subscriptionId);
    return renewal;
  },

  // ─── Sweep steps (run from runRenewalsSweep) ──────────────────────────

  /** One entry point so internal.routes.ts needs only a single call. Each step is isolated. */
  async runRecoverySweep() {
    const safe = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn(); } catch (err) { logger.error(`Renewals sweep step failed: ${name}`, { error: String(err) }); return fallback; }
    };
    const autoResumed = await safe("auto-resume", () => this.resumePausedDue(), 0);
    const stockTimeouts = await safe("stock-timeouts", () => this.expireStockTimeouts(), { configuredHours: DEFAULT_AWAITING_STOCK_TIMEOUT_HOURS, skipped: 0 });
    const priceNotices = await safe("price-notices", () => this.sendPriceChangeNotices(), 0);
    const retries = await safe("payment-retries", () => this.retryDueFailedPayments(), { retried: 0, finalised: 0 });
    return { autoResumed, stockTimedOut: stockTimeouts.skipped, priceNoticesSent: priceNotices, paymentRetried: retries.retried, paymentFinalised: retries.finalised };
  },

  /** Subscriptions paused "until" a date come back on their own once that date passes. */
  async resumePausedDue(): Promise<number> {
    const now = new Date();
    const due = await prisma.buyerSubscription.findMany({
      where: { status: "PAUSED", pausedUntil: { lte: now }, OR: [{ pausedReason: null }, { pausedReason: { not: PAYMENT_FAILED_PAUSE_REASON } }] },
      select: { id: true, buyerId: true, nextRenewalAt: true },
      take: 500,
    });
    let resumed = 0;
    for (const sub of due) {
      const nextRenewalAt = sub.nextRenewalAt && sub.nextRenewalAt > now ? sub.nextRenewalAt : now;
      const claim = await prisma.buyerSubscription.updateMany({
        where: { id: sub.id, status: "PAUSED", pausedUntil: { lte: now } },
        data: { status: "ACTIVE", pausedUntil: null, pausedReason: null, pausedAt: null, nextRenewalAt },
      });
      if (claim.count !== 1) continue;
      resumed++;
      await prisma.subscriptionActionHistory.create({ data: { subscriptionId: sub.id, action: "auto_resumed", metadata: { nextRenewalAt: nextRenewalAt.toISOString() } as any } });
      await notificationsService.enqueue({
        userId: sub.buyerId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Your Foodstuffs Subscription is back",
        body: `Your pause has ended and your subscription is active again. Next delivery is prepared on ${nextRenewalAt.toDateString()}.`,
        data: { type: "subscription_update", event: "auto_resumed", subscriptionId: sub.id },
        dedupeKey: `AUTO_RESUMED:${sub.id}:${now.toISOString().slice(0, 10)}`,
      }).catch(() => {});
    }
    return resumed;
  },

  /**
   * A renewal the vendor never confirmed stock for must not block the cycle
   * forever: after the configured window (AdminPlatformSetting
   * AWAITING_STOCK_TIMEOUT_HOURS, default 72h) the cycle is auto-skipped, the
   * buyer is told nothing was charged or substituted, and the vendor is told.
   */
  async expireStockTimeouts(): Promise<{ configuredHours: number; skipped: number }> {
    const row = await prisma.adminPlatformSetting.findUnique({ where: { key: AWAITING_STOCK_TIMEOUT_SETTING_KEY } });
    const hours = row && Number.isFinite(row.value) && row.value > 0 ? row.value : DEFAULT_AWAITING_STOCK_TIMEOUT_HOURS;
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const stale = await prisma.renewal.findMany({
      where: { status: "AWAITING_STOCK", OR: [{ awaitingStockSince: { lte: cutoff } }, { awaitingStockSince: null, createdAt: { lte: cutoff } }] },
      include: { subscription: { include: { offer: { select: { title: true, vendor: { select: { userId: true, storeName: true } } } } } } },
      take: 200,
    });
    let skipped = 0;
    for (const renewal of stale) {
      const claim = await prisma.renewal.updateMany({ where: { id: renewal.id, status: "AWAITING_STOCK" }, data: { status: "SKIPPED" } });
      if (claim.count !== 1) continue;
      skipped++;
      await prisma.buyerSubscription.updateMany({
        where: { id: renewal.subscriptionId, nextRenewalAt: renewal.cycleDate },
        data: { nextRenewalAt: nextCycleDate(renewal.subscription.frequency, renewal.cycleDate) },
      });
      await prisma.subscriptionActionHistory.create({ data: { subscriptionId: renewal.subscriptionId, action: "stock_timeout_skipped", metadata: { renewalId: renewal.id, timeoutHours: hours } as any } });
      await recordAudit({
        actorId: SYSTEM_CRON_ACTOR,
        action: "renewal.stock_timeout_skipped",
        entityType: "Renewal",
        entityId: renewal.id,
        metadata: { subscriptionId: renewal.subscriptionId, timeoutHours: hours },
      });
      const storeName = renewal.subscription.offer.vendor.storeName;
      await notificationsService.enqueue({
        userId: renewal.subscription.buyerId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Your Foodstuffs Subscription delivery was skipped",
        body: `${storeName} couldn't confirm stock in time, so this delivery was skipped. You have not been charged and nothing was substituted. Your next delivery stays on schedule.`,
        data: { type: "subscription_update", event: "stock_timeout_skipped", renewalId: renewal.id, subscriptionId: renewal.subscriptionId },
      }).catch(() => {});
      await notificationsService.enqueue({
        userId: renewal.subscription.offer.vendor.userId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Foodstuffs Subscription cycle skipped",
        body: `A renewal for "${renewal.subscription.offer.title}" was skipped because stock wasn't confirmed within ${hours} hours. Confirm stock promptly next time to keep your subscribers.`,
        data: { type: "subscription_update", event: "vendor_stock_timeout", renewalId: renewal.id },
      }).catch(() => {});
    }
    return { configuredHours: hours, skipped };
  },

  /**
   * Advance heads-up (about 24h before the cycle is prepared) when the live
   * price of anything in the basket is higher than what the buyer last paid.
   * Informational only: the existing approval gate (above the buyer's limit)
   * is unchanged and still decides whether approval is required. Deduped per
   * subscription + cycle date at the DB level.
   */
  async sendPriceChangeNotices(): Promise<number> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + PRICE_NOTICE_WINDOW_HOURS * 60 * 60 * 1000);
    const upcoming = await prisma.buyerSubscription.findMany({
      where: { status: "ACTIVE", nextRenewalAt: { gt: now, lte: windowEnd }, offer: { renewalsPaused: false } },
      include: { items: { include: { product: true } }, offer: { select: { discountPercent: true, title: true, vendor: { select: { storeName: true } } } } },
      take: 500,
    });
    let sent = 0;
    for (const sub of upcoming) {
      if (!sub.nextRenewalAt) continue;
      const discount = sub.offer.discountPercent ?? 0;
      const last = await prisma.renewalItem.findMany({
        where: { renewal: { subscriptionId: sub.id, status: { in: ["PAID", "ORDER_CREATED"] } } },
        orderBy: { createdAt: "desc" },
      });
      const lastByProduct = new Map<string, number>();
      for (const item of last) if (!lastByProduct.has(item.productId)) lastByProduct.set(item.productId, item.currentUnitPrice);
      const changes: string[] = [];
      let needsApproval = false;
      const limitBps = sub.priceChangeApprovalLimitBps ?? PRICE_CHANGE_APPROVAL_DEFAULT_BPS;
      for (const item of sub.items) {
        const before = lastByProduct.get(item.productId);
        if (before == null || before <= 0) continue;
        const now_ = discount > 0 ? Math.round(item.product.priceInCents * (1 - discount / 100)) : item.product.priceInCents;
        if (now_ <= before) continue;
        if (((now_ - before) / before) * 10000 > limitBps) needsApproval = true;
        const cur = item.product.currency;
        changes.push(`${item.product.title}: ${(before / 100).toFixed(2)} to ${(now_ / 100).toFixed(2)} ${cur}`);
      }
      if (changes.length === 0) continue;
      const dedupeKey = `PRICE_NOTICE:${sub.id}:${sub.nextRenewalAt.toISOString().slice(0, 10)}`;
      if (await prisma.notification.findUnique({ where: { dedupeKey }, select: { id: true } })) continue;
      await notificationsService.enqueue({
        userId: sub.buyerId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Price change on your Foodstuffs Subscription",
        body: `${sub.offer.vendor.storeName} has a new price on your next delivery (${sub.nextRenewalAt.toDateString()}). ${changes.join("; ")}.${needsApproval ? " You will be asked to approve it before you are charged." : ""}`,
        data: { type: "subscription_update", event: "price_change_notice", subscriptionId: sub.id, approvalRequired: needsApproval },
        dedupeKey,
      });
      sent++;
    }
    return sent;
  },

  /**
   * Automatic payment-recovery schedule. PAYMENT_FAILED renewals whose
   * nextRetryAt has passed are retried through the SAME attemptPayment() (atomic
   * claim + per-attempt Stripe idempotency key), so this can never double-charge.
   * Once MAX_PAYMENT_ATTEMPTS are used the renewal is finalised instead.
   */
  async retryDueFailedPayments(): Promise<{ retried: number; finalised: number }> {
    const due = await prisma.renewal.findMany({
      where: { status: "PAYMENT_FAILED", nextRetryAt: { lte: new Date() }, subscription: { status: { in: ["ACTIVE", "PAYMENT_ATTENTION"] } } },
      select: { id: true },
      take: 200,
    });
    let retried = 0;
    let finalised = 0;
    for (const { id } of due) {
      try {
        const attempts = await prisma.subscriptionPaymentAttempt.count({ where: { renewalId: id } });
        if (attempts >= MAX_PAYMENT_ATTEMPTS) {
          if (await this.cancelAfterRetriesExhausted(id)) finalised++;
          continue;
        }
        await this.attemptPayment(id);
        retried++;
      } catch (err) {
        logger.error("Renewal payment retry failed", { renewalId: id, error: String(err) });
      }
    }
    return { retried, finalised };
  },

  async retryPayment(buyerId: string, renewalId: string) {
    const renewal = await prisma.renewal.findUnique({ where: { id: renewalId }, include: { subscription: true } });
    if (!renewal || renewal.subscription.buyerId !== buyerId) throw new AppError("Renewal not found", 404);
    if (renewal.status !== "PAYMENT_FAILED") throw new AppError("This renewal is not in a retryable state", 409);
    return this.attemptPayment(renewalId);
  },

  /**
   * RD-08 (retry-payment slice — the only sub-part of RD-08 approved for
   * this phase; approve/deny price-change-on-buyer's-behalf, force-cancel,
   * and contact-buyer remain BLOCKED-CLIENT-DECISION, not built here).
   *
   * Admin remediation for a stuck PAYMENT_FAILED renewal — this is
   * deliberately just a third caller of the same attemptPayment() every
   * other path already uses (buyer-initiated retryPayment, cron sweep):
   * no separate charge logic, no bypass of the atomic claim / Stripe
   * idempotency key that already makes attemptPayment() safe against
   * concurrent/duplicate triggers. No ownership check (unlike
   * retryPayment) since an admin can act on any buyer's renewal — route-
   * level admin permission is the authorization boundary here.
   */
  async adminRetryPayment(renewalId: string) {
    const renewal = await prisma.renewal.findUnique({ where: { id: renewalId } });
    if (!renewal) throw new AppError("Renewal not found", 404);
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

    // Read back the fee actually resolved and CHARGED at attemptPayment()
    // time — never re-derive it here. Re-querying DeliveryZone fresh at
    // this point risked recording a different fee than what Stripe was
    // actually charged (e.g. an admin edits/removes a zone in the window
    // between charge and conversion), and previously defaulted to £0
    // whenever no zone matched at all, silently understating what a
    // DELIVERY-fulfilment renewal owed.
    const deliveryFee = renewal.deliveryFeeAmount ?? 0;
    const zoneId = renewal.deliveryZoneId;

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
          deliveryZoneId: zoneId,
          deliveryAddress: `${renewal.subscription.deliveryAddress.line1}, ${renewal.subscription.deliveryAddress.city}, ${renewal.subscription.deliveryAddress.country}`,
          notes: "Foodstuffs Subscription renewal",
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
          description: `Foodstuffs Subscription renewal for order ${order.orderNumber}`,
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

    eventsService.emit({
      name: EVENT_NAMES.order_generated, actorType: "system", entityType: "Order", entityId: order.id,
      secondaryEntities: { renewalId, subscriptionId: renewal.subscriptionId }, source: "renewal_paid", amountMinor: totalAmount, currency: renewal.currency,
      payload: { eventKey: `order_generated:${renewalId}`, renewalId, subscriptionId: renewal.subscriptionId, orderNumber: order.orderNumber },
    });
    await notifySubscriptionEvent(renewal.subscription.buyerId, "order_created", renewalId, renewal.subscriptionId, order.orderNumber);
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
    if (vendor) {
      await notificationsService.enqueue({
        userId: vendor.userId,
        type: "SUBSCRIPTION_UPDATE",
        title: "Foodstuffs Subscription renewal paid",
        body: `Order ${order.orderNumber} was created from a subscription renewal.`,
        data: { type: "subscription_update", event: "vendor_renewal_paid", orderNumber: order.orderNumber },
      });
    }
    return order;
  },

  // ─── Admin actions ────────────────────────────────────────────────────

  /**
   * Admin forced cancellation — Final Client Decision 2.
   *
   * May only be used as an exceptional action for support, fraud, compliance,
   * or safety reasons. Required: reason + internal note.
   *
   * Cancels ONLY future unpaid renewals (SCHEDULED/AWAITING_STOCK/
   * AWAITING_PRICE_APPROVAL/READY_FOR_PAYMENT). Never cancels, alters, or
   * refunds an already-paid or dispatched order. Backend enforces this —
   * not just the frontend.
   *
   * Notifies both buyer and vendor.
   */
  async adminForceCancel(
    adminId: string,
    subscriptionId: string,
    reason: string,
    internalNote?: string,
    request?: Request,
  ): Promise<{ subscription: unknown; cancelledRenewals: number }> {
    if (!reason?.trim()) throw new AppError("A reason is required for admin forced cancellation", 400);
    if (reason.trim().length < 5) throw new AppError("A reason of at least 5 characters is required", 400);
    internalNote = internalNote?.trim() ? internalNote : reason;

    const sub = await prisma.buyerSubscription.findUnique({
      where: { id: subscriptionId },
      include: {
        offer: { include: { vendor: { select: { id: true, userId: true, storeName: true } } } },
        buyer: { select: { id: true, name: true } },
      },
    });
    if (!sub) throw new AppError("Subscription not found", 404);
    if (sub.status === "CANCELLED") throw new AppError("Subscription is already cancelled", 409);

    // Cancel future unpaid renewals ONLY — spec §6.7 + Decision 2.
    const { count: cancelledRenewals } = await prisma.renewal.updateMany({
      where: {
        subscriptionId,
        status: { in: ["SCHEDULED", "AWAITING_STOCK", "AWAITING_PRICE_APPROVAL", "READY_FOR_PAYMENT", "PAYMENT_FAILED"] },
      },
      data: { status: "CANCELLED", cancelledAt: new Date(), nextRetryAt: null },
    });

    const before = { status: sub.status };
    const subscription = await prisma.buyerSubscription.update({
      where: { id: subscriptionId },
      data: { status: "CANCELLED", cancelledAt: new Date(), nextRenewalAt: null, cancelReason: reason.trim().slice(0, 300) },
    });

    await recordAudit({
      actorId: adminId,
      action: "subscription.admin_force_cancel",
      entityType: "BuyerSubscription",
      entityId: subscriptionId,
      beforeState: before,
      afterState: { status: "CANCELLED", cancelledRenewals, reason, internalNote },
      reason: reason.trim(),
      request,
    });
    await recordAction(subscriptionId, "admin_cancelled", adminId, { reason: reason.trim() });

    // Buyer notification.
    await notificationsService.enqueue({
      userId: sub.buyer.id,
      type: "SUBSCRIPTION_UPDATE",
      title: "Your Foodstuffs Subscription has been cancelled",
      body: `Your Foodstuffs Subscription has been cancelled by Eki support. Only future unprocessed deliveries are affected. Reason: ${reason}.`,
      data: { type: "subscription_update", event: "admin_force_cancelled", subscriptionId },
    }).catch(() => { /* non-blocking */ });

    // Vendor notification.
    await notificationsService.enqueue({
      userId: sub.offer.vendor.userId,
      type: "SUBSCRIPTION_UPDATE",
      title: "Subscription cancelled by admin",
      body: `A subscription for your Foodstuffs Subscription offer has been cancelled by Eki support. Only future unprocessed renewals are affected.`,
      data: { type: "subscription_update", event: "admin_force_cancelled", subscriptionId },
    }).catch(() => { /* non-blocking */ });

    return { subscription, cancelledRenewals };
  },

  /**
   * Admin resend price-change notification — Decision 2.
   * Resends the AWAITING_PRICE_APPROVAL notification to the buyer without
   * changing any state. Does not accept on buyer's behalf.
   */
  async adminResendPriceChangeNotification(adminId: string, renewalId: string): Promise<void> {
    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      include: { subscription: { select: { buyerId: true, id: true } } },
    });
    if (!renewal) throw new AppError("Renewal not found", 404);
    if (renewal.status !== "AWAITING_PRICE_APPROVAL") {
      throw new AppError("This renewal is not awaiting price approval", 409);
    }

    await notifySubscriptionEvent(renewal.subscription.buyerId, "price_approval_required", renewalId, renewal.subscription.id);

    await recordAudit({
      actorId: adminId,
      action: "renewal.admin_resend_price_notification",
      entityType: "Renewal",
      entityId: renewalId,
      afterState: { action: "resent_price_approval_notification" },
    });
  },

  /**
   * Admin cancel invalid price-change request — Decision 2.
   * Allows admin to void an erroneous vendor price-change request, resetting
   * the renewal to SCHEDULED so it proceeds at the original price.
   */
  async adminCancelInvalidPriceChange(adminId: string, renewalId: string, reason: string): Promise<unknown> {
    if (!reason?.trim()) throw new AppError("A reason is required", 400);
    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      include: { subscription: { select: { buyerId: true, id: true } } },
    });
    if (!renewal) throw new AppError("Renewal not found", 404);
    if (renewal.status !== "AWAITING_PRICE_APPROVAL") {
      throw new AppError("This renewal is not awaiting price approval", 409);
    }

    const before = { status: renewal.status };
    const updated = await prisma.renewal.update({
      where: { id: renewalId },
      // Disconnect the PriceChangeRequest — the row is kept for audit purposes
      // but unlinked from this renewal so it no longer drives AWAITING_PRICE_APPROVAL.
      data: { status: "SCHEDULED", priceChangeRequest: { disconnect: true } },
    });

    await recordAudit({
      actorId: adminId,
      action: "renewal.admin_cancel_price_change",
      entityType: "Renewal",
      entityId: renewalId,
      beforeState: before,
      afterState: { status: "SCHEDULED", reason },
    });

    // Notify buyer that the price change was voided.
    await notificationsService.enqueue({
      userId: renewal.subscription.buyerId,
      type: "SUBSCRIPTION_UPDATE",
      title: "Price change cancelled",
      body: "An upcoming price change on your Foodstuffs Subscription was cancelled by Eki support. Your delivery will proceed at the original price.",
      data: { type: "subscription_update", event: "admin_price_change_cancelled", renewalId, subscriptionId: renewal.subscription.id },
    }).catch(() => { /* non-blocking */ });

    return updated;
  },

  /**
   * Admin skip renewal where policy permits — Decision 2.
   * Skips a specific upcoming renewal. Requires a reason and audit entry.
   */
  async adminSkipRenewal(adminId: string, renewalId: string, reason: string): Promise<unknown> {
    if (!reason?.trim()) throw new AppError("A reason is required", 400);
    const renewal = await prisma.renewal.findUnique({
      where: { id: renewalId },
      include: { subscription: { select: { buyerId: true, id: true, frequency: true } } },
    });
    if (!renewal) throw new AppError("Renewal not found", 404);
    const skippable = ["SCHEDULED", "AWAITING_STOCK", "AWAITING_PRICE_APPROVAL", "READY_FOR_PAYMENT"];
    if (!skippable.includes(renewal.status)) {
      throw new AppError("This renewal cannot be skipped — it is already processing, paid, or completed", 409);
    }

    const before = { status: renewal.status };
    const updated = await prisma.renewal.update({
      where: { id: renewalId },
      data: { status: "SKIPPED" },
    });

    // Advance nextRenewalAt on the parent subscription.
    await prisma.buyerSubscription.update({
      where: { id: renewal.subscriptionId },
      data: { nextRenewalAt: nextCycleDate(renewal.subscription.frequency, renewal.cycleDate) },
    });

    await recordAudit({
      actorId: adminId,
      action: "renewal.admin_skip",
      entityType: "Renewal",
      entityId: renewalId,
      beforeState: before,
      afterState: { status: "SKIPPED", reason },
    });

    return updated;
  },

  /**
   * Admin escalation — Regular Delivery Admin, approved client requirement.
   * Flags a stuck exception (AWAITING_PRICE_APPROVAL / PAYMENT_FAILED /
   * AWAITING_STOCK) for higher-tier support attention. This is an internal
   * tracking action, not a state transition on the renewal itself and not a
   * buyer-facing notification — "contact buyer" is the separate action for
   * that. No participant-facing case entity exists for Regular Delivery
   * (unlike Community Buy's CommunityBuySupportCase), so escalation state
   * lives directly on the Renewal, mirroring CampaignRefund's escalation
   * fields exactly.
   *
   * Idempotent by design: mirrors campaignContributionsService.escalateRefund()'s
   * atomic-claim pattern. A reload/re-click, or two concurrent requests,
   * both resolve to the SAME escalation (one audit entry, not two) — the
   * loser of the race just reads back what the winner wrote.
   */
  async adminEscalate(adminId: string, renewalId: string, reason: string): Promise<unknown> {
    if (!reason?.trim()) throw new AppError("A reason is required", 400);
    const renewal = await prisma.renewal.findUnique({ where: { id: renewalId } });
    if (!renewal) throw new AppError("Renewal not found", 404);

    const escalatable = ["AWAITING_PRICE_APPROVAL", "PAYMENT_FAILED", "AWAITING_STOCK"];
    if (!escalatable.includes(renewal.status)) {
      throw new AppError("This renewal is not in a state that can be escalated", 409);
    }

    const claim = await prisma.renewal.updateMany({
      where: { id: renewalId, escalated: false },
      data: { escalated: true, escalatedAt: new Date(), escalatedById: adminId, escalatedReason: reason.trim() },
    });

    const updated = await prisma.renewal.findUniqueOrThrow({ where: { id: renewalId } });

    if (claim.count > 0) {
      await recordAudit({
        actorId: adminId,
        action: "renewal.admin_escalate",
        entityType: "Renewal",
        entityId: renewalId,
        beforeState: { status: renewal.status, escalated: false },
        afterState: { status: updated.status, escalated: true, reason: reason.trim() },
      });
    }

    return updated;
  },
};

async function notifySubscriptionEvent(
  buyerId: string,
  event: string,
  renewalId: string,
  subscriptionId: string,
  orderNumber?: string,
  extra?: { retryAt?: Date; finalAttempt?: boolean; attempt?: number },
) {
  const retryText = extra?.retryAt ? extra.retryAt.toDateString() : null;
  const titles: Record<string, string> = {
    price_approval_required: "Price change needs your approval",
    payment_failed: extra?.finalAttempt ? "Last chance: update your payment method" : "Your Foodstuffs Subscription payment failed",
    renewal_cancelled: "Your Foodstuffs Subscription is paused",
    price_approval_expired: "Your Foodstuffs Subscription delivery was skipped",
    order_created: "Your Foodstuffs Subscription order was created",
  };
  const bodies: Record<string, string> = {
    price_approval_required: "Review the updated price on your upcoming delivery.",
    payment_failed: extra?.finalAttempt
      ? `We couldn't collect payment for your upcoming delivery after ${extra.attempt ?? 3} attempts. Update your payment method or retry in the app by ${retryText ?? "soon"}, otherwise your subscription will be paused.`
      : `We couldn't collect payment for your upcoming delivery. We'll try again on ${retryText ?? "the next scheduled run"}. You can update your payment method or retry now from the app.`,
    renewal_cancelled: "We couldn't collect payment after several attempts, so this delivery was cancelled and your subscription is paused. Update your payment method in the app and resume to restart it.",
    price_approval_expired: "We didn't hear back about the price change in time, so this delivery was skipped.",
    order_created: orderNumber ? `Order ${orderNumber} has been created and is being prepared.` : "Your order was created.",
  };
  const cta = event === "payment_failed" || event === "renewal_cancelled" ? "update_payment_method" : undefined;
  await notificationsService.enqueue({
    userId: buyerId,
    type: "SUBSCRIPTION_UPDATE",
    title: titles[event] ?? "Foodstuffs Subscription update",
    body: bodies[event] ?? "",
    data: { type: "subscription_update", event, renewalId, subscriptionId, ...(cta ? { cta } : {}), ...(retryText ? { nextRetryAt: extra!.retryAt!.toISOString() } : {}) },
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
