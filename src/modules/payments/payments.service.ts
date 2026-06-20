import crypto from "crypto";

import type { Prisma } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { calculatePlatformFee as calcPlatformFee } from "../../shared/pricing";
import { referralsService } from "../referrals/referrals.service";
import { resolveVendorCommission } from "../subscriptions/subscription-plan-utils";
import { promosService } from "../promos/promos.service";
import { campaignsService } from "../campaigns/campaigns.service";
import { validateCreatePaymentIntentFromCartInput } from "./payments.validation";
import type { CreatePaymentIntentResponse, PricedOrderItem } from "./payments.types";

import { MAX_VENDOR_WEIGHT_GRAMS } from "../../shared/constants";
import { resolveStripeCurrency } from "../../shared/currency";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { notificationsService } from "../notifications/notifications.service";
import { pushNotifications } from "../../lib/push-notifications";

interface VendorGroup {
  vendorId: string;
  items: PricedOrderItem[];
  subtotalAmount: number;
  deliveryFeeAmount: number;
  totalAmount: number;
  platformFeeAmount: number;
  vendorEarningsAmount: number;
  sellerPlanId: string | null;
  sellerPlanSlug: string;
  commissionTierId: string | null;
  commissionBps: number;
  withdrawalFeeBps: number;
  deliveryZoneId: string;
  discountAmount: number;
}

/**
 * Multi-vendor checkout flow:
 *
 * 1. Validate cart (multi-vendor allowed), stock, delivery zones
 * 2. Group items by vendor, calculate per-vendor totals
 * 3. DB transaction: reserve stock + create Checkout + Orders + Payments + wallet debit
 * 4. OUTSIDE transaction: create single Stripe PaymentIntent (if stripe amount > 0)
 * 5. Link PI to Checkout
 * 6. Webhook marks Stripe orders PAID + credits wallets.
 *    Fully wallet-paid checkouts do the same wallet ledger work in this transaction.
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
      costAmount: item.product.costAmount,
      costCurrency: item.product.costCurrency ?? item.product.currency,
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
      const commission = await resolveVendorCommission(vendorId, subtotal);
      if (!commission.canReceiveOrders) {
        throw new AppError("This vendor's plan does not allow receiving orders", 403);
      }
      const platformFee = calcPlatformFee(subtotal, commission.platformFeeBps);
      const totalAmount = subtotal + deliveryFee;
      const vendorEarnings = totalAmount - platformFee;

      vendorGroups.push({
        vendorId,
        items,
        subtotalAmount: subtotal,
        deliveryFeeAmount: deliveryFee,
        totalAmount,
        platformFeeAmount: platformFee,
        vendorEarningsAmount: vendorEarnings,
        sellerPlanId: commission.sellerPlanId,
        sellerPlanSlug: commission.sellerPlanSlug,
        commissionTierId: commission.commissionTierId,
        commissionBps: commission.platformFeeBps,
        withdrawalFeeBps: commission.withdrawalFeeBps,
        deliveryZoneId: effectiveZone.id,
        discountAmount: 0,
      });
    }

    let grandTotal = vendorGroups.reduce((sum, g) => sum + g.totalAmount, 0);
    const buyerId = cart.buyerId;

    // ─── Step 2e: Promo code validation ────────────────────────────────────

    let promoDiscount = 0;
    let promoCodeApplied: string | undefined;
    if (payload.promoCode && payload.promoVendorId) {
      const targetGroup = vendorGroups.find((g) => g.vendorId === payload.promoVendorId);
      if (!targetGroup) {
        throw new AppError("Promo code vendor is not in this cart", 400);
      }
      const orderAmountCents = targetGroup.subtotalAmount;
      const validation = await promosService.validatePromo(buyerId, {
        code: payload.promoCode,
        orderAmount: orderAmountCents,
        vendorId: payload.promoVendorId,
      });
      promoDiscount = validation.discountAmount;
      promoCodeApplied = payload.promoCode;

      // Apply discount to the target vendor group
      targetGroup.discountAmount = promoDiscount;
      targetGroup.subtotalAmount = Math.max(0, targetGroup.subtotalAmount - promoDiscount);
      // Recalculate platform fee and earnings on discounted subtotal
      const commission = await resolveVendorCommission(targetGroup.vendorId, targetGroup.subtotalAmount);
      targetGroup.platformFeeAmount = calcPlatformFee(targetGroup.subtotalAmount, commission.platformFeeBps);
      targetGroup.totalAmount = targetGroup.subtotalAmount + targetGroup.deliveryFeeAmount;
      targetGroup.vendorEarningsAmount = targetGroup.totalAmount - targetGroup.platformFeeAmount;
      grandTotal = vendorGroups.reduce((sum, group) => sum + group.totalAmount, 0);
    }

    // ─── Step 2e2: Hot Deal campaign auto-apply (platform-funded, vendor payout unaffected) ──
    // Skips if a promo code was already applied — campaign and promo discounts do not stack.

    let campaignDiscountAmount = 0;
    let appliedCampaignId: string | undefined;
    let appliedCampaignTitle: string | undefined;
    if (!promoCodeApplied) {
      const eligibleCampaigns = await campaignsService.listEligibleForUser(buyerId);
      const best = eligibleCampaigns.find(
        (c) => c.type === "HOT_DEAL" && c.discountType && c.discountValue != null && c.discountValue > 0,
      );
      if (best && best.discountValue != null) {
        campaignDiscountAmount =
          best.discountType === "PERCENTAGE"
            ? Math.round((grandTotal * best.discountValue) / 100)
            : Math.min(best.discountValue, grandTotal);
        grandTotal = Math.max(0, grandTotal - campaignDiscountAmount);
        appliedCampaignId = best.id;
        appliedCampaignTitle = best.title;
      }
    }

    // ─── Step 2d: Wallet deduction validation ──────────────────────────────

    let walletDeduction = 0;
    if (payload.walletAmount && payload.walletAmount > 0) {
      const buyerWallet = await prisma.buyerWallet.findUnique({
        where: { buyerId },
      });
      if (!buyerWallet) {
        throw new AppError("Buyer wallet not found", 400);
      }
      if (buyerWallet.currency.toLowerCase() !== currency) {
        throw new AppError("Wallet currency must match checkout currency", 400);
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

      // Resolve Stripe-compatible currency (Italy account may not support some local currencies)
      const stripeCurrency = resolveStripeCurrency(currency);

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
              sellerPlanId: g.sellerPlanId,
              sellerPlanSlug: g.sellerPlanSlug,
              commissionTierId: g.commissionTierId,
              commissionBps: g.commissionBps,
              withdrawalFeeBps: g.withdrawalFeeBps,
              discountAmount: g.discountAmount,
            })),
            walletDeduction,
            deliveryAddress: payload.deliveryAddress ?? null,
            deliveryCountry: payload.deliveryCountry ?? zone.country,
            stripeCurrency,
            promoCode: promoCodeApplied ?? null,
            promoDiscount: promoDiscount,
            campaignId: appliedCampaignId ?? null,
            campaignDiscount: campaignDiscountAmount,
          } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      // Create one Order per vendor
      const orderIds: string[] = [];
      for (const group of vendorGroups) {
        const orderNumber = `EKI-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${orderIds.length}`;

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
            sellerPlanId: group.sellerPlanId,
            sellerPlanSlug: group.sellerPlanSlug,
            commissionTierId: group.commissionTierId,
            commissionBps: group.commissionBps,
            withdrawalFeeBps: group.withdrawalFeeBps,
            totalAmount: group.totalAmount,
            currency,
            deliveryZoneId: group.deliveryZoneId,
            deliveryAddress: payload.deliveryAddress ?? null,
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
            costAmount: item.costAmount,
            costCurrency: item.costCurrency,
            currency: item.currency,
            productTitle: item.productTitle,
          })),
        });

        // Create Payment record per order
        const payment = await tx.payment.create({
          data: {
            orderId: order.id,
            amount: group.totalAmount,
            platformFeeAmount: group.platformFeeAmount,
            vendorEarningsAmount: group.vendorEarningsAmount,
            sellerPlanId: group.sellerPlanId,
            sellerPlanSlug: group.sellerPlanSlug,
            commissionTierId: group.commissionTierId,
            commissionBps: group.commissionBps,
            withdrawalFeeBps: group.withdrawalFeeBps,
            currency,
            status: stripeAmount === 0 ? "SUCCEEDED" : "PENDING",
            provider: walletDeduction > 0 && stripeAmount === 0 ? "wallet" : "stripe",
          },
          select: { id: true, vendorEarningsAmount: true, currency: true },
        });

        if (stripeAmount === 0 && payment.vendorEarningsAmount > 0) {
          let vendorWallet = await tx.wallet.findUnique({
            where: { vendorId: group.vendorId },
            select: { id: true },
          });
          if (!vendorWallet) {
            vendorWallet = await tx.wallet.create({
              data: { vendorId: group.vendorId, currency },
              select: { id: true },
            });
          }

          await tx.walletTransaction.create({
            data: {
              walletId: vendorWallet.id,
              vendorId: group.vendorId,
              orderId: order.id,
              paymentId: payment.id,
              type: "PAYMENT_PENDING_CREDIT",
              amount: payment.vendorEarningsAmount,
              currency: payment.currency,
              description: `Pending credit for wallet-paid order ${order.id}`,
            },
          });

          await tx.wallet.update({
            where: { id: vendorWallet.id },
            data: { pendingBalance: { increment: payment.vendorEarningsAmount } },
          });
        }

        // Redeem promo code if applicable for this vendor
        if (promoCodeApplied && group.discountAmount > 0 && group.vendorId === payload.promoVendorId) {
          const promo = await tx.promoCode.findFirst({
            where: { vendorId: group.vendorId, code: promoCodeApplied },
          });
          if (promo) {
            const existingRedemption = await tx.promoRedemption.findFirst({
              where: { orderId: order.id, buyerId },
            });
            if (!existingRedemption) {
              await tx.promoCode.updateMany({
                where: {
                  id: promo.id,
                  isActive: true,
                  usedCount: { lt: promo.maxUses ?? 999999 },
                },
                data: { usedCount: { increment: 1 }, updatedAt: new Date() },
              });
              await tx.promoRedemption.create({
                data: {
                  promoCodeId: promo.id,
                  buyerId,
                  orderId: order.id,
                  discountAmount: group.discountAmount,
                },
              });
            }
          }
        }

        orderIds.push(order.id);
      }

      // If fully paid by wallet, mark checkout as succeeded
      if (stripeAmount === 0) {
        await tx.checkout.update({
          where: { id: checkout.id },
          data: { status: "SUCCEEDED", processedAt: new Date() },
        });

        const buyerCart = await tx.cart.findUnique({ where: { buyerId }, select: { id: true } });
        if (buyerCart) {
          await tx.cartItem.deleteMany({ where: { cartId: buyerCart.id } });
        }
      }

      return { checkoutId: checkout.id, orderIds };
    }, { isolationLevel: "Serializable" });

    // ─── Step 4: Stripe call OUTSIDE transaction (if needed) ───────────────

    if (stripeAmount === 0) {
      // Fully paid by wallet — no Stripe needed
      referralsService.creditReferralBonusOnFirstOrder(buyerId).catch((error) => {
        logger.error("Referral bonus credit failed for wallet-paid checkout", {
          buyerId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

      // ─── Send buyer confirmation email for wallet-paid orders ─────────
      this.sendBuyerConfirmationEmails(buyerId, orderIds, vendorGroups, currency).catch((error) => {
        logger.error("Failed to send buyer confirmation emails for wallet-paid checkout", {
          buyerId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

      // ─── Notify vendors about wallet-paid orders ────────────────────
      this.notifyVendorsWalletPaid(orderIds, vendorGroups).catch((error) => {
        logger.error("Failed to send vendor notifications for wallet-paid checkout", {
          buyerId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

      return {
        paymentIntentId: "",
        clientSecret: "wallet_paid",
        checkoutId,
        orderIds,
        amount: grandTotal,
        currency,
        discountAmount: promoDiscount + campaignDiscountAmount,
        promoCode: promoCodeApplied,
        campaignId: appliedCampaignId,
        campaignTitle: appliedCampaignTitle,
        campaignDiscount: campaignDiscountAmount || undefined,
      };
    }

    const stripeCurrency = resolveStripeCurrency(currency);

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: stripeAmount,
          currency: stripeCurrency,
          automatic_payment_methods: { enabled: true },
          metadata: {
            checkoutId,
            buyerId,
            orderIds: orderIds.join(","),
            vendorIds: vendorGroups.map((g) => g.vendorId).join(","),
            walletDeduction: String(walletDeduction),
            stripeCurrency,
          },
        },
        { idempotencyKey: `pi:checkout:${checkoutId}` },
      );
    } catch (error: unknown) {
      const stripeErr = error as { type?: string; code?: string; message?: string };
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Stripe PaymentIntent creation failed", {
        checkoutId,
        errorMessage: errorMsg,
        stripeType: stripeErr.type,
        stripeCode: stripeErr.code,
      });

      // Card-declined or invalid request → client error
      if (stripeErr.type === "StripeCardError") {
        throw new AppError(stripeErr.message ?? "Card declined", 400, undefined, "CARD_DECLINED");
      }
      if (stripeErr.type === "StripeInvalidRequestError") {
        throw new AppError("Payment request invalid", 400, undefined, "STRIPE_INVALID_REQUEST");
      }
      // All other Stripe / network errors → server error
      throw new AppError("Payment provider unavailable", 502, undefined, "STRIPE_UNAVAILABLE");
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
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      checkoutId,
      orderIds,
      amount: grandTotal,
      currency,
      discountAmount: promoDiscount + campaignDiscountAmount,
      promoCode: promoCodeApplied,
      campaignId: appliedCampaignId,
      campaignTitle: appliedCampaignTitle,
      campaignDiscount: campaignDiscountAmount || undefined,
    };
  }

  /**
   * Send buyer payment confirmation emails for wallet-paid orders.
   */
  private async sendBuyerConfirmationEmails(
    buyerId: string,
    orderIds: string[],
    vendorGroups: VendorGroup[],
    currency: string,
  ): Promise<void> {
    try {
      const buyer = await prisma.user.findUnique({
        where: { id: buyerId },
        select: { email: true, name: true },
      });
      if (!buyer?.email) return;

      for (let i = 0; i < orderIds.length; i++) {
        const group = vendorGroups[i];
        const orderId = orderIds[i];
        if (!group || !orderId) continue;

        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: { orderNumber: true, _count: { select: { items: true } } },
        });
        if (!order) continue;

        const vendor = await prisma.vendor.findUnique({
          where: { id: group.vendorId },
          select: { storeName: true, contactEmail: true },
        });

        const template = emailTemplates.paymentConfirmation({
          name: buyer.name ?? "Valued Customer",
          email: buyer.email,
          orderNumber: order.orderNumber,
          totalAmount: group.totalAmount,
          currency,
          itemCount: order._count.items,
          storeName: vendor?.storeName ?? "Eki Store",
          storeSupportEmail: vendor?.contactEmail ?? undefined,
        });

        await enqueueEmail({
          to: buyer.email,
          subject: template.subject,
          html: template.html,
        });
      }
    } catch (error) {
      logger.error("sendBuyerConfirmationEmails failed", {
        buyerId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Notify vendors about wallet-paid orders (in-app + push).
   */
  private async notifyVendorsWalletPaid(
    orderIds: string[],
    vendorGroups: VendorGroup[],
  ): Promise<void> {
    for (let i = 0; i < orderIds.length; i++) {
      const group = vendorGroups[i];
      const orderId = orderIds[i];
      if (!group || !orderId) continue;

      try {
        const vendor = await prisma.vendor.findUnique({
          where: { id: group.vendorId },
          select: { userId: true, storeName: true },
        });
        if (!vendor?.userId) continue;

        await notificationsService.enqueue({
          userId: vendor.userId,
          type: "ORDER_PAID" as any,
          title: "New order received",
          body: `Order ${orderId} has been paid (wallet).`,
          data: { orderId },
        });
        pushNotifications.vendorNewOrder(vendor.userId, orderId);
      } catch (error) {
        logger.error("notifyVendorsWalletPaid failed", {
          orderId,
          vendorId: group.vendorId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const paymentsService = new PaymentsService();
