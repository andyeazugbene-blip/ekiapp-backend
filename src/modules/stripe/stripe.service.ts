import { NotificationType, PaymentStatus, Prisma } from "@prisma/client";
import type Stripe from "stripe";

import { env } from "../../config/env";
import { logger, serializeError } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { pushNotifications } from "../../lib/push-notifications";
import { stripe } from "../../lib/stripe";
import { notificationsService } from "../notifications/notifications.service";
import { referralsService } from "../referrals/referrals.service";
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

    // ─── Wallet top-up flow ───────────────────────────────────────────────
    if (kind === "wallet_topup") {
      return this.handleWalletTopUpSucceeded(event, paymentIntent);
    }

    // ─── Checkout flow ────────────────────────────────────────────────────
    const checkoutId = paymentIntent.metadata?.checkoutId;
    const buyerId = paymentIntent.metadata?.buyerId;

    if (!checkoutId || !buyerId) {
      logger.warn("Webhook missing checkoutId/buyerId metadata", { eventId: event.id });
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    try {
      return await prisma.$transaction(async (tx) => {
        // Idempotency: insert webhook event
        if (await this.isDuplicate(tx, event.id, event.type, { checkoutId })) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Load checkout
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

        // Already processed? Idempotent return.
        if (checkout.status === PaymentStatus.SUCCEEDED) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Validate buyer
        if (checkout.buyerId !== buyerId) {
          logger.error("Webhook: buyer mismatch", { checkoutId, expected: checkout.buyerId, got: buyerId, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        // Validate currency
        if (checkout.currency.toLowerCase() !== paymentIntent.currency.toLowerCase()) {
          logger.error("Webhook: currency mismatch", { checkoutId, expected: checkout.currency, got: paymentIntent.currency, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        // Validate amount
        if (checkout.totalAmount !== paymentIntent.amount) {
          logger.error("Webhook: amount mismatch", { checkoutId, expected: checkout.totalAmount, got: paymentIntent.amount, eventId: event.id });
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        // Mark checkout SUCCEEDED (conditional)
        const checkoutUpdate = await tx.checkout.updateMany({
          where: { id: checkoutId, status: PaymentStatus.PENDING },
          data: { status: "SUCCEEDED", processedAt: new Date(), stripePaymentIntentId: paymentIntent.id },
        });
        if (checkoutUpdate.count === 0) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Process each vendor order
        for (const order of checkout.orders) {
          if (!order.payment) continue;

          // Mark payment SUCCEEDED
          await tx.payment.updateMany({
            where: { id: order.payment.id, status: PaymentStatus.PENDING },
            data: { status: "SUCCEEDED", processedAt: new Date(), stripePaymentIntentId: paymentIntent.id },
          });

          // Mark order PAID
          await tx.order.updateMany({
            where: { id: order.id, status: "PENDING" },
            data: { status: "PAID" },
          });

          // Credit vendor wallet
          const vendorId = order.vendorId ?? order.items[0]?.vendorId;
          if (vendorId && order.payment.vendorEarningsAmount > 0) {
            const wallet = await tx.wallet.findUnique({ where: { vendorId }, select: { id: true } });
            if (wallet) {
              await tx.walletTransaction.create({
                data: {
                  walletId: wallet.id,
                  vendorId,
                  orderId: order.id,
                  paymentId: order.payment.id,
                  type: "PAYMENT_PENDING_CREDIT",
                  amount: order.payment.vendorEarningsAmount,
                  currency: order.payment.currency,
                  description: `Pending credit for order ${order.id}`,
                },
              });

              await tx.wallet.update({
                where: { id: wallet.id },
                data: { pendingBalance: { increment: order.payment.vendorEarningsAmount } },
              });
            }
          }
        }

        // Clear buyer cart
        await this.clearBuyerCart(tx, buyerId);

        // Mark webhook processed
        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        // Notifications (fire-and-forget)
        this.sendSuccessNotifications(buyerId, checkout.orders);

        // Referral bonus: credit referrer on referred user's first paid order (fire-and-forget)
        referralsService.creditReferralBonusOnFirstOrder(buyerId).catch((err) => {
          logger.error("Referral bonus credit failed", { buyerId, error: String(err) });
        });

        logger.info("Webhook processed: payment_intent.succeeded (multi-vendor)", {
          eventId: event.id, checkoutId, orderCount: checkout.orders.length,
        });

        return { received: true, eventId: event.id, type: event.type };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: payment_intent.succeeded", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
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

  // ─── Payment Failed / Canceled ──────────────────────────────────────────

  private async handleCheckoutSessionCompleted(event: Stripe.Event): Promise<StripeWebhookResult> {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "subscription" || session.metadata?.kind !== "vendor_subscription") {
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    const vendorId = session.metadata.vendorId;
    const plan = session.metadata.plan as "GROWTH" | "PRO" | undefined;
    const stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

    if (!vendorId || !plan || !["GROWTH", "PRO"].includes(plan) || !stripeSubscriptionId) {
      logger.warn("Subscription checkout webhook missing metadata", { eventId: event.id, vendorId, plan });
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

        await tx.vendorSubscription.upsert({
          where: { vendorId },
          update: {
            plan,
            status: "ACTIVE",
            stripeSubscriptionId,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            cancelledAt: null,
          },
          create: {
            vendorId,
            plan,
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
          plan,
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
      if (!vendorId) continue;
      prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } })
        .then((v) => {
          if (v) {
            notificationsService.enqueue({
              userId: v.userId,
              type: NotificationType.BALANCE_CREDITED,
              title: "New order received",
              body: `Order ${order.id} has been paid.`,
              data: { orderId: order.id },
            }).catch(() => {});
            // Push notification to vendor
            pushNotifications.vendorNewOrder(v.userId, order.id);
          }
        }).catch(() => {});
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
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}

export const stripeWebhookService = new StripeWebhookService();
