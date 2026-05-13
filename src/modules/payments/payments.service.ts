import type { Prisma } from "@prisma/client";

import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import {
  calculatePlatformFee as calcPlatformFeePure,
} from "../../shared/pricing";
import { validateCreatePaymentIntentFromCartInput } from "./payments.validation";
import type {
  CreatePaymentIntentResponse,
  NormalizedPaymentItem,
  PricedOrderItem,
} from "./payments.types";

/**
 * Production-safe payment flow:
 *
 * 1. Validate cart, stock, vendor, currency, delivery zone (read-only)
 * 2. Inside a short DB transaction:
 *    - Atomically decrement stock (guarded: stock >= qty)
 *    - Create Order (PENDING)
 *    - Create OrderItems
 *    - Create Payment (PENDING)
 * 3. OUTSIDE the transaction: call Stripe to create PaymentIntent
 * 4. Update Payment with stripePaymentIntentId
 * 5. Return clientSecret to frontend
 *
 * If Stripe call fails after DB commit:
 *    - Payment stays PENDING (cart-cleanup worker will restore stock after 30min)
 *    - Or payment_intent.payment_failed webhook restores stock
 *
 * Webhook (payment_intent.succeeded) is the source of truth for:
 *    - Marking order PAID
 *    - Crediting vendor wallet
 *    - Clearing buyer cart
 *    - Sending notifications
 */
class PaymentsService {
  public async createPaymentIntent(
    input: unknown,
    authenticatedBuyerId: string,
  ): Promise<CreatePaymentIntentResponse> {
    const payload = validateCreatePaymentIntentFromCartInput(input);

    // ─── Step 1: Validate (read-only) ──────────────────────────────────────

    const cart = await prisma.cart.findUnique({
      where: { id: payload.cartId },
      include: { items: { include: { product: true } } },
    });

    if (!cart) throw new AppError("Cart not found", 404);
    if (cart.buyerId !== authenticatedBuyerId) throw new AppError("Forbidden", 403);
    if (cart.items.length === 0) throw new AppError("Cart is empty", 400);

    const inactive = cart.items.find((item) => !item.product.isActive);
    if (inactive) throw new AppError("Product is not available", 400);

    const outOfStock = cart.items.find((item) => item.product.stock < item.quantity);
    if (outOfStock) throw new AppError("Insufficient stock", 400);

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
    if (vendorIds.size !== 1) throw new AppError("Cart must contain products from a single vendor", 400);
    const vendorId = pricedItems[0].vendorId;

    const currencies = new Set(pricedItems.map((item) => item.currency.toLowerCase()));
    if (currencies.size !== 1) throw new AppError("Products must use the same currency", 400);
    const currency = pricedItems[0].currency.toLowerCase();

    const zone = await prisma.deliveryZone.findUnique({ where: { id: payload.destinationZoneId } });
    if (!zone || !zone.isActive) throw new AppError("Delivery zone not available", 404);
    if (zone.currency.toLowerCase() !== currency) throw new AppError("Delivery zone currency mismatch", 400);

    const totalWeightGrams = cart.items.reduce(
      (sum, item) => sum + (item.product.weightGrams ?? 0) * item.quantity, 0,
    );

    const subtotalAmount = pricedItems.reduce((sum, item) => sum + item.totalAmount, 0);
    const deliveryFeeAmount = zone.baseFeeAmount + Math.ceil(totalWeightGrams / 1000) * zone.feePerKgAmount;
    const totalAmount = subtotalAmount + deliveryFeeAmount;
    const platformFeeAmount = calcPlatformFeePure(subtotalAmount, env.platformFeeBps);
    const vendorEarningsAmount = subtotalAmount - platformFeeAmount;
    const buyerId = cart.buyerId;

    // ─── Step 2: Atomic stock reservation + order/payment creation ─────────

    const { orderId, paymentId } = await prisma.$transaction(async (tx) => {
      // Atomic guarded stock decrement
      for (const item of pricedItems) {
        const result = await tx.product.updateMany({
          where: {
            id: item.productId,
            isActive: true,
            stock: { gte: item.quantity },
          },
          data: { stock: { decrement: item.quantity } },
        });
        if (result.count !== 1) {
          throw new AppError(`Insufficient stock for ${item.productTitle}`, 409);
        }
      }

      const orderNumber = `EKI-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;

      const order = await tx.order.create({
        data: {
          buyerId,
          orderNumber,
          status: "PENDING",
          subtotalAmount,
          deliveryFeeAmount,
          totalAmount,
          currency,
          deliveryZoneId: zone.id,
        },
        select: { id: true },
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

      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          amount: totalAmount,
          platformFeeAmount,
          vendorEarningsAmount,
          currency,
          status: "PENDING",
          provider: "stripe",
          metadata: this.buildPaymentMetadata({
            orderId: order.id,
            buyerId,
            vendorId,
            cartId: cart.id,
            items: pricedItems.map((i) => ({ productId: i.productId, quantity: i.quantity })),
            subtotalAmount,
            deliveryFeeAmount,
            totalAmount,
            platformFeeAmount,
            vendorEarningsAmount,
            deliveryZoneId: zone.id,
            totalWeightGrams,
          }),
        },
        select: { id: true },
      });

      return { orderId: order.id, paymentId: payment.id };
    });

    // ─── Step 3: Stripe call OUTSIDE transaction ───────────────────────────

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: totalAmount,
          currency,
          payment_method_types: ["card"],
          metadata: {
            orderId,
            paymentId,
            buyerId,
            vendorId,
            cartId: cart.id,
          },
        },
        { idempotencyKey: `pi:${paymentId}` },
      );
    } catch (error) {
      // Stripe failed — order stays PENDING, cart-cleanup worker will restore stock
      logger.error("Stripe PaymentIntent creation failed after order created", {
        orderId,
        paymentId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw new AppError("Payment provider unavailable", 502);
    }

    if (!paymentIntent.client_secret) {
      throw new AppError("Stripe failure: no client secret", 502);
    }

    // ─── Step 4: Link Stripe PI to our payment record ──────────────────────

    await prisma.payment.update({
      where: { id: paymentId },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    return {
      orderId,
      paymentId,
      amount: totalAmount,
      currency,
      clientSecret: paymentIntent.client_secret,
    };
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
}

export const paymentsService = new PaymentsService();
