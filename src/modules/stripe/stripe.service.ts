import { NotificationType, PaymentStatus, Prisma, SubscriptionPlan } from "@prisma/client";
import type Stripe from "stripe";

import { env } from "../../config/env";
import { logger, serializeError } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { pushNotifications } from "../../lib/push-notifications";
import { stripe } from "../../lib/stripe";
import { notificationsService } from "../notifications/notifications.service";
import { referralsService } from "../referrals/referrals.service";
import { rewardsService } from "../rewards/rewards.service";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
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

    try {
      await prisma.$transaction(async (tx) => {
        if (await this.isDuplicate(tx, event.id, event.type, { checkoutId })) return;

        const checkout = await tx.checkout.findUnique({
          where: { id: checkoutId },
          include: {
            orders: {
              include: {
                items: { select: { vendorId: true } },
                payment: { select: { id: true, status: true, vendorEarningsAmount: true, currency: true } },
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
          }
        }

        paidOrders = checkout.orders.map((o) => ({ id: o.id, vendorId: o.vendorId, items: o.items }));

        await this.clearBuyerCart(tx, buyerId);

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        logger.info("Webhook processed: payment succeeded", {
          eventId: event.id, checkoutId, orderCount: checkout.orders.length,
        });
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: payment processing", { eventId: event.id, ...serializeError(error) });
      throw error;
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
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
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
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            cancelledAt: null,
          },
          create: {
            vendorId,
            plan: sellerPlan.legacyPlan ?? "GROWTH",
            sellerPlanId: sellerPlan.id,
            status: "ACTIVE",
            stripeSubscriptionId,
            currentPeriodStart: now,
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
    // In-app notifications
    notificationsService.enqueue({
      userId: buyerId,
      type: NotificationType.ORDER_PAID,
      title: "Your order has been paid",
      body: `${orders.length} order(s) confirmed.`,
      data: { orderIds: orders.map((o) => o.id) },
    }).catch(() => {});

    // Push notification to buyer
    pushNotifications.orderPaid(buyerId, orders.length);

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
        notificationsService.enqueue({
          userId: vendorInfo.userId,
          type: NotificationType.BALANCE_CREDITED,
          title: "New order received",
          body: `Order ${order.id} has been paid.`,
          data: { orderId: order.id },
        }).catch(() => {});
        pushNotifications.vendorNewOrder(vendorInfo.userId, order.id);
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
      return await prisma.$transaction(async (tx) => {
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

        return { received: true, eventId: event.id, type: event.type };
      }, { isolationLevel: "Serializable" });
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

        // Log dispute for manual review. Chargebacks require human investigation.
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

  private async clearBuyerCart(tx: Prisma.TransactionClient, buyerId: string): Promise<void> {
    const cart = await tx.cart.findUnique({ where: { buyerId }, select: { id: true } });
    if (!cart) return;
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
  }

  private constructEvent(input: StripeWebhookInput): Stripe.Event {
    try {
      return stripe.webhooks.constructEvent(input.rawBody, input.signature, env.stripeWebhookSecret);
    } catch (error) {
      logger.warn("Stripe webhook signature verification failed", serializeError(error));
      throw new AppError("Invalid signature", 400);
    }
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (error as any)?.code === "P2002";
  }
}

export const stripeWebhookService = new StripeWebhookService();
