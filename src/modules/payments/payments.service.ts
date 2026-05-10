import type { Prisma } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { validateCreatePaymentIntentFromCartInput } from "./payments.validation";
import type {
  CreatePaymentIntentResponse,
  NormalizedPaymentItem,
  PricedOrderItem,
} from "./payments.types";

class PaymentsService {
  public async createPaymentIntent(
    input: unknown,
    authenticatedBuyerId: string,
  ): Promise<CreatePaymentIntentResponse> {
    const payload = validateCreatePaymentIntentFromCartInput(input);

    const cart = await prisma.cart.findUnique({
      where: { id: payload.cartId },
      include: { items: { include: { product: true } } },
    });

    if (!cart) {
      throw new AppError("Cart not found", 404);
    }
    if (cart.buyerId !== authenticatedBuyerId) {
      throw new AppError("Forbidden", 403);
    }
    if (cart.items.length === 0) {
      throw new AppError("Cart is empty", 400);
    }

    const inactive = cart.items.find((item) => !item.product.isActive);
    if (inactive) {
      throw new AppError("Product is not available", 400);
    }
    const outOfStock = cart.items.find((item) => item.product.stock < item.quantity);
    if (outOfStock) {
      throw new AppError("Insufficient stock", 400);
    }

    const pricedItems: PricedOrderItem[] = cart.items.map((item) => ({
      productId: item.productId,
      vendorId: item.product.vendorId,
      quantity: item.quantity,
      unitAmount: item.product.priceInCents,
      totalAmount: item.product.priceInCents * item.quantity,
      currency: item.product.currency,
      productTitle: item.product.title,
    }));

    const vendorIds = new Set(pricedItems.map((item) => item.vendorId));
    if (vendorIds.size !== 1) {
      throw new AppError("Cart must contain products from a single vendor", 400);
    }
    const vendorId = pricedItems[0].vendorId;

    const currencies = new Set(pricedItems.map((item) => item.currency.toLowerCase()));
    if (currencies.size !== 1) {
      throw new AppError("Products must use the same currency", 400);
    }
    const currency = pricedItems[0].currency.toLowerCase();

    const zone = await prisma.deliveryZone.findUnique({
      where: { id: payload.destinationZoneId },
    });
    if (!zone || !zone.isActive) {
      throw new AppError("Delivery zone not available", 404);
    }
    if (zone.currency.toLowerCase() !== currency) {
      throw new AppError("Delivery zone currency mismatch", 400);
    }

    const totalWeightGrams = cart.items.reduce(
      (sum, item) => sum + (item.product.weightGrams ?? 0) * item.quantity,
      0,
    );

    const subtotalAmount = pricedItems.reduce((sum, item) => sum + item.totalAmount, 0);
    const deliveryFeeAmount =
      zone.baseFeeAmount + Math.ceil(totalWeightGrams / 1000) * zone.feePerKgAmount;
    const totalAmount = subtotalAmount + deliveryFeeAmount;
    const platformFeeAmount = this.calculatePlatformFee(subtotalAmount);
    const vendorEarningsAmount = subtotalAmount - platformFeeAmount;
    const buyerId = cart.buyerId;
    let createdPaymentIntentId: string | null = null;

    try {
      return await prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            buyerId,
            status: "PENDING",
            subtotalAmount,
            deliveryFeeAmount,
            totalAmount,
            currency,
            deliveryZoneId: zone.id,
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
          buyerId,
          vendorId,
          cartId: cart.id,
          items: pricedItems.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
          subtotalAmount,
          deliveryFeeAmount,
          totalAmount,
          platformFeeAmount,
          vendorEarningsAmount,
          deliveryZoneId: zone.id,
          totalWeightGrams,
        });

        const payment = await tx.payment.create({
          data: {
            orderId: order.id,
            amount: totalAmount,
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
            amount: totalAmount,
            currency,
            payment_method_types: ["card"],
            metadata: {
              orderId: order.id,
              paymentId: payment.id,
              buyerId,
              vendorId,
              cartId: cart.id,
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
    cartId: string;
    items: NormalizedPaymentItem[];
    subtotalAmount: number;
    deliveryFeeAmount: number;
    totalAmount: number;
    platformFeeAmount: number;
    vendorEarningsAmount: number;
    deliveryZoneId: string;
    totalWeightGrams: number;
  }): Prisma.JsonObject {
    return {
      orderId: input.orderId,
      buyerId: input.buyerId,
      vendorId: input.vendorId,
      cartId: input.cartId,
      subtotalAmount: input.subtotalAmount,
      deliveryFeeAmount: input.deliveryFeeAmount,
      totalAmount: input.totalAmount,
      platformFeeAmount: input.platformFeeAmount,
      vendorEarningsAmount: input.vendorEarningsAmount,
      deliveryZoneId: input.deliveryZoneId,
      totalWeightGrams: input.totalWeightGrams,
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
