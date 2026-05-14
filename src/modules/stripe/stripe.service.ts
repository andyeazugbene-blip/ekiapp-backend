import { NotificationType, PaymentStatus, Prisma } from "@prisma/client";
import type Stripe from "stripe";

import { env } from "../../config/env";
import { logger, serializeError } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { pushNotifications } from "../../lib/push-notifications";
import { stripe } from "../../lib/stripe";
import { notificationsService } from "../notifications/notifications.service";
import { AppError } from "../../shared/errors/app-error";
import type { StripeWebhookInput, StripeWebhookResult } from "./stripe.types";

/**
 * Multi-vendor webhook handler.
 *
 * On payment_intent.succeeded:
 * - Find Checkout by stripePaymentIntentId
 * - Mark Checkout SUCCEEDED
 * - For each Order in the checkout:
 *   - Mark order PAID
 *   - Mark payment SUCCEEDED
 *   - Credit vendor wallet (pendingBalance)
 *   - Create wallet ledger entry
 * - Clear buyer cart
 * - Send notifications
 *
 * Idempotency: WebhookEvent unique constraint + conditional status updates.
 */
class StripeWebhookService {
  public async handleWebhook(input: StripeWebhookInput): Promise<StripeWebhookResult> {
    const event = this.constructEvent(input);

    if (event.type === "payment_intent.payment_failed") {
      return this.handlePaymentFailed(event);
    }

    if (event.type !== "payment_intent.succeeded") {
      return { received: true, ignored: true, eventId: event.id, type: event.type };
    }

    return this.handlePaymentSucceeded(event);
  }

  private async handlePaymentSucceeded(event: Stripe.Event): Promise<StripeWebhookResult> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
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
          throw new AppError("Checkout not found", 404);
        }

        // Already processed? Idempotent return.
        if (checkout.status === PaymentStatus.SUCCEEDED) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Validate amount
        if (checkout.totalAmount !== paymentIntent.amount) {
          throw new AppError("Amount mismatch", 400);
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

        logger.info("Webhook processed: payment_intent.succeeded (multi-vendor)", {
          eventId: event.id, checkoutId, orderCount: checkout.orders.length,
        });

        return { received: true, eventId: event.id, type: event.type };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: payment_intent.succeeded", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  private async handlePaymentFailed(event: Stripe.Event): Promise<StripeWebhookResult> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const checkoutId = paymentIntent.metadata?.checkoutId;

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

          // Restore stock
          for (const item of order.items) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } },
            });
          }
        }

        await tx.webhookEvent.update({ where: { stripeEventId: event.id }, data: { status: "PROCESSED", processedAt: new Date() } });

        logger.info("Webhook processed: payment_intent.payment_failed (multi-vendor)", {
          eventId: event.id, checkoutId, orderCount: checkout.orders.length,
        });

        return { received: true, eventId: event.id, type: event.type };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return { received: true, duplicate: true, eventId: event.id, type: event.type };
      }
      logger.error("Webhook failed: payment_intent.payment_failed", { eventId: event.id, ...serializeError(error) });
      throw error;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

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
