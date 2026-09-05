import { NotificationType, PaymentStatus, Prisma, SubscriptionPlan } from "@prisma/client";
import type Stripe from "stripe";

import { env } from "../../config/env";
import { logger, serializeError } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { notificationsService } from "../notifications/notifications.service";
import { referralsService } from "../referrals/referrals.service";
import { rewardsService } from "../rewards/rewards.service";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { stripeIdentityService } from "../verification/stripe-identity.service";
import { communicationService } from "../communications/communication.service";
import { ledgerService } from "../ledger/ledger.service";
import { renewalsService } from "../regular-deliveries/renewals.service";
import { campaignContributionsService } from "../community-buy/campaign-contributions.service";
import { LedgerAccountType, LedgerDirection, LedgerOwnerType } from "@prisma/client";
import { AppError } from "../../shared/errors/app-error";
import type { StripeWebhookInput, StripeWebhookResult } from "./stripe.types";

/**
 * Multi-vendor webhook handler.
 *
 * On payment_intent.succeeded:
 * - If metadata.kind === "wallet_topup": credit buyer wallet (idempotent)
 * - Else: find Checkout, mark SUCCEEDED, mark orders PAID, credit vendor wallets
 *
 * On payment_intent.payment_failed / payment_intent.canceled:
 * - Fail checkout + orders, restore stock, restore wallet deduction
 *
 * Permanent validation errors (amount mismatch, checkout not found, buyer mismatch,
 * currency mismatch) are marked IGNORED and return HTTP 200 to Stripe.
 * Only invalid signatures return 400. Transient DB/server errors return 500.
 *
 * Idempotency: WebhookEvent unique constraint + conditional status updates.
 */
class StripeWebhookService {
  public async handleWebhook(input: StripeWebhookInput): Promise<StripeWebhookResult> {
    const event = this.constructEvent(input);

    if (event.type === "payment_intent.payment_failed") {
      return this.handlePaymentFailedOrCanceled(event);
    }

    if (event.type === "payment_intent.canceled") {
      return this.handlePaymentFailedOrCanceled(event);
    }

    if (event.type === "charge.dispute.created") {
      return this.handleDisputeCreated(event);
    }

    if (event.type === "charge.refunded" || event.type === "charge.refund.updated") {
      return this.handleChargeRefunded(event);
    }

    if (event.type === "checkout.session.completed") {
      return this.handleCheckoutSessionCompleted(event);
    }

    if (
      event.type === "identity.verification_session.verified" ||
      event.type === "identity.verification_session.requires_input"
    ) {
      return this.handleIdentityVerification(event);
    }

    if (event.type !== "payment_intent.succeeded") {
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    return this.handlePaymentSucceeded(event);
  }

  private async handlePaymentSucceeded(event: Stripe.Event): Promise<StripeWebhookResult> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const kind = paymentIntent.metadata?.kind;

    if (kind === "wallet_topup") {
      return this.handleWalletTopUpSucceeded(event, paymentIntent);
    }

    if (kind === "gift_card_purchase") {
      return this.handleGiftCardPurchaseSucceeded(event, paymentIntent);
    }

    // Regular Delivery renewals and Community Buy pledges are charged
    // off-session and confirmed synchronously (see attemptPayment() /
    // attemptCharge()) — the success path is normally read directly off
    // that API response, not this webhook. This only matters for the rarer
    // "processing" outcome (a delayed-notification payment method, e.g. a
    // bank debit) that those two flows leave genuinely unresolved: this is
    // the sole path that later confirms it once Stripe knows the outcome.
    if (kind === "regular_delivery_renewal") {
      return this.handleRenewalPaymentResolved(event, paymentIntent, true);
    }

    if (kind === "community_buy_pledge_charge") {
      return this.handlePledgeChargeResolved(event, paymentIntent, true);
    }

    return this.processPaymentSucceeded(event, paymentIntent);
  }

  /**
   * Process a succeeded payment: mark checkout/orders PAID, credit wallet, notify.
   * Shared between payment_intent.succeeded and checkout.session.completed.
   */
  private async processPaymentSucceeded(
    event: Stripe.Event,
    paymentIntent: { id: string; metadata: Record<string, string>; amount: number; currency: string },
  ): Promise<StripeWebhookResult> {
    const checkoutId = paymentIntent.metadata?.checkoutId;
    const buyerId = paymentIntent.metadata?.buyerId;

    if (!checkoutId || !buyerId) {
      logger.warn("Webhook missing checkoutId/buyerId metadata", { eventId: event.id });
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    let paidOrders: { id: string; vendorId: string | null; items: { vendorId: string }[] }[] = [];
    // Captures the transaction's early-exit result (ignored/duplicate) so it
    // actually reaches the caller instead of being silently discarded.
    let earlyResult: StripeWebhookResult | null = null;

    try {
      earlyResult = await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, { checkoutId })) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        const checkout = await tx.checkout.findUnique({
          where: { id: checkoutId },
          include: {
            orders: {
              include: {
                items: { select: { vendorId: true } },
                payment: { select: { id: true, status: true, vendorEarningsAmount: true, platformFeeAmount: true, currency: true } },
              },
            },
          },
        });

        if (!checkout) {
          logger.error("Webhook: checkout not found", { checkoutId, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        if (checkout.status === "SUCCEEDED") {
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        if (checkout.buyerId !== buyerId) {
          logger.error("Webhook: buyer mismatch", { checkoutId, expected: checkout.buyerId, got: buyerId, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        const checkoutMeta = checkout.metadata as { stripeCurrency?: string; walletDeduction?: unknown } | null;
        const expectedStripeCurrency = (checkoutMeta?.stripeCurrency ?? checkout.currency).toLowerCase();
        if (expectedStripeCurrency !== paymentIntent.currency.toLowerCase()) {
          logger.error("Webhook: currency mismatch", { checkoutId, expected: expectedStripeCurrency, got: paymentIntent.currency, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        const rawWalletDeduction = Number(checkoutMeta?.walletDeduction ?? paymentIntent.metadata?.walletDeduction ?? 0);
        const walletDeduction = Number.isFinite(rawWalletDeduction) ? rawWalletDeduction : 0;
        const expectedStripeAmount = Math.max(checkout.totalAmount - walletDeduction, 0);
        if (expectedStripeAmount !== paymentIntent.amount) {
          logger.error("Webhook: amount mismatch", { checkoutId, expected: expectedStripeAmount, checkoutTotal: checkout.totalAmount, walletDeduction, got: paymentIntent.amount, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        const checkoutUpdate = await tx.checkout.updateMany({
          where: { id: checkoutId, status: PaymentStatus.PENDING },
          data: { status: "SUCCEEDED", processedAt: new Date(), stripePaymentIntentId: paymentIntent.id },
        });
        if (checkoutUpdate.count === 0) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        for (const order of checkout.orders) {
          if (!order.payment) continue;

          await tx.payment.updateMany({
            where: { id: order.payment.id, status: PaymentStatus.PENDING },
            data: { status: "SUCCEEDED", processedAt: new Date(), stripePaymentIntentId: paymentIntent.id },
          });

          await tx.order.updateMany({
            where: { id: order.id, status: "PENDING" },
            data: { status: "PAID" },
          });

          const vendorId = order.vendorId ?? order.items[0]?.vendorId;
          if (vendorId && order.payment.vendorEarningsAmount > 0) {
            let w = await tx.wallet.findUnique({ where: { vendorId } });
            if (!w) w = await tx.wallet.create({ data: { vendorId, currency: order.payment.currency } });
            await tx.walletTransaction.create({
              data: { walletId: w.id, vendorId, orderId: order.id, paymentId: order.payment.id,
                type: "PAYMENT_PENDING_CREDIT", amount: order.payment.vendorEarningsAmount,
                currency: order.payment.currency, description: `Pending credit for order ${order.id}` },
            });
            await tx.wallet.update({ where: { id: w.id }, data: { pendingBalance: { increment: order.payment.vendorEarningsAmount } } });

            // Internal ledger (additive — never affects the wallet logic above).
            // Chart-of-accounts mapping is the engineering default pending
            // finance sign-off; see ledger.service.ts.
            await ledgerService.postEntriesSafely(tx, {
              currency: order.payment.currency,
              businessRefType: "Payment",
              businessRefId: order.payment.id,
              providerRef: paymentIntent.id,
              description: `Card payment captured for order ${order.id}`,
              legs: [
                { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: order.payment.vendorEarningsAmount + order.payment.platformFeeAmount },
                { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: vendorId, direction: LedgerDirection.CREDIT, amount: order.payment.vendorEarningsAmount },
                { accountType: LedgerAccountType.PLATFORM_FEE_REVENUE, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: order.payment.platformFeeAmount },
              ],
            });
          }
        }

        paidOrders = checkout.orders.map((o) => ({ id: o.id, vendorId: o.vendorId, items: o.items }));

        await this.clearBuyerCart(tx, buyerId, checkout.currency);

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        logger.info("Webhook processed: payment succeeded", {
          eventId: event.id, checkoutId, orderCount: checkout.orders.length,
        });
        // null = real success; let the caller fall through to fire
        // notifications and referral/reward side effects below.
        return null;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: payment processing", { eventId: event.id, ...serializeError(error) });
      throw error;
    }

    if (earlyResult) {
      return earlyResult;
    }

    // Fire notifications AFTER transaction commits
    if (paidOrders.length > 0) {
      this.sendSuccessNotifications(buyerId, paidOrders);
    }
    referralsService.creditReferralBonusOnFirstOrder(buyerId).catch((err) => {
      logger.error("Referral bonus credit failed", { buyerId, error: String(err) });
    });

    rewardsService.grantCampaignGiftCards(buyerId).catch((err) => {
      logger.error("Campaign gift card grant failed", { buyerId, error: String(err) });
    });

    return { received: true, eventId: event.id, type: event.type };
  }

  // ─── Wallet Top-Up Webhook Handler ──────────────────────────────────────

  private async handleWalletTopUpSucceeded(event: Stripe.Event, paymentIntent: Stripe.PaymentIntent): Promise<StripeWebhookResult> {
    const buyerId = paymentIntent.metadata?.buyerId;

    if (!buyerId) {
      logger.warn("Wallet top-up webhook missing buyerId", { eventId: event.id });
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    try {
      return await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, {})) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Get or create buyer wallet
        let wallet = await tx.buyerWallet.findUnique({ where: { buyerId } });
        if (!wallet) {
          wallet = await tx.buyerWallet.create({
            data: { buyerId, currency: paymentIntent.currency },
          });
        }

        // Idempotency: unique constraint on [paymentIntentId, type] prevents double credit
        await tx.buyerWalletTransaction.create({
          data: {
            walletId: wallet.id,
            buyerId,
            type: "TOP_UP",
            amount: paymentIntent.amount,
            currency: paymentIntent.currency,
            description: `Wallet top-up of ${paymentIntent.amount}`,
            paymentIntentId: paymentIntent.id,
          },
        });

        await tx.buyerWallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: paymentIntent.amount } },
        });

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        logger.info("Webhook processed: wallet_topup succeeded", {
          eventId: event.id, buyerId, amount: paymentIntent.amount,
        });

        return { received: true, eventId: event.id, type: event.type };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: wallet_topup", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  // ─── Gift Card Purchase Webhook Handler ───────────────────────────────

  private async handleGiftCardPurchaseSucceeded(event: Stripe.Event, paymentIntent: Stripe.PaymentIntent): Promise<StripeWebhookResult> {
    const purchasedGiftCardId = paymentIntent.metadata?.purchasedGiftCardId;
    const buyerId = paymentIntent.metadata?.buyerId;

    if (!purchasedGiftCardId || !buyerId) {
      logger.warn("Gift card purchase webhook missing metadata", { eventId: event.id });
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    try {
      return await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, { orderId: purchasedGiftCardId })) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Mark the purchased gift card as completed (payment confirmed)
        const existing = await tx.purchasedGiftCard.findUnique({
          where: { id: purchasedGiftCardId },
          select: { stripePaymentIntentId: true },
        });

        if (!existing) {
          logger.error("Gift card purchase: purchased record not found", { purchasedGiftCardId, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        logger.info("Webhook processed: gift_card_purchase succeeded", {
          eventId: event.id, buyerId, purchasedGiftCardId,
        });

        return { received: true, eventId: event.id, type: event.type };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: gift_card_purchase", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  // ─── Regular Delivery Renewal / Community Buy Pledge — "processing" resolution ──

  /**
   * Resolves a Regular Delivery renewal charge that attemptPayment() left
   * as Stripe status "processing" (a delayed-notification payment method).
   * The synchronous confirm() call already handles every other outcome —
   * this is purely the async follow-up for that one case, gated by the
   * same WebhookEvent idempotency key as every other handler here.
   */
  private async handleRenewalPaymentResolved(event: Stripe.Event, paymentIntent: Stripe.PaymentIntent, succeeded: boolean): Promise<StripeWebhookResult> {
    const renewalId = paymentIntent.metadata?.renewalId;
    if (!renewalId) {
      logger.warn("Renewal payment webhook missing renewalId", { eventId: event.id });
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    try {
      const isDup = await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, {})) return true;
        await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
        return false;
      }, { isolationLevel: "Serializable" });

      if (isDup) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }

      const outcome = await renewalsService.resolveProcessingPayment(
        renewalId,
        paymentIntent.id,
        succeeded,
        succeeded ? undefined : "Payment failed after processing",
      );

      logger.info("Webhook processed: regular_delivery_renewal resolved", {
        eventId: event.id, renewalId, succeeded, handled: outcome.handled,
      });
      return { received: true, eventId: event.id, type: event.type };
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: regular_delivery_renewal resolution", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  /**
   * Resolves a Community Buy pledge charge that attemptCharge() left as
   * Stripe status "processing" — the pledge equivalent of
   * handleRenewalPaymentResolved above.
   */
  private async handlePledgeChargeResolved(event: Stripe.Event, paymentIntent: Stripe.PaymentIntent, succeeded: boolean): Promise<StripeWebhookResult> {
    const contributionId = paymentIntent.metadata?.contributionId;
    if (!contributionId) {
      logger.warn("Pledge charge webhook missing contributionId", { eventId: event.id });
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    try {
      const isDup = await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, {})) return true;
        await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
        return false;
      }, { isolationLevel: "Serializable" });

      if (isDup) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }

      const outcome = await campaignContributionsService.resolveProcessingCharge(
        contributionId,
        paymentIntent.id,
        succeeded,
        succeeded ? undefined : "Payment failed after processing",
      );

      logger.info("Webhook processed: community_buy_pledge_charge resolved", {
        eventId: event.id, contributionId, succeeded, handled: outcome.handled,
      });
      return { received: true, eventId: event.id, type: event.type };
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: community_buy_pledge_charge resolution", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  // ─── Payment Failed / Canceled ──────────────────────────────────────────

  private async handleCheckoutSessionCompleted(event: Stripe.Event): Promise<StripeWebhookResult> {
    const session = event.data.object as Stripe.Checkout.Session;

    // Public store checkout: look up checkoutId from session metadata and process
    if (session.metadata?.kind === "public_store_checkout") {
      const checkoutId = session.metadata.checkoutId;
      const buyerId = session.metadata.buyerId;

      if (!checkoutId || !buyerId) {
        logger.warn("Public store checkout session missing metadata", { eventId: event.id, checkoutId, buyerId });
        return { received: true, ignored: true, eventId: event.id, type: event.type };
      }

      logger.info("Processing public store checkout session", {
        eventId: event.id, checkoutId, orderNumber: session.metadata.orderNumber,
      });

      // Process via the same path as payment_intent.succeeded
      const paymentIntent = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;

      // Create a fake payment intent object with the metadata
      const piLike = {
        id: paymentIntent ?? "checkout_session",
        metadata: {
          checkoutId,
          buyerId,
          walletDeduction: "0",
          stripeCurrency: (session.currency ?? "").toLowerCase(),
          ...session.metadata,
        },
        amount: session.amount_total ?? 0,
        currency: session.currency ?? "eur",
      } as unknown as Stripe.PaymentIntent;

      try {
        return this.processPaymentSucceeded(event, piLike);
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }
        logger.error("Webhook failed: public store checkout", { eventId: event.id, ...serializeError(error) });
        throw error;
      }
    }

    // Vendor subscription checkout
    if (session.mode !== "subscription" || session.metadata?.kind !== "vendor_subscription") {
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    const vendorId = session.metadata.vendorId;
    const sellerPlanId = session.metadata.sellerPlanId;
    const sellerPlanSlug = session.metadata.sellerPlanSlug ?? session.metadata.plan;
    const stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

    if (!vendorId || !sellerPlanSlug || !stripeSubscriptionId) {
      logger.warn("Subscription checkout webhook missing metadata", { eventId: event.id, vendorId, sellerPlanSlug });
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    try {
      return await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, { orderId: vendorId })) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        const now = new Date();
        let periodStart = now;
        let periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        try {
          const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
          // Billing-period dates live on the subscription item, not the
          // subscription itself, as of the "basil" API version. During a
          // trial, the item's current_period_end is the trial end date.
          const item = stripeSubscription.items.data[0];
          if (item?.current_period_start) {
            periodStart = new Date(item.current_period_start * 1000);
          }
          if (item?.current_period_end) {
            periodEnd = new Date(item.current_period_end * 1000);
          }
        } catch (retrieveError) {
          // Fall back to the estimated monthly period below rather than fail
          // the whole webhook if Stripe is briefly unreachable.
          logger.warn("Could not retrieve Stripe subscription for period dates, using estimate", {
            eventId: event.id,
            stripeSubscriptionId,
            ...serializeError(retrieveError),
          });
        }
        const legacyPlan = sellerPlanSlug.toUpperCase();
        const sellerPlan = await tx.sellerPlan.findFirst({
          where: {
            deletedAt: null,
            OR: [
              ...(sellerPlanId ? [{ id: sellerPlanId }] : []),
              { slug: sellerPlanSlug.toLowerCase() },
              ...(Object.values(SubscriptionPlan).includes(legacyPlan as SubscriptionPlan)
                ? [{ legacyPlan: legacyPlan as SubscriptionPlan }]
                : []),
            ],
          },
        });
        if (!sellerPlan) {
          logger.warn("Subscription checkout webhook plan not found", {
            eventId: event.id,
            vendorId,
            sellerPlanId,
            sellerPlanSlug,
          });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        await tx.vendorSubscription.upsert({
          where: { vendorId },
          update: {
            plan: sellerPlan.legacyPlan ?? "GROWTH",
            sellerPlanId: sellerPlan.id,
            status: "ACTIVE",
            stripeSubscriptionId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelledAt: null,
          },
          create: {
            vendorId,
            plan: sellerPlan.legacyPlan ?? "GROWTH",
            sellerPlanId: sellerPlan.id,
            status: "ACTIVE",
            stripeSubscriptionId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        });

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: now },
        });

        logger.info("Webhook processed: vendor subscription checkout completed", {
          eventId: event.id,
          vendorId,
          sellerPlanId: sellerPlan.id,
          sellerPlanSlug: sellerPlan.slug,
          stripeSubscriptionId,
        });

        return { received: true, eventId: event.id, type: event.type };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: checkout.session.completed", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  private async handlePaymentFailedOrCanceled(event: Stripe.Event): Promise<StripeWebhookResult> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const checkoutId = paymentIntent.metadata?.checkoutId;
    const kind = paymentIntent.metadata?.kind;

    // Wallet top-up canceled/failed: nothing to reverse (wallet was never credited)
    if (kind === "wallet_topup") {
      try {
        return await prisma.$transaction(async (tx) => {
          if (await this.isDuplicate(tx, event.id, event.type, {})) {
            return { received: true, duplicate: true, eventId: event.id, type: event.type };
          }
          await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
          logger.info(`Webhook processed: wallet_topup ${event.type}`, { eventId: event.id });
          return { received: true, eventId: event.id, type: event.type };
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }
        throw error;
      }
    }

    // Regular Delivery renewal / Community Buy pledge left "processing":
    // resolve the still-PENDING attempt to FAILED and re-open retry.
    // (A normal off-session decline never reaches here — it's caught
    // synchronously in attemptPayment()/attemptCharge() — so this only
    // fires for the delayed-payment-method case those flows leave open.)
    if (kind === "regular_delivery_renewal") {
      return this.handleRenewalPaymentResolved(event, paymentIntent, false);
    }

    if (kind === "community_buy_pledge_charge") {
      return this.handlePledgeChargeResolved(event, paymentIntent, false);
    }

    // Gift card purchase canceled/failed: nothing to reverse (payment never completed)
    if (kind === "gift_card_purchase") {
      try {
        return await prisma.$transaction(async (tx) => {
          if (await this.isDuplicate(tx, event.id, event.type, {})) {
            return { received: true, duplicate: true, eventId: event.id, type: event.type };
          }
          await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
          logger.info(`Webhook processed: gift_card_purchase ${event.type}`, { eventId: event.id });
          return { received: true, eventId: event.id, type: event.type };
        }, { isolationLevel: "Serializable" });
      } catch (error) {
        if (this.isUniqueConstraintError(error)) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }
        throw error;
      }
    }

    try {
      return await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, { checkoutId })) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        if (!checkoutId) {
          // Legacy single-order fallback
          const payment = await tx.payment.findFirst({
            where: { stripePaymentIntentId: paymentIntent.id },
            select: { id: true, orderId: true, status: true },
          });
          if (payment && payment.status === PaymentStatus.PENDING) {
            await this.failSingleOrder(tx, payment.id, payment.orderId);
          }
          await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
          return { received: true, eventId: event.id, type: event.type };
        }

        const checkout = await tx.checkout.findUnique({
          where: { id: checkoutId },
          include: { orders: { include: { items: { select: { productId: true, quantity: true } } } } },
        });

        if (!checkout || checkout.status !== PaymentStatus.PENDING) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        // Mark checkout FAILED
        await tx.checkout.updateMany({
          where: { id: checkoutId, status: PaymentStatus.PENDING },
          data: { status: "FAILED", processedAt: new Date() },
        });

        // Fail all orders and restore stock
        for (const order of checkout.orders) {
          await tx.order.updateMany({
            where: { id: order.id, status: "PENDING" },
            data: { status: "FAILED" },
          });

          await tx.payment.updateMany({
            where: { orderId: order.id, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.FAILED, processedAt: new Date() },
          });

          // Restore stock (batched)
          await Promise.all(
            order.items.map((item) =>
              tx.product.update({
                where: { id: item.productId },
                data: { stock: { increment: item.quantity } },
              }),
            ),
          );
        }

        // Restore wallet deduction if any
        await this.restoreWalletDeduction(tx, checkout);

        await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });

        logger.info(`Webhook processed: ${event.type} (multi-vendor)`, {
          eventId: event.id, checkoutId, orderCount: checkout.orders.length,
        });

        return { received: true, eventId: event.id, type: event.type };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error(`Webhook failed: ${event.type}`, { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  // ─── Stripe Identity Verification ─────────────────────────────────────────

  private async handleIdentityVerification(event: Stripe.Event): Promise<StripeWebhookResult> {
    const session = event.data.object as any;

    try {
      await stripeIdentityService.handleVerificationCompleted({
        id: session.id,
        status: session.status,
        last_error: session.last_error ?? null,
        metadata: session.metadata ?? null,
      });
    } catch (error) {
      logger.error("Stripe Identity webhook handler failed", {
        eventId: event.id,
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { received: true, eventId: event.id, type: event.type };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async restoreWalletDeduction(
    tx: Prisma.TransactionClient,
    checkout: { id: string; buyerId: string; metadata: unknown },
  ): Promise<void> {
    const meta = checkout.metadata as { walletDeduction?: number } | null;
    const walletDeduction = meta?.walletDeduction;
    if (!walletDeduction || walletDeduction <= 0) return;

    const wallet = await tx.buyerWallet.findUnique({ where: { buyerId: checkout.buyerId } });
    if (!wallet) return;

    // Idempotent: unique [paymentIntentId, type] won't apply here since this is a refund
    // but we use orderId-based description to keep it traceable
    await tx.buyerWallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: walletDeduction } },
    });

    await tx.buyerWalletTransaction.create({
      data: {
        walletId: wallet.id,
        buyerId: checkout.buyerId,
        type: "REFUND_CREDIT",
        amount: walletDeduction,
        currency: wallet.currency,
        description: `Wallet deduction restored for canceled/failed checkout ${checkout.id}`,
      },
    });
  }

  private async failSingleOrder(tx: Prisma.TransactionClient, paymentId: string, orderId: string): Promise<void> {
    await tx.payment.updateMany({ where: { id: paymentId, status: PaymentStatus.PENDING }, data: { status: PaymentStatus.FAILED, processedAt: new Date() } });
    await tx.order.updateMany({ where: { id: orderId, status: "PENDING" }, data: { status: "FAILED" } });
    const items = await tx.orderItem.findMany({ where: { orderId }, select: { productId: true, quantity: true } });
    for (const item of items) {
      await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
    }
  }

  private async isDuplicate(tx: Prisma.TransactionClient, eventId: string, eventType: string, meta: Record<string, string | null | undefined>): Promise<boolean> {
    try {
      await tx.webhookEvent.create({
        data: { stripeEventId: eventId, eventType, paymentId: meta.paymentId ?? null, orderId: meta.orderId ?? meta.checkoutId ?? null, status: "PROCESSING" },
      });
      return false;
    } catch (error) {
      if (this.isUniqueConstraintError(error)) return true;
      throw error;
    }
  }

  private async markEventIgnored(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
    await tx.webhookEvent.updateMany({ where: { stripeEventId: eventId }, data: { status: "IGNORED", processedAt: new Date() } });
  }

  private sendSuccessNotifications(buyerId: string, orders: { id: string; vendorId: string | null; items: { vendorId: string }[] }[]): void {
    // Fire async work — errors must not propagate
    void this.sendSuccessNotificationsAsync(buyerId, orders);
  }

  private async sendSuccessNotificationsAsync(buyerId: string, orders: { id: string; vendorId: string | null; items: { vendorId: string }[] }[]): Promise<void> {
    // In-app notification + push to buyer (single send — enqueue() already
    // sends the push; a separate pushNotifications.orderPaid() call here
    // previously double-notified the buyer for one payment).
    notificationsService.enqueue({
      userId: buyerId,
      type: NotificationType.ORDER_PAID,
      title: "Order Confirmed! 🎉",
      body: orders.length > 1
        ? `Your ${orders.length} orders have been confirmed.`
        : "Your order has been confirmed.",
      data: { type: "order_paid", orderIds: orders.map((o) => o.id) },
    }).catch(() => {});

    for (const order of orders) {
      const vendorId = order.vendorId ?? order.items[0]?.vendorId;
      if (!vendorId) {
        logger.warn("Order missing vendorId — vendor will NOT be notified", { orderId: order.id });
        continue;
      }

      // Load vendor and buyer info for email (separate queries to avoid Prisma include issues)
      const vendorInfo = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { storeName: true, contactEmail: true, userId: true },
      });

      if (!vendorInfo) continue;

      // ─── Send buyer payment confirmation email ─────────────────────────
      const buyer = await prisma.user.findUnique({
        where: { id: buyerId },
        select: { email: true, name: true },
      });
      if (buyer?.email) {
        try {
          const orderForEmail = await prisma.order.findUnique({
            where: { id: order.id },
            select: { orderNumber: true, totalAmount: true, currency: true, _count: { select: { items: true } } },
          });

          if (orderForEmail) {
            const template = emailTemplates.paymentConfirmation({
              name: buyer.name ?? "Valued Customer",
              email: buyer.email,
              orderNumber: orderForEmail.orderNumber,
              totalAmount: orderForEmail.totalAmount,
              currency: orderForEmail.currency,
              itemCount: orderForEmail._count.items,
              storeName: vendorInfo.storeName ?? "Eki Store",
              storeSupportEmail: vendorInfo.contactEmail ?? undefined,
            });
            await enqueueEmail({
              to: buyer.email,
              subject: template.subject,
              html: template.html,
            });
          }
        } catch (emailError) {
          logger.error("Failed to send buyer payment confirmation email", {
            orderId: order.id,
            buyerId,
            errorMessage: emailError instanceof Error ? emailError.message : String(emailError),
          });
        }
      }

      // ─── Vendor notification ─────────────────────────────────────────
      if (vendorInfo.userId) {
        // Single send — see buyer notification above for why this isn't
        // also followed by a separate pushNotifications.vendorNewOrder() call.
        notificationsService.enqueue({
          userId: vendorInfo.userId,
          type: NotificationType.BALANCE_CREDITED,
          title: "New Order! 🛒",
          body: "You have a new order to process.",
          data: { type: "new_order", orderId: order.id },
        }).catch(() => {});

        // Check vendor first order
        const vendorOrderCount = await prisma.order.count({
          where: { vendorId: order.vendorId, status: { notIn: ["PENDING", "FAILED"] } },
        }).catch(() => 0);
        if (vendorOrderCount === 1) {
          communicationService.send({
            eventKey: "vendor_first_order",
            recipientId: vendorInfo.userId,
            recipientEmail: vendorInfo.contactEmail ?? undefined,
            variables: {
              store_name: vendorInfo.storeName ?? "Your store",
              order_number: order.id,
            },
          }).catch(() => {});
        }
      }

      // Log buyer order confirmed communication
      if (buyer) {
        communicationService.logOnly({
          recipientId: buyerId,
          recipientType: "BUYER",
          eventKey: "buyer_order_confirmed",
          channel: "email",
          title: `Order confirmed: ${order.id}`,
          body: `Payment confirmation email sent to ${buyer.email}`,
        }).catch(() => {});
      }
    }
  }

  // ─── Charge Refunded Handler ──────────────────────────────────────────

  private async handleChargeRefunded(event: Stripe.Event): Promise<StripeWebhookResult> {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;

    if (!paymentIntentId) {
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    try {
      const result = await prisma.$transaction(async (tx): Promise<StripeWebhookResult & { refundedBuyerId?: string; refundedOrderIds?: string[] }> => {
        if (await this.isDuplicate(tx, event.id, event.type, {})) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Find the checkout and orders via payment intent
        const checkout = await tx.checkout.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          include: {
            orders: {
              include: {
                payment: { select: { id: true, vendorEarningsAmount: true, currency: true } },
                items: { select: { productId: true, quantity: true } },
              },
            },
          },
        });

        if (!checkout) {
          // Try single-order lookup
          const payment = await tx.payment.findFirst({
            where: { stripePaymentIntentId: paymentIntentId },
            select: { orderId: true },
          });
          if (payment) {
            await tx.order.updateMany({
              where: { id: payment.orderId, status: { notIn: ["REFUNDED", "CANCELLED"] } },
              data: { status: "REFUNDED" },
            });
          }
          await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });
          return { received: true, eventId: event.id, type: event.type };
        }

        // Reverse vendor wallet credits and mark orders refunded
        for (const order of checkout.orders) {
          // Mark order refunded (conditional — don't re-refund)
          await tx.order.updateMany({
            where: { id: order.id, status: { notIn: ["REFUNDED", "CANCELLED"] } },
            data: { status: "REFUNDED" },
          });

          // Reverse vendor wallet credit if it exists
          if (order.payment) {
            const vendorId = order.vendorId;
            if (vendorId) {
              const existingCredit = await tx.walletTransaction.findFirst({
                where: { orderId: order.id, vendorId, type: "PAYMENT_PENDING_CREDIT" },
              });

              if (existingCredit) {
                const wallet = await tx.wallet.findUnique({ where: { vendorId } });
                if (wallet) {
                  // Debit the pending balance (reverse the credit)
                  await tx.wallet.update({
                    where: { id: wallet.id },
                    data: { pendingBalance: { decrement: existingCredit.amount } },
                  });

                  await tx.walletTransaction.create({
                    data: {
                      walletId: wallet.id,
                      vendorId,
                      orderId: order.id,
                      type: "ADJUSTMENT_DEBIT",
                      amount: -existingCredit.amount,
                      currency: existingCredit.currency,
                      description: `Refund reversal for order ${order.id}`,
                    },
                  });

                  if (order.payment) {
                    await ledgerService.reverseEntries(tx, {
                      businessRefType: "Payment",
                      businessRefId: order.payment.id,
                      providerRef: paymentIntentId,
                      description: `Refund reverses payment capture for order ${order.id}`,
                    }).catch((error) => {
                      logger.error("Ledger reversal failed (non-fatal — refund still proceeds)", {
                        orderId: order.id, errorMessage: error instanceof Error ? error.message : String(error),
                      });
                    });
                  }
                }
              }
            }
          }

          // Restore stock
          for (const item of order.items) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } },
            });
          }
        }

        await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });

        logger.info("Webhook processed: charge.refunded", {
          eventId: event.id, paymentIntentId, orderCount: checkout.orders.length,
        });

        return {
          received: true,
          eventId: event.id,
          type: event.type,
          refundedBuyerId: checkout.buyerId,
          refundedOrderIds: checkout.orders.map((o) => o.id),
        };
      }, { isolationLevel: "Serializable" });

      // Fire AFTER the transaction commits — mirrors sendSuccessNotifications()
      // above. Previously nothing notified the buyer here at all: order
      // status, ledger, vendor wallet reversal and stock all updated
      // correctly, but the buyer had no way to learn their refund actually
      // happened short of manually reopening the order later.
      if (result.refundedBuyerId && result.refundedOrderIds && result.refundedOrderIds.length > 0) {
        notificationsService.enqueue({
          userId: result.refundedBuyerId,
          type: NotificationType.ADMIN_BROADCAST,
          title: "Refund processed",
          body: result.refundedOrderIds.length > 1
            ? `Your refund for ${result.refundedOrderIds.length} orders has been processed.`
            : "Your refund has been processed.",
          data: { type: "order_refunded", orderIds: result.refundedOrderIds },
        }).catch(() => {});
      }

      return result;
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: charge.refunded", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  // ─── Dispute Handler ─────────────────────────────────────────────────────

  private async handleDisputeCreated(event: Stripe.Event): Promise<StripeWebhookResult> {
    const dispute = event.data.object as Stripe.Dispute;
    const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;

    try {
      return await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, {})) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Find related checkout via payment intent
        const checkout = paymentIntentId
          ? await tx.checkout.findUnique({
              where: { stripePaymentIntentId: paymentIntentId },
              select: { id: true, buyerId: true },
            })
          : null;

        // Log dispute for manual review. Chargebacks require human investigation —
        // there is no automated hold/reversal here (that would mean inventing an
        // accounting treatment the client hasn't specified), but a log line alone
        // is easy to miss in production, so this also pages ops the same way
        // escrowHealthService.checkAndAlert() already does for escrow balance risk.
        logger.error("Stripe dispute created — manual review required", {
          eventId: event.id,
          disputeId: dispute.id,
          paymentIntentId,
          checkoutId: checkout?.id ?? null,
          buyerId: checkout?.buyerId ?? null,
          amount: dispute.amount,
          currency: dispute.currency,
          reason: dispute.reason,
          status: dispute.status,
        });
        const opsAlertEmail = process.env.OPS_ALERT_EMAIL;
        if (opsAlertEmail) {
          await enqueueEmail({
            to: opsAlertEmail,
            subject: `⚠️ Stripe dispute opened: ${(dispute.amount / 100).toLocaleString()} ${dispute.currency.toUpperCase()}`,
            html: `
              <h2>Stripe Dispute Alert</h2>
              <p>A chargeback/dispute was opened and requires manual review.</p>
              <ul>
                <li>Dispute ID: ${dispute.id}</li>
                <li>Amount: ${(dispute.amount / 100).toLocaleString()} ${dispute.currency.toUpperCase()}</li>
                <li>Reason: ${dispute.reason}</li>
                <li>Status: ${dispute.status}</li>
                <li>Checkout ID: ${checkout?.id ?? "unknown"}</li>
                <li>Buyer ID: ${checkout?.buyerId ?? "unknown"}</li>
                <li>Payment Intent: ${paymentIntentId ?? "unknown"}</li>
              </ul>
              <p>Respond to this dispute directly in the Stripe Dashboard before its evidence deadline.</p>
            `,
          });
        }

        // Real DB row (architecture doc §15.3 "Chargebacks" queue) — the
        // log line + email above are easy to miss; this is what actually
        // lets an admin open a queue and work the dispute. Upsert on the
        // unique Stripe dispute id so a retried/duplicate delivery of this
        // event can never create a second row for the same chargeback.
        await tx.stripeDispute.upsert({
          where: { stripeDisputeId: dispute.id },
          update: { status: dispute.status },
          create: {
            stripeDisputeId: dispute.id,
            paymentIntentId: paymentIntentId ?? null,
            checkoutId: checkout?.id ?? null,
            buyerId: checkout?.buyerId ?? null,
            amount: dispute.amount,
            currency: dispute.currency,
            reason: dispute.reason,
            status: dispute.status,
          },
        });

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        return { received: true, eventId: event.id, type: event.type };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: charge.dispute.created", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  private async clearBuyerCart(tx: Prisma.TransactionClient, buyerId: string, currency: string): Promise<void> {
    // Carts are per-(buyer, currency) — clear the specific currency-cart
    // this checkout was for, not whichever cart the buyer currently has
    // active (they can differ once a buyer has more than one currency-cart).
    const cart = await tx.cart.findUnique({
      where: { buyerId_currency: { buyerId, currency: currency.toUpperCase() } },
      select: { id: true },
    });
    if (!cart) return;
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
  }

  private constructEvent(input: StripeWebhookInput): Stripe.Event {
    try {
      return stripe.webhooks.constructEvent(input.rawBody, input.signature, env.stripeWebhookSecret);
    } catch (primaryError) {
      if (env.stripeIdentityWebhookSecret) {
        try {
          return stripe.webhooks.constructEvent(input.rawBody, input.signature, env.stripeIdentityWebhookSecret);
        } catch {
          // both secrets failed — fall through
        }
      }
      logger.warn("Stripe webhook signature verification failed", serializeError(primaryError));
      throw new AppError("Invalid signature", 400);
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (error as any)?.code === "P2002";
  }
}

export const stripeWebhookService = new StripeWebhookService();
