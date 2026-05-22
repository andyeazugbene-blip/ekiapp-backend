import crypto from "crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { paystack } from "../../lib/paystack";
import { logger } from "../../lib/logger";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { calculatePlatformFee } from "../../shared/pricing";

const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? "1000");

export interface InitializeEscrowInput {
  cartId: string;
  deliveryAddress: string;
  deliveryCountry: string;
}

export const paystackService = {
  /**
   * Initialize a domestic escrow checkout via Paystack.
   * Creates Order(s) in PENDING state, creates PaystackTransaction,
   * returns Paystack checkout URL for the buyer.
   */
  async initializeEscrowCheckout(
    buyerId: string,
    input: InitializeEscrowInput,
  ): Promise<{ authorizationUrl: string; reference: string; orderId: string; amount: number; currency: string }> {
    if (!paystack.isConfigured()) {
      throw new AppError("Paystack is not configured", 503);
    }

    // Load cart
    const cart = await prisma.cart.findUnique({
      where: { buyerId },
      include: { items: { include: { product: { include: { vendor: true } } } } },
    });
    if (!cart || cart.items.length === 0) {
      throw new AppError("Cart is empty", 400);
    }

    // Validate all products are active and in stock
    for (const item of cart.items) {
      if (!item.product.isActive) throw new AppError(`Product "${item.product.title}" is not available`, 400);
      if (item.product.stock < item.quantity) throw new AppError(`Insufficient stock for "${item.product.title}"`, 400);
    }

    // For domestic escrow, all items must be from same country vendor
    const vendorCountries = new Set(cart.items.map(i => i.product.vendor.country?.toLowerCase()));
    const supportedCountries = new Set(["nigeria", "ghana", "ng", "gh"]);
    const domesticVendorCountry = [...vendorCountries][0];
    if (vendorCountries.size > 1) {
      throw new AppError("Domestic escrow checkout only supports items from a single vendor country", 400);
    }
    if (!domesticVendorCountry || !supportedCountries.has(domesticVendorCountry)) {
      throw new AppError("Domestic escrow is only available for Nigeria and Ghana vendors", 400);
    }

    // Determine currency
    const currency = ["nigeria", "ng"].includes(domesticVendorCountry) ? "NGN" : "GHS";

    // Calculate totals (single vendor group for domestic)
    const vendorId = cart.items[0].product.vendorId;
    let subtotal = 0;
    const pricedItems = cart.items.map(item => {
      const total = item.product.priceInCents * item.quantity;
      subtotal += total;
      return {
        productId: item.productId,
        vendorId: item.product.vendorId,
        quantity: item.quantity,
        unitAmount: item.product.priceInCents,
        totalAmount: total,
        currency,
        productTitle: item.product.title,
      };
    });

    // Delivery fee (use zone if available, otherwise flat)
    const zone = await prisma.deliveryZone.findFirst({
      where: { country: { equals: input.deliveryCountry, mode: "insensitive" }, isActive: true },
    });
    const deliveryFee = zone?.baseFeeAmount ?? 0;
    const platformFee = calculatePlatformFee(subtotal, PLATFORM_FEE_BPS);
    const vendorEarnings = subtotal - platformFee;
    const grandTotal = subtotal + deliveryFee;

    // Generate unique reference
    const reference = `eki-escrow-${crypto.randomBytes(12).toString("hex")}`;

    // Get buyer email
    const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { email: true } });
    if (!buyer) throw new AppError("Buyer not found", 404);

    // Create order + paystack transaction in a single DB transaction
    const { orderId } = await prisma.$transaction(async (tx) => {
      // Reserve stock
      for (const item of pricedItems) {
        const result = await tx.product.updateMany({
          where: { id: item.productId, isActive: true, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (result.count !== 1) {
          throw new AppError(`Insufficient stock for "${item.productTitle}"`, 409);
        }
      }

      const orderNumber = `EKI-AF-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

      const order = await tx.order.create({
        data: {
          buyerId,
          vendorId,
          orderNumber,
          status: "PENDING",
          escrowType: "DOMESTIC_AFRICA",
          subtotalAmount: subtotal,
          deliveryFeeAmount: deliveryFee,
          platformFeeAmount: platformFee,
          vendorEarnings,
          totalAmount: grandTotal,
          currency,
          deliveryAddress: input.deliveryAddress,
          deliveryZoneId: zone?.id,
        },
      });

      // Create order items
      await tx.orderItem.createMany({
        data: pricedItems.map(item => ({
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

      // Create PaystackTransaction record
      await tx.paystackTransaction.create({
        data: {
          orderId: order.id,
          reference,
          amount: grandTotal,
          currency,
          status: "PENDING",
        },
      });

      return { orderId: order.id };
    });

    // Initialize Paystack payment
    const paystackResult = await paystack.initializeTransaction({
      email: buyer.email,
      amount: grandTotal, // already in smallest unit (kobo/pesewas)
      currency,
      reference,
      metadata: { orderId, buyerId, escrowType: "DOMESTIC_AFRICA" },
    });

    return {
      authorizationUrl: paystackResult.authorization_url,
      reference: paystackResult.reference,
      orderId,
      amount: grandTotal,
      currency,
    };
  },

  /**
   * Handle Paystack webhook (charge.success).
   * Marks order as PAYMENT_SECURED and notifies vendor.
   */
  async handleChargeSuccess(reference: string, paystackData: unknown): Promise<void> {
    const tx = await prisma.paystackTransaction.findUnique({ where: { reference } });
    if (!tx) {
      logger.warn("Paystack webhook: unknown reference", { reference });
      return;
    }

    if (tx.status === "SUCCESS") {
      logger.info("Paystack webhook: already processed", { reference });
      return; // Idempotent
    }

    // Database-level idempotency: use WebhookEvent with unique constraint
    try {
      await prisma.webhookEvent.create({
        data: {
          stripeEventId: `paystack:${reference}`, // reuse stripeEventId field for Paystack
          eventType: "paystack.charge.success",
          provider: "paystack",
          status: "PROCESSING",
          orderId: tx.orderId,
        },
      });
    } catch (error: unknown) {
      // Unique constraint violation = duplicate webhook
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        logger.info("Paystack webhook: duplicate (unique constraint)", { reference });
        return;
      }
      throw error;
    }

    await prisma.$transaction(async (db) => {
      // Mark transaction SUCCESS
      await db.paystackTransaction.update({
        where: { id: tx.id },
        data: { status: "SUCCESS", paystackResponse: paystackData as object },
      });

      // Mark order PAYMENT_SECURED
      await db.order.update({
        where: { id: tx.orderId },
        data: { status: "PAYMENT_SECURED" },
      });
    });

    // Notify vendor
    const order = await prisma.order.findUnique({
      where: { id: tx.orderId },
      select: { vendorId: true, orderNumber: true, totalAmount: true, currency: true },
    });

    if (order?.vendorId) {
      const vendor = await prisma.vendor.findUnique({
        where: { id: order.vendorId },
        select: { userId: true, storeName: true, contactPhone: true },
      });
      if (vendor) {
        // Push notification
        await notificationsService.enqueue({
          userId: vendor.userId,
          type: "ORDER_PAID",
          title: "Payment Secured 🔒",
          body: `Order ${order.orderNumber} — Payment of ${order.totalAmount / 100} ${order.currency} is secured. Prepare the order.`,
          data: { orderId: tx.orderId },
        });

        // SMS fallback
        if (vendor.contactPhone) {
          const { sendSms } = await import("../../lib/sms");
          sendSms({
            to: vendor.contactPhone,
            message: `Eki: Payment of ${order.totalAmount / 100} ${order.currency} secured for order ${order.orderNumber}. Open the app to confirm and prepare.`,
          }).catch(() => {}); // fire-and-forget
        }
      }
    }

    logger.info("Paystack escrow: payment secured", { reference, orderId: tx.orderId });
  },

  /**
   * Verify a Paystack transaction manually (fallback for mobile).
   */
  async verifyTransaction(reference: string, buyerId: string): Promise<{ status: string; orderId: string }> {
    const tx = await prisma.paystackTransaction.findUnique({ where: { reference } });
    if (!tx) throw new AppError("Transaction not found", 404);

    // Verify ownership
    const order = await prisma.order.findUnique({ where: { id: tx.orderId }, select: { buyerId: true } });
    if (!order || order.buyerId !== buyerId) throw new AppError("Forbidden", 403);

    if (tx.status === "SUCCESS") {
      return { status: "success", orderId: tx.orderId };
    }

    // Call Paystack verify API
    const result = await paystack.verifyTransaction(reference);

    if (result.status === "success" && (tx.status as string) !== "SUCCESS") {
      // Process it as if webhook came
      await this.handleChargeSuccess(reference, result);
      return { status: "success", orderId: tx.orderId };
    }

    return { status: result.status, orderId: tx.orderId };
  },
};
