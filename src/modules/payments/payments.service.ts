import type { Prisma } from "@prisma/client";

import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { calculatePlatformFee as calcPlatformFee } from "../../shared/pricing";
import { validateCreatePaymentIntentFromCartInput } from "./payments.validation";
import type { CreatePaymentIntentResponse, PricedOrderItem } from "./payments.types";

const MAX_VENDOR_WEIGHT_GRAMS = 30_000; // 30 kg per vendor group

interface VendorGroup {
  vendorId: string;
  items: PricedOrderItem[];
  subtotalAmount: number;
  deliveryFeeAmount: number;
  totalAmount: number;
  platformFeeAmount: number;
  vendorEarningsAmount: number;
  deliveryZoneId: string;
}

/**
 * Multi-vendor checkout flow:
 *
 * 1. Validate cart (multi-vendor allowed), stock, delivery zones
 * 2. Group items by vendor, calculate per-vendor totals
 * 3. DB transaction: reserve stock + create Checkout + Orders + Payments + wallet debit
 * 4. OUTSIDE transaction: create single Stripe PaymentIntent (if stripe amount > 0)
 * 5. Link PI to Checkout
 * 6. Webhook (payment_intent.succeeded) marks all orders PAID + credits wallets
 */
class PaymentsService {
  public async createPaymentIntent(
    input: unknown,
    authenticatedBuyerId: string,
  ): Promise<CreatePaymentIntentResponse> {
    const payload = validateCreatePaymentIntentFromCartInput(input);

    // ─── Step 1: Load and validate cart ────────────────────────────────────

    const cart = await prisma.cart.findUnique({
      where: { id: payload.cartId },
      include: { items: { include: { product: true } } },
    });

    if (!cart) throw new AppError("Cart not found", 404);
    if (cart.buyerId !== authenticatedBuyerId) throw new AppError("Forbidden", 403);
    if (cart.items.length === 0) throw new AppError("Cart is empty", 400);

    const inactive = cart.items.find((item) => !item.product.isActive);
    if (inactive) throw new AppError(`Product "${inactive.product.title}" is not available`, 400);

    const outOfStock = cart.items.find((item) => item.product.stock < item.quantity);
    if (outOfStock) throw new AppError(`Insufficient stock for "${outOfStock.product.title}"`, 400);

    // ─── Step 2: Group by vendor ───────────────────────────────────────────

    const pricedItems: PricedOrderItem[] = cart.items.map((item) => ({
      productId: item.productId,
      vendorId: item.product.vendorId,
      quantity: item.quantity,
      unitAmount: item.product.priceInCents,
      totalAmount: item.product.priceInCents * item.quantity,
      currency: item.product.currency,
      productTitle: item.product.title,
      weightGrams: (item.product.weightGrams ?? 0) * item.quantity,
    }));

    // Validate uniform currency
    const currencies = new Set(pricedItems.map((i) => i.currency.toLowerCase()));
    if (currencies.size !== 1) throw new AppError("All products must use the same currency", 400);
    const currency = pricedItems[0].currency.toLowerCase();

    // Group by vendor
    const vendorMap = new Map<string, PricedOrderItem[]>();
    for (const item of pricedItems) {
      const existing = vendorMap.get(item.vendorId) ?? [];
      existing.push(item);
      vendorMap.set(item.vendorId, existing);
    }

    // ─── Step 2b: Resolve delivery zone ────────────────────────────────────
    // Accept either a direct destinationZoneId or resolve from deliveryCountry.

    let zone;
    if (payload.destinationZoneId) {
      zone = await prisma.deliveryZone.findUnique({ where: { id: payload.destinationZoneId } });
      if (!zone || !zone.isActive) throw new AppError("Delivery zone not available", 404);
    } else if (payload.deliveryCountry) {
      zone = await prisma.deliveryZone.findFirst({
        where: { country: { equals: payload.deliveryCountry, mode: "insensitive" }, isActive: true },
      });
      if (!zone) {
        throw new AppError(`Delivery to "${payload.deliveryCountry}" is not available`, 400);
      }
    } else {
      throw new AppError("Delivery destination is required", 400);
    }

    if (zone.currency.toLowerCase() !== currency) {
      throw new AppError("Delivery zone currency mismatch", 400);
    }

    // ─── Step 2c: Per-vendor delivery validation + weight check ────────────

    const vendorGroups: VendorGroup[] = [];
    for (const [vendorId, items] of vendorMap) {
      const subtotal = items.reduce((sum, i) => sum + i.totalAmount, 0);
      const totalWeight = items.reduce((sum, i) => sum + i.weightGrams, 0);

      // Enforce max weight per vendor group
      if (totalWeight > MAX_VENDOR_WEIGHT_GRAMS) {
        throw new AppError(
          `Order weight for one vendor exceeds the maximum of ${MAX_VENDOR_WEIGHT_GRAMS / 1000}kg. Please reduce items.`,
          400,
        );
      }

      // Check if vendor-specific zone exists; fall back to global zone
      const vendorZone = await prisma.deliveryZone.findFirst({
        where: {
          vendorId,
          country: zone.country,
          isActive: true,
        },
      });
      const effectiveZone = vendorZone ?? zone;

      const deliveryFee = effectiveZone.baseFeeAmount + Math.ceil(totalWeight / 1000) * effectiveZone.feePerKgAmount;
      const platformFee = calcPlatformFee(subtotal, env.platformFeeBps);
      const vendorEarnings = subtotal - platformFee;

      vendorGroups.push({
        vendorId,
        items,
        subtotalAmount: subtotal,
        deliveryFeeAmount: deliveryFee,
        totalAmount: subtotal + deliveryFee,
        platformFeeAmount: platformFee,
        vendorEarningsAmount: vendorEarnings,
        deliveryZoneId: effectiveZone.id,
      });
    }

    const grandTotal = vendorGroups.reduce((sum, g) => sum + g.totalAmount, 0);
    const buyerId = cart.buyerId;

    // ─── Step 2d: Wallet deduction validation ──────────────────────────────

    let walletDeduction = 0;
    if (payload.walletAmount && payload.walletAmount > 0) {
      const buyerWallet = await prisma.buyerWallet.findUnique({
        where: { buyerId },
      });
      if (!buyerWallet) {
        throw new AppError("Buyer wallet not found", 400);
      }
      if (payload.walletAmount > buyerWallet.balance) {
        throw new AppError("Insufficient wallet balance", 400);
      }
      // Cannot exceed grand total
      walletDeduction = Math.min(payload.walletAmount, grandTotal);
    }

    const stripeAmount = grandTotal - walletDeduction;

    // ─── Step 3: Atomic DB transaction (stock + checkout + orders) ─────────

    const { checkoutId, orderIds } = await prisma.$transaction(async (tx) => {
      // Atomic guarded stock decrement for ALL items
      for (const item of pricedItems) {
        const result = await tx.product.updateMany({
          where: { id: item.productId, isActive: true, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (result.count !== 1) {
          throw new AppError(`Insufficient stock for "${item.productTitle}"`, 409);
        }
      }

      // Debit buyer wallet if applicable
      if (walletDeduction > 0) {
        const walletUpdate = await tx.buyerWallet.updateMany({
          where: { buyerId, balance: { gte: walletDeduction } },
          data: { balance: { decrement: walletDeduction } },
        });
        if (walletUpdate.count !== 1) {
          throw new AppError("Insufficient wallet balance", 400);
        }

        const wallet = await tx.buyerWallet.findUnique({ where: { buyerId } });
        if (wallet) {
          await tx.buyerWalletTransaction.create({
            data: {
              walletId: wallet.id,
              buyerId,
              type: "ORDER_DEBIT",
              amount: -walletDeduction,
              currency,
              description: "Order payment (wallet)",
            },
          });
        }
      }

      // Create Checkout record
      const checkout = await tx.checkout.create({
        data: {
          buyerId,
          totalAmount: grandTotal,
          currency,
          status: "PENDING",
          metadata: {
            vendorGroups: vendorGroups.map((g) => ({
              vendorId: g.vendorId,
              subtotal: g.subtotalAmount,
              delivery: g.deliveryFeeAmount,
              platformFee: g.platformFeeAmount,
              vendorEarnings: g.vendorEarningsAmount,
            })),
            walletDeduction,
            deliveryAddress: payload.deliveryAddress ?? null,
            deliveryCountry: payload.deliveryCountry ?? zone.country,
          } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      // Create one Order per vendor
      const orderIds: string[] = [];
      for (const group of vendorGroups) {
        const orderNumber = `EKI-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}-${orderIds.length}`;

        const order = await tx.order.create({
          data: {
            checkoutId: checkout.id,
            buyerId,
            vendorId: group.vendorId,
            orderNumber,
            status: stripeAmount === 0 ? "PAID" : "PENDING",
            subtotalAmount: group.subtotalAmount,
            deliveryFeeAmount: group.deliveryFeeAmount,
            platformFeeAmount: group.platformFeeAmount,
            vendorEarnings: group.vendorEarningsAmount,
            totalAmount: group.totalAmount,
            currency,
            deliveryZoneId: group.deliveryZoneId,
          },
          select: { id: true },
        });

        await tx.orderItem.createMany({
          data: group.items.map((item) => ({
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

        // Create Payment record per order
        await tx.payment.create({
          data: {
            orderId: order.id,
            amount: group.totalAmount,
            platformFeeAmount: group.platformFeeAmount,
            vendorEarningsAmount: group.vendorEarningsAmount,
            currency,
            status: stripeAmount === 0 ? "SUCCEEDED" : "PENDING",
            provider: walletDeduction > 0 && stripeAmount === 0 ? "wallet" : "stripe",
          },
        });

        orderIds.push(order.id);
      }

      // If fully paid by wallet, mark checkout as succeeded
      if (stripeAmount === 0) {
        await tx.checkout.update({
          where: { id: checkout.id },
          data: { status: "SUCCEEDED", processedAt: new Date() },
        });
      }

      return { checkoutId: checkout.id, orderIds };
    });

    // ─── Step 4: Stripe call OUTSIDE transaction (if needed) ───────────────

    if (stripeAmount === 0) {
      // Fully paid by wallet — no Stripe needed
      return {
        checkoutId,
        orderIds,
        amount: grandTotal,
        currency,
        clientSecret: "wallet_paid",
      };
    }

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: stripeAmount,
          currency,
          payment_method_types: ["card"],
          metadata: {
            checkoutId,
            buyerId,
            orderIds: orderIds.join(","),
            vendorIds: vendorGroups.map((g) => g.vendorId).join(","),
            walletDeduction: String(walletDeduction),
          },
        },
        { idempotencyKey: `pi:checkout:${checkoutId}` },
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Stripe PaymentIntent creation failed", {
        checkoutId,
        errorMessage: errorMsg,
      });
      throw new AppError("Payment provider unavailable", 502);
    }

    if (!paymentIntent.client_secret) {
      throw new AppError("Stripe failure: no client secret", 502);
    }

    // ─── Step 5: Link Stripe PI to Checkout ────────────────────────────────

    await prisma.checkout.update({
      where: { id: checkoutId },
      data: { stripePaymentIntentId: paymentIntent.id },
    });

    return {
      checkoutId,
      orderIds,
      amount: grandTotal,
      currency,
      clientSecret: paymentIntent.client_secret,
    };
  }
}

export const paymentsService = new PaymentsService();
