import { NotificationType, PaymentStatus, Prisma } from "@prisma/client";
import type Stripe from "stripe";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { notificationsService } from "../notifications/notifications.service";
import { AppError } from "../../shared/errors/app-error";
import type {
  PaymentIntentSucceededMetadata,
  StripeWebhookInput,
  StripeWebhookResult,
} from "./stripe.types";

class StripeWebhookService {
  public async handleWebhook(input: StripeWebhookInput): Promise<StripeWebhookResult> {
    const event = this.constructEvent(input);

    if (event.type !== "payment_intent.succeeded") {
      return {
        received: true,
        ignored: true,
        eventId: event.id,
        type: event.type,
      };
    }

    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const metadata = this.parseSucceededMetadata(paymentIntent.metadata);

    try {
      return await prisma.$transaction(async (tx) => {
        try {
          await tx.webhookEvent.create({
            data: {
              stripeEventId: event.id,
              eventType: event.type,
              paymentId: metadata.paymentId,
              orderId: metadata.orderId,
              status: "PROCESSING",
            },
          });
        } catch (error) {
          if (this.isUniqueConstraintError(error)) {
            console.warn(`Duplicate webhook event ignored: ${event.id}`);

            return {
              received: true,
              duplicate: true,
              eventId: event.id,
              type: event.type,
            };
          }

          throw error;
        }

        const payment = await tx.payment.findUnique({
          where: { id: metadata.paymentId },
          select: {
            id: true,
            orderId: true,
            amount: true,
            currency: true,
            status: true,
            stripePaymentIntentId: true,
            vendorEarningsAmount: true,
          },
        });

        if (!payment) {
          console.error(`Stripe webhook payment not found: ${metadata.paymentId}`);
          throw new AppError("Payment not found", 404);
        }

        const order = await tx.order.findUnique({
          where: { id: metadata.orderId },
          select: {
            id: true,
            buyerId: true,
            status: true,
            items: {
              select: {
                vendorId: true,
              },
            },
          },
        });

        if (!order) {
          console.error(`Stripe webhook order not found: ${metadata.orderId}`);
          throw new AppError("Order not found", 404);
        }

        if (payment.orderId !== order.id) {
          console.error(`Stripe webhook rejected: payment ${payment.id} does not belong to order ${order.id}`);
          throw new AppError("Payment does not belong to order", 400);
        }

        if (order.buyerId !== metadata.buyerId) {
          console.error(`Stripe webhook rejected: buyer mismatch for order ${order.id}`);
          throw new AppError("Buyer mismatch", 400);
        }

        if (payment.amount !== paymentIntent.amount) {
          console.error(`Stripe webhook rejected: amount mismatch for payment ${payment.id}`);
          throw new AppError("Amount mismatch", 400);
        }

        if (payment.currency.toLowerCase() !== paymentIntent.currency?.toLowerCase()) {
          console.error(`Stripe webhook rejected: currency mismatch for payment ${payment.id}`);
          throw new AppError("Currency mismatch", 400);
        }

        if (payment.stripePaymentIntentId && payment.stripePaymentIntentId !== paymentIntent.id) {
          console.error(`Stripe webhook rejected: PaymentIntent mismatch for payment ${payment.id}`);
          throw new AppError("PaymentIntent mismatch", 400);
        }

        const vendorIds = [...new Set(order.items.map((item) => item.vendorId))];

        if (vendorIds.length !== 1 || vendorIds[0] !== metadata.vendorId) {
          console.error(`Stripe webhook rejected: vendor mismatch for order ${order.id}`);
          throw new AppError("Vendor mismatch", 400);
        }

        if (payment.status === PaymentStatus.SUCCEEDED) {
          await tx.webhookEvent.update({
            where: { stripeEventId: event.id },
            data: {
              status: "IGNORED",
              processedAt: new Date(),
            },
          });

          console.warn(`Duplicate webhook delivery ignored after payment already succeeded: ${event.id}`);

          return {
            received: true,
            duplicate: true,
            eventId: event.id,
            type: event.type,
          };
        }

        const wallet = await tx.wallet.findUnique({
          where: { vendorId: metadata.vendorId },
          select: {
            id: true,
          },
        });

        if (!wallet) {
          console.error(`Stripe webhook rejected: wallet not found for vendor ${metadata.vendorId}`);
          throw new AppError("Wallet not found", 404);
        }

        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "SUCCEEDED",
            processedAt: new Date(),
            stripePaymentIntentId: paymentIntent.id,
          },
        });

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "PAID",
          },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            vendorId: metadata.vendorId,
            orderId: order.id,
            paymentId: payment.id,
            type: "PAYMENT_PENDING_CREDIT",
            amount: payment.vendorEarningsAmount,
            currency: payment.currency,
            description: `Pending credit for paid order ${order.id}`,
          },
        });

        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            pendingBalance: {
              increment: payment.vendorEarningsAmount,
            },
          },
        });

        await this.clearBuyerCart(tx, metadata.buyerId);

        await notificationsService.create(
          {
            userId: metadata.buyerId,
            type: NotificationType.ORDER_PAID,
            title: "Your order has been paid",
            body: `Order ${order.id} has been successfully paid.`,
            data: { orderId: order.id, paymentId: payment.id, amount: payment.amount },
          },
          tx,
        );

        const vendorUser = await tx.vendor.findUnique({
          where: { id: metadata.vendorId },
          select: { userId: true },
        });
        if (vendorUser) {
          await notificationsService.create(
            {
              userId: vendorUser.userId,
              type: NotificationType.BALANCE_CREDITED,
              title: "Pending balance credited",
              body: `Your pending balance was credited for order ${order.id}.`,
              data: {
                orderId: order.id,
                paymentId: payment.id,
                amount: payment.vendorEarningsAmount,
                currency: payment.currency,
              },
            },
            tx,
          );
        }

        await tx.webhookEvent.update({
          where: { stripeEventId: event.id },
          data: {
            status: "PROCESSED",
            processedAt: new Date(),
          },
        });

        return {
          received: true,
          eventId: event.id,
          type: event.type,
        };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        console.warn(`Duplicate webhook event ignored due to unique constraint: ${event.id}`);

        return {
          received: true,
          duplicate: true,
          eventId: event.id,
          type: event.type,
        };
      }

      throw error;
    }
  }

  private constructEvent(input: StripeWebhookInput): Stripe.Event {
    try {
      return stripe.webhooks.constructEvent(input.rawBody, input.signature, env.stripeWebhookSecret);
    } catch (error) {
      console.warn("Stripe webhook signature verification failed", error);
      throw new AppError("Invalid signature", 400);
    }
  }

  private parseSucceededMetadata(metadata: Stripe.Metadata): PaymentIntentSucceededMetadata {
    const orderId = metadata.orderId;
    const paymentId = metadata.paymentId;
    const buyerId = metadata.buyerId;
    const vendorId = metadata.vendorId;

    if (!orderId || !paymentId || !buyerId || !vendorId) {
      console.error("Stripe webhook rejected: missing required PaymentIntent metadata");
      throw new AppError("Missing metadata", 400);
    }

    return {
      orderId,
      paymentId,
      buyerId,
      vendorId,
    };
  }

  private async clearBuyerCart(tx: Prisma.TransactionClient, buyerId: string): Promise<void> {
    const cart = await tx.cart.findUnique({
      where: { buyerId },
      select: { id: true },
    });

    if (!cart) {
      return;
    }

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    await tx.cart.update({
      where: { id: cart.id },
      data: { vendorId: null },
    });
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    );
  }
}

export const stripeWebhookService = new StripeWebhookService();
