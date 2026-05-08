import type { Prisma } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import {
  assertSingleVendor,
  assertUniformCurrency,
  normalizePaymentItems,
  validateCreatePaymentIntentInput,
} from "./payments.validation";
import type {
  CreatePaymentIntentResponse,
  NormalizedPaymentItem,
  PricedOrderItem,
} from "./payments.types";

class PaymentsService {
  public async createPaymentIntent(input: unknown): Promise<CreatePaymentIntentResponse> {
    const payload = validateCreatePaymentIntentInput(input);
    const normalizedItems = normalizePaymentItems(payload.items);

    const buyer = await prisma.user.findUnique({
      where: { id: payload.buyerId },
      select: { id: true },
    });

    if (!buyer) {
      throw new AppError("Invalid buyer", 404);
    }

    const products = await prisma.product.findMany({
      where: {
        id: { in: normalizedItems.map((item) => item.productId) },
      },
      select: {
        id: true,
        vendorId: true,
        title: true,
        priceInCents: true,
        currency: true,
        isActive: true,
      },
    });

    if (products.length !== normalizedItems.length) {
      throw new AppError("Invalid product", 404);
    }

    const productMap = new Map(products.map((product) => [product.id, product]));

    const pricedItems = normalizedItems.map((item) => {
      const product = productMap.get(item.productId);

      if (!product || !product.isActive) {
        throw new AppError("Invalid product", 404);
      }

      return {
        productId: product.id,
        vendorId: product.vendorId,
        quantity: item.quantity,
        unitAmount: product.priceInCents,
        totalAmount: product.priceInCents * item.quantity,
        currency: product.currency,
        productTitle: product.title,
      } satisfies PricedOrderItem;
    });

    const vendorId = assertSingleVendor(pricedItems);
    const currency = assertUniformCurrency(pricedItems);
    const subtotalAmount = pricedItems.reduce((sum, item) => sum + item.totalAmount, 0);
    const platformFeeAmount = this.calculatePlatformFee(subtotalAmount);
    const vendorEarningsAmount = subtotalAmount - platformFeeAmount;
    let createdPaymentIntentId: string | null = null;

    try {
      return await prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            buyerId: payload.buyerId,
            status: "PENDING",
            totalAmount: subtotalAmount,
            currency,
          },
          select: {
            id: true,
            currency: true,
            totalAmount: true,
          },
        });

        await tx.orderItem.createMany({
          data: pricedItems.map((item) => ({
            orderId: order.id,
            productId: item.productId,
            vendorId: item.vendorId,
            quantity: item.quantity,
            unitAmount: item.unitAmount,
            totalAmount: item.totalAmount,
            currency: item.currency,
            productTitle: item.productTitle,
          })),
        });

        const paymentMetadata = this.buildPaymentMetadata({
          orderId: order.id,
          buyerId: payload.buyerId,
          vendorId,
          items: normalizedItems,
          subtotalAmount,
          platformFeeAmount,
          vendorEarningsAmount,
        });

        const payment = await tx.payment.create({
          data: {
            orderId: order.id,
            amount: subtotalAmount,
            platformFeeAmount,
            vendorEarningsAmount,
            currency,
            status: "PENDING",
            provider: "stripe",
            metadata: paymentMetadata,
          },
          select: {
            id: true,
          },
        });

        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: subtotalAmount,
            currency,
            automatic_payment_methods: {
              enabled: true,
            },
            metadata: {
              orderId: order.id,
              paymentId: payment.id,
              buyerId: payload.buyerId,
              vendorId,
            },
          },
          {
            idempotencyKey: `payment-intent:${payment.id}`,
          },
        );
        createdPaymentIntentId = paymentIntent.id;

        if (!paymentIntent.client_secret) {
          throw new AppError("Stripe failure", 502);
        }

        const updatedPayment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            stripePaymentIntentId: paymentIntent.id,
          },
          select: {
            id: true,
            amount: true,
            currency: true,
          },
        });

        return {
          orderId: order.id,
          paymentId: updatedPayment.id,
          amount: updatedPayment.amount,
          currency: updatedPayment.currency,
          clientSecret: paymentIntent.client_secret,
        } satisfies CreatePaymentIntentResponse;
      });
    } catch (error) {
      if (createdPaymentIntentId) {
        try {
          await stripe.paymentIntents.cancel(createdPaymentIntentId);
        } catch (cancelError) {
          console.error("Failed to cancel Stripe PaymentIntent after transaction error", cancelError);
        }
      }

      if (this.isStripeError(error)) {
        throw new AppError("Stripe failure", 502, {
          code: error.code,
          type: error.type,
        });
      }

      throw error;
    }
  }

  private calculatePlatformFee(amount: number): number {
    return Math.round((amount * env.platformFeeBps) / 10000);
  }

  private buildPaymentMetadata(input: {
    orderId: string;
    buyerId: string;
    vendorId: string;
    items: NormalizedPaymentItem[];
    subtotalAmount: number;
    platformFeeAmount: number;
    vendorEarningsAmount: number;
  }): Prisma.JsonObject {
    return {
      orderId: input.orderId,
      buyerId: input.buyerId,
      vendorId: input.vendorId,
      subtotalAmount: input.subtotalAmount,
      platformFeeAmount: input.platformFeeAmount,
      vendorEarningsAmount: input.vendorEarningsAmount,
      items: input.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      })),
    };
  }

  private isStripeError(error: unknown): error is { type: string; code?: string } {
    return Boolean(
      error &&
        typeof error === "object" &&
        "type" in error &&
        typeof (error as { type?: unknown }).type === "string" &&
        String((error as { type: string }).type).startsWith("Stripe"),
    );
  }
}

export const paymentsService = new PaymentsService();
