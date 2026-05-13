import { NotificationType, PaymentStatus, Prisma } from "@prisma/client";
import type Stripe from "stripe";

import { env } from "../../config/env";
import { logger, serializeError } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { notificationsService } from "../notifications/notifications.service";
import { AppError } from "../../shared/errors/app-error";
import type {
  PaymentIntentSucceededMetadata,
  StripeWebhookInput,
  StripeWebhookResult,
} from "./stripe.types";

/**
 * Production-hardened Stripe webhook handler.
 *
 * Idempotency strategy:
 * - WebhookEvent table with unique constraint on stripeEventId
 * - Insert attempt catches P2002 → returns duplicate response
 * - Payment status checked: if already SUCCEEDED, skip (idempotent)
 * - All mutations in a single Prisma transaction
 * - Conditional updates (updateMany with status guards) prevent double-processing
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

  // ─── payment_intent.succeeded ────────────────────────────────────────────

  private async handlePaymentSucceeded(event: Stripe.Event): Promise<StripeWebhookResult> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const metadata = this.parseMetadata(paymentIntent.metadata);

    try {
      return await prisma.$transaction(async (tx) => {
        // Idempotency: insert webhook event (unique on stripeEventId)
        if (await this.isDuplicate(tx, event.id, event.type, metadata)) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Load payment + order
        const payment = await tx.payment.findUnique({
          where: { id: metadata.paymentId },
          select: {
            id: true, orderId: true, amount: true, currency: true,
            status: true, stripePaymentIntentId: true, vendorEarningsAmount: true,
          },
        });
        if (!payment) throw new AppError("Payment not found", 404);

        // Already succeeded? Idempotent return.
        if (payment.status === PaymentStatus.SUCCEEDED) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        const order = await tx.order.findUnique({
          where: { id: metadata.orderId },
          select: { id: true, buyerId: true, status: true, items: { select: { vendorId: true } } },
        });
        if (!order) throw new AppError("Order not found", 404);

        // Validate integrity
        this.validateWebhookIntegrity(payment, order, paymentIntent, metadata);

        // Get vendor wallet
        const wallet = await tx.wallet.findUnique({
          where: { vendorId: metadata.vendorId },
          select: { id: true },
        });
        if (!wallet) throw new AppError("Wallet not found", 404);

        // ─── Conditional updates (prevent double-processing) ───────────────

        // Mark payment SUCCEEDED (only if currently PENDING)
        const paymentUpdate = await tx.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: "SUCCEEDED", processedAt: new Date(), stripePaymentIntentId: paymentIntent.id },
        });
        if (paymentUpdate.count === 0) {
          // Already processed by another webhook delivery
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Mark order PAID (only if currently PENDING)
        await tx.order.updateMany({
          where: { id: order.id, status: "PENDING" },
          data: { status: "PAID" },
        });

        // Credit vendor wallet (pendingBalance only)
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            vendorId: metadata.vendorId,
            orderId: order.id,
            paymentId: payment.id,
            type: "PAYMENT_PENDING_CREDIT",
            amount: payment.vendorEarningsAmount,
            currency: payment.currency,
            description: `Pending credit for order ${order.id}`,
          },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: { pendingBalance: { increment: payment.vendorEarningsAmount } },
        });

        // Clear buyer cart
        await this.clearBuyerCart(tx, metadata.buyerId);

        // Mark webhook processed
        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        // Notifications (non-blocking, outside critical path)
        this.sendSuccessNotifications(metadata, order.id, payment.id, payment.amount, payment.vendorEarningsAmount, payment.currency);

        logger.info("Webhook processed: payment_intent.succeeded", {
          eventId: event.id, paymentId: payment.id, orderId: order.id,
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

  // ─── payment_intent.payment_failed ───────────────────────────────────────

  private async handlePaymentFailed(event: Stripe.Event): Promise<StripeWebhookResult> {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const paymentIdFromMeta = paymentIntent.metadata?.paymentId;
    const orderIdFromMeta = paymentIntent.metadata?.orderId;

    try {
      return await prisma.$transaction(async (tx) => {
        // Idempotency
        if (await this.isDuplicate(tx, event.id, event.type, { paymentId: paymentIdFromMeta, orderId: orderIdFromMeta })) {
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Find payment by Stripe PI ID
        const payment = await tx.payment.findFirst({
          where: { stripePaymentIntentId: paymentIntent.id },
          select: { id: true, orderId: true, status: true },
        });

        if (!payment) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        // Already succeeded — ignore late failure
        if (payment.status === PaymentStatus.SUCCEEDED) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, ignored: true, eventId: event.id, type: event.type };
        }

        // Already failed — idempotent
        if (payment.status === PaymentStatus.FAILED) {
          await this.markEventIgnored(tx, event.id);
          return { received: true, duplicate: true, eventId: event.id, type: event.type };
        }

        // Mark payment FAILED (conditional: only if PENDING)
        const failUpdate = await tx.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, processedAt: new Date() },
        });

        if (failUpdate.count > 0) {
          // Mark order FAILED
          await tx.order.updateMany({
            where: { id: payment.orderId, status: "PENDING" },
            data: { status: "FAILED" },
          });

          // Restore stock atomically
          const orderItems = await tx.orderItem.findMany({
            where: { orderId: payment.orderId },
            select: { productId: true, quantity: true },
          });
          for (const item of orderItems) {
            await tx.product.update({
              where: { id: item.productId },
              data: { stock: { increment: item.quantity } },
            });
          }
        }

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });

        logger.info("Webhook processed: payment_intent.payment_failed", {
          eventId: event.id, paymentId: payment.id, orderId: payment.orderId,
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

  private async isDuplicate(
    tx: Prisma.TransactionClient,
    eventId: string,
    eventType: string,
    meta: { paymentId?: string | null; orderId?: string | null },
  ): Promise<boolean> {
    try {
      await tx.webhookEvent.create({
        data: {
          stripeEventId: eventId,
          eventType,
          paymentId: meta.paymentId ?? null,
          orderId: meta.orderId ?? null,
          status: "PROCESSING",
        },
      });
      return false;
    } catch (error) {
      if (this.isUniqueConstraintError(error)) return true;
      throw error;
    }
  }

  private async markEventIgnored(tx: Prisma.TransactionClient, eventId: string): Promise<void> {
    await tx.webhookEvent.updateMany({
      where: { stripeEventId: eventId },
      data: { status: "IGNORED", processedAt: new Date() },
    });
  }

  private validateWebhookIntegrity(
    payment: { orderId: string; amount: number; currency: string; stripePaymentIntentId: string | null },
    order: { id: string; buyerId: string; items: { vendorId: string }[] },
    paymentIntent: Stripe.PaymentIntent,
    metadata: PaymentIntentSucceededMetadata,
  ): void {
    if (payment.orderId !== order.id) throw new AppError("Payment/order mismatch", 400);
    if (order.buyerId !== metadata.buyerId) throw new AppError("Buyer mismatch", 400);
    if (payment.amount !== paymentIntent.amount) throw new AppError("Amount mismatch", 400);
    if (payment.currency.toLowerCase() !== paymentIntent.currency?.toLowerCase()) throw new AppError("Currency mismatch", 400);
    if (payment.stripePaymentIntentId && payment.stripePaymentIntentId !== paymentIntent.id) throw new AppError("PI mismatch", 400);

    const vendorIds = [...new Set(order.items.map((i) => i.vendorId))];
    if (vendorIds.length !== 1 || vendorIds[0] !== metadata.vendorId) throw new AppError("Vendor mismatch", 400);
  }

  private sendSuccessNotifications(
    metadata: PaymentIntentSucceededMetadata,
    orderId: string,
    paymentId: string,
    amount: number,
    vendorEarnings: number,
    currency: string,
  ): void {
    // Fire-and-forget — notifications must not break the webhook response
    notificationsService.enqueue({
      userId: metadata.buyerId,
      type: NotificationType.ORDER_PAID,
      title: "Your order has been paid",
      body: `Order ${orderId} has been successfully paid.`,
      data: { orderId, paymentId, amount },
    }).catch(() => {});

    prisma.vendor.findUnique({ where: { id: metadata.vendorId }, select: { userId: true } })
      .then((v) => {
        if (v) {
          notificationsService.enqueue({
            userId: v.userId,
            type: NotificationType.BALANCE_CREDITED,
            title: "Pending balance credited",
            body: `Your pending balance was credited for order ${orderId}.`,
            data: { orderId, paymentId, amount: vendorEarnings, currency },
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }

  private async clearBuyerCart(tx: Prisma.TransactionClient, buyerId: string): Promise<void> {
    const cart = await tx.cart.findUnique({ where: { buyerId }, select: { id: true } });
    if (!cart) return;
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    await tx.cart.update({ where: { id: cart.id }, data: { vendorId: null } });
  }

  private constructEvent(input: StripeWebhookInput): Stripe.Event {
    try {
      return stripe.webhooks.constructEvent(input.rawBody, input.signature, env.stripeWebhookSecret);
    } catch (error) {
      logger.warn("Stripe webhook signature verification failed", serializeError(error));
      throw new AppError("Invalid signature", 400);
    }
  }

  private parseMetadata(metadata: Stripe.Metadata): PaymentIntentSucceededMetadata {
    const { orderId, paymentId, buyerId, vendorId } = metadata;
    if (!orderId || !paymentId || !buyerId || !vendorId) {
      throw new AppError("Missing metadata", 400);
    }
    return { orderId, paymentId, buyerId, vendorId };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}

export const stripeWebhookService = new StripeWebhookService();
