import crypto from "crypto";

import type { Prisma } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { calculatePlatformFee as calcPlatformFee } from "../../shared/pricing";
import { referralsService } from "../referrals/referrals.service";
import { rewardsService } from "../rewards/rewards.service";
import { resolveVendorCommission } from "../subscriptions/subscription-plan-utils";
import { promosService } from "../promos/promos.service";
import { campaignsService } from "../campaigns/campaigns.service";
import { validateCreatePaymentIntentFromCartInput } from "./payments.validation";
import type { CreatePaymentIntentResponse, PricedOrderItem } from "./payments.types";

import { MAX_VENDOR_WEIGHT_GRAMS } from "../../shared/constants";
import { resolveStripeCurrency } from "../../shared/currency";
import { getFxRate, normalizeMoneyMinor } from "../../shared/fx-normalizer";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { notificationsService } from "../notifications/notifications.service";
import { communicationService } from "../communications/communication.service";

interface VendorGroup {
  vendorId: string;
  items: PricedOrderItem[];
  /** This vendor's own native currency — Product.currency inherits from
   * Vendor.currency, so every item within one vendor group already shares
   * this. subtotal/delivery/total/earnings below are ALL in this currency —
   * conversion into the checkout currency happens only once, at the end,
   * for the Stripe charge total (see normalizedTotalAmount). */
  currency: string;
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
  /** This order's totalAmount converted into the checkout currency — the
   * amount that actually contributes to the single Stripe charge. Equal to
   * totalAmount when currency === checkoutCurrency. */
  normalizedTotalAmount: number;
  exchangeRate: number | null;
  exchangeRateTimestamp: Date | null;
  exchangeRateSource: string | null;
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

    // A cart may hold products in different native currencies. The
    // CHECKOUT currency is the ONE currency everything gets normalized
    // into and the ONE currency Stripe ever sees — never per-vendor-group
    // currencies mixed into one charge. Defaults to the first item's
    // native currency when the buyer hasn't explicitly chosen one.
    const checkoutCurrency = (payload.checkoutCurrency ?? pricedItems[0].currency).toLowerCase();

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

    // No currency requirement on the shared zone anymore — its native fee
    // gets normalized into each vendor's own currency below, same as any
    // vendor-specific zone override.

    // ─── Step 2c: Per-vendor delivery validation + weight check ────────────

    const vendorGroups: VendorGroup[] = [];
    for (const [vendorId, items] of vendorMap) {
      const vendorCurrency = items[0].currency.toLowerCase();
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
          country: { equals: zone.country, mode: "insensitive" },
          isActive: true,
        },
      });
      const effectiveZone = vendorZone ?? zone;

      const deliveryFeeInZoneCurrency = effectiveZone.baseFeeAmount + Math.ceil(totalWeight / 1000) * effectiveZone.feePerKgAmount;
      // Normalize the zone's native fee into THIS vendor's currency so the
      // order's own subtotal/delivery/total stay in one consistent
      // currency throughout — exactly as they always have been. The
      // separate normalization into the checkout currency happens once,
      // below, on the order's already-native total.
      const deliveryFee = effectiveZone.currency.toLowerCase() === vendorCurrency
        ? deliveryFeeInZoneCurrency
        : normalizeMoneyMinor(deliveryFeeInZoneCurrency, effectiveZone.currency, vendorCurrency, getFxRate(effectiveZone.currency, vendorCurrency));

      const commission = await resolveVendorCommission(vendorId, subtotal);
      if (!commission.canReceiveOrders) {
        throw new AppError("This vendor's plan does not allow receiving orders", 403);
      }
      const platformFee = calcPlatformFee(subtotal, commission.platformFeeBps);
      const totalAmount = subtotal + deliveryFee;
      const vendorEarnings = totalAmount - platformFee;

      const needsConversion = vendorCurrency !== checkoutCurrency;
      const fx = needsConversion ? getFxRate(vendorCurrency, checkoutCurrency) : null;

      vendorGroups.push({
        vendorId,
        items,
        currency: vendorCurrency,
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
        normalizedTotalAmount: fx ? normalizeMoneyMinor(totalAmount, vendorCurrency, checkoutCurrency, fx) : totalAmount,
        exchangeRate: fx?.rate ?? null,
        exchangeRateTimestamp: fx?.timestamp ?? null,
        exchangeRateSource: fx?.source ?? null,
      });
    }

    // The buyer-facing grand total is the sum of every order's amount
    // ALREADY converted into the one checkout currency — this is what
    // Stripe is ever asked to charge, never a per-vendor native amount.
    let grandTotal = vendorGroups.reduce((sum, g) => sum + g.normalizedTotalAmount, 0);
    const buyerId = cart.buyerId;

    // ─── Step 2e: Promo code validation ────────────────────────────────────

    let promoDiscount = 0;
    let promoCodeApplied: string | undefined;
    // Hoisted to function scope (not just the `if` block below) so the
    // $transaction closure further down — which redeems the promo code and
    // increments usedCount — can see the SAME auto-resolved vendor id used
    // for the discount calculation, instead of falling back to the raw,
    // often-undefined `payload.promoVendorId` input field and silently
    // never recording the redemption (see the real bug this fixed: a
    // buyer who omits promoVendorId, the normal case, could reuse a
    // maxUses:1 coupon indefinitely because usedCount was never incremented).
    let promoVendorId: string | undefined;
    if (payload.promoCode) {
      // Auto-resolve vendor from promo code if promoVendorId not provided
      promoVendorId = payload.promoVendorId;
      if (!promoVendorId) {
        const promoRecord = await prisma.promoCode.findFirst({
          where: { code: payload.promoCode, isActive: true },
          select: { vendorId: true },
        });
        promoVendorId = promoRecord?.vendorId;
      }
      if (!promoVendorId) {
        throw new AppError("Invalid promo code", 400);
      }
      const targetGroup = vendorGroups.find((g) => g.vendorId === promoVendorId);
      if (!targetGroup) {
        throw new AppError("Promo code vendor is not in this cart", 400);
      }
      const orderAmountCents = targetGroup.subtotalAmount;
      const validation = await promosService.validatePromo(buyerId, {
        code: payload.promoCode,
        orderAmount: orderAmountCents,
        vendorId: promoVendorId,
      });
      promoDiscount = validation.discountAmount;
      promoCodeApplied = payload.promoCode;

      // Apply discount to the target vendor group (native currency, unchanged)
      targetGroup.discountAmount = promoDiscount;
      targetGroup.subtotalAmount = Math.max(0, targetGroup.subtotalAmount - promoDiscount);
      // Recalculate platform fee and earnings on discounted subtotal
      const commission = await resolveVendorCommission(targetGroup.vendorId, targetGroup.subtotalAmount);
      targetGroup.platformFeeAmount = calcPlatformFee(targetGroup.subtotalAmount, commission.platformFeeBps);
      targetGroup.totalAmount = targetGroup.subtotalAmount + targetGroup.deliveryFeeAmount;
      targetGroup.vendorEarningsAmount = targetGroup.totalAmount - targetGroup.platformFeeAmount;
      // Re-derive the checkout-currency contribution from the discounted
      // native total using the SAME rate snapshot already taken for this
      // group — never re-fetch a fresh rate mid-calculation.
      targetGroup.normalizedTotalAmount = targetGroup.exchangeRate
        ? normalizeMoneyMinor(targetGroup.totalAmount, targetGroup.currency, checkoutCurrency, {
            rate: targetGroup.exchangeRate,
            timestamp: targetGroup.exchangeRateTimestamp ?? new Date(),
            source: targetGroup.exchangeRateSource ?? "eki_static_reference_v1",
          })
        : targetGroup.totalAmount;
      grandTotal = vendorGroups.reduce((sum, group) => sum + group.normalizedTotalAmount, 0);
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
      if (buyerWallet.currency.toLowerCase() !== checkoutCurrency) {
        throw new AppError("Wallet currency must match checkout currency", 400);
      }
      if (payload.walletAmount > buyerWallet.balance) {
        throw new AppError("Insufficient wallet balance", 400);
      }
      // If wallet amount covers grand total (or is within rounding tolerance from
      // frontend units→cents conversion + delivery fee variance), use full grand
      // total as deduction.
      const walletShortfall = grandTotal - payload.walletAmount;
      if (walletShortfall <= 0) {
        walletDeduction = grandTotal;
      } else if (walletShortfall <= 200 && buyerWallet.balance >= grandTotal) {
        walletDeduction = grandTotal;
      } else {
        walletDeduction = payload.walletAmount;
      }
    }

    const stripeAmount = grandTotal - walletDeduction;

    // A card charge must be created in the same currency the buyer was
    // shown. resolveStripeCurrency() falls back to EUR for currencies
    // Stripe doesn't support (e.g. GHS) — but that fallback only swaps the
    // currency *code*, not the amount, which would silently submit the
    // GHS-denominated integer as EUR cents (an ~17x overcharge in the wrong
    // currency). Reject before any stock/wallet is reserved rather than
    // invent an FX conversion no one has approved.
    if (stripeAmount > 0 && resolveStripeCurrency(checkoutCurrency) !== checkoutCurrency) {
      throw new AppError(
        `Card payments are not currently available in ${checkoutCurrency.toUpperCase()}. Please contact support.`,
        400,
        undefined,
        "CURRENCY_NOT_SUPPORTED",
      );
    }

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
              currency: checkoutCurrency,
              description: "Order payment (wallet)",
            },
          });
        }
      }

      // Resolve Stripe-compatible currency (Italy account may not support some local currencies)
      const stripeCurrency = resolveStripeCurrency(checkoutCurrency);

      // Create Checkout record
      const checkout = await tx.checkout.create({
        data: {
          buyerId,
          totalAmount: grandTotal,
          currency: checkoutCurrency,
          status: "PENDING",
          metadata: {
            vendorGroups: vendorGroups.map((g) => ({
              vendorId: g.vendorId,
              currency: g.currency,
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
              normalizedTotalAmount: g.normalizedTotalAmount,
              exchangeRate: g.exchangeRate,
              exchangeRateSource: g.exchangeRateSource,
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
        const orderNumber = `Eki-${crypto.randomBytes(3).toString("hex").slice(0, 5).toUpperCase()}`;

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
            currency: group.currency,
            checkoutCurrency: group.currency !== checkoutCurrency ? checkoutCurrency : null,
            normalizedTotalAmount: group.currency !== checkoutCurrency ? group.normalizedTotalAmount : null,
            exchangeRate: group.exchangeRate,
            exchangeRateTimestamp: group.exchangeRateTimestamp,
            exchangeRateSource: group.exchangeRateSource,
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
            currency: group.currency,
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
              data: { vendorId: group.vendorId, currency: group.currency },
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
        if (promoCodeApplied && group.discountAmount > 0 && group.vendorId === promoVendorId) {
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

        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
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

      rewardsService.grantCampaignGiftCards(buyerId).catch((error) => {
        logger.error("Campaign gift card grant failed for wallet-paid checkout", {
          buyerId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });

      // ─── Send buyer confirmation email for wallet-paid orders ─────────
      this.sendBuyerConfirmationEmails(buyerId, orderIds, vendorGroups, checkoutCurrency).catch((error) => {
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
        currency: checkoutCurrency,
        discountAmount: promoDiscount + campaignDiscountAmount,
        promoCode: promoCodeApplied,
        campaignId: appliedCampaignId,
        campaignTitle: appliedCampaignTitle,
        campaignDiscount: campaignDiscountAmount || undefined,
        conversionApplied: vendorGroups.some((g) => g.currency !== checkoutCurrency),
      };
    }

    const stripeCurrency = resolveStripeCurrency(checkoutCurrency);

    // Provider-safety assert (defense in depth, per architecture
    // requirement: no mixed-currency payment may ever reach Stripe). Every
    // vendor group's contribution to grandTotal was already normalized
    // into checkoutCurrency above — this recomputes that sum independently
    // right before the charge and refuses to proceed if it has drifted,
    // rather than trusting the earlier calculation blindly.
    const recomputedTotal = vendorGroups.reduce((sum, g) => sum + g.normalizedTotalAmount, 0) - campaignDiscountAmount;
    if (Math.abs(recomputedTotal - grandTotal) > 0) {
      throw new AppError("Internal currency/total mismatch before payment — refusing to charge", 500, undefined, "CHECKOUT_TOTAL_MISMATCH");
    }

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

      await this.rollbackFailedCheckout({ checkoutId, orderIds, pricedItems, walletDeduction, buyerId, currency: checkoutCurrency });

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
      await this.rollbackFailedCheckout({ checkoutId, orderIds, pricedItems, walletDeduction, buyerId, currency: checkoutCurrency });
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
      currency: checkoutCurrency,
      discountAmount: promoDiscount + campaignDiscountAmount,
      promoCode: promoCodeApplied,
      campaignId: appliedCampaignId,
      campaignTitle: appliedCampaignTitle,
      campaignDiscount: campaignDiscountAmount || undefined,
      conversionApplied: vendorGroups.some((g) => g.currency !== checkoutCurrency),
    };
  }

  /**
   * Undo the stock/wallet reservations made inside the checkout transaction
   * when the Stripe PaymentIntent call afterward fails. Without this, a
   * declined card or a Stripe outage leaves stock permanently decremented
   * and the buyer's wallet permanently debited behind a PENDING order that
   * only the (Redis-dependent) cart-cleanup worker would ever reconcile.
   */
  private async rollbackFailedCheckout(params: {
    checkoutId: string;
    orderIds: string[];
    pricedItems: PricedOrderItem[];
    walletDeduction: number;
    buyerId: string;
    currency: string;
  }): Promise<void> {
    const { checkoutId, orderIds, pricedItems, walletDeduction, buyerId, currency } = params;
    try {
      await prisma.$transaction(async (tx) => {
        for (const item of pricedItems) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          });
        }

        if (walletDeduction > 0) {
          const wallet = await tx.buyerWallet.update({
            where: { buyerId },
            data: { balance: { increment: walletDeduction } },
          });
          await tx.buyerWalletTransaction.create({
            data: {
              walletId: wallet.id,
              buyerId,
              type: "REFUND_CREDIT",
              amount: walletDeduction,
              currency,
              description: "Payment failed — wallet debit reversed",
            },
          });
        }

        await tx.order.updateMany({
          where: { id: { in: orderIds } },
          data: { status: "FAILED" },
        });
        await tx.payment.updateMany({
          where: { orderId: { in: orderIds } },
          data: { status: "FAILED" },
        });
        await tx.checkout.update({
          where: { id: checkoutId },
          data: { status: "FAILED" },
        });
      });
    } catch (rollbackError) {
      logger.error("rollbackFailedCheckout failed — stock/wallet may be stuck until the cart-cleanup sweep runs", {
        checkoutId,
        errorMessage: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
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
        if (!vendor?.userId) {
          logger.warn("Vendor missing userId — vendor will NOT be notified for wallet order", { orderId, vendorId: group.vendorId });
          continue;
        }

        // Single send — enqueue() already sends the push, matching the
        // vendor-new-order notification used for Stripe-paid orders.
        await notificationsService.enqueue({
          userId: vendor.userId,
          type: "BALANCE_CREDITED" as any,
          title: "New Order! 🛒",
          body: "You have a new order to process.",
          data: { type: "new_order", orderId },
        });

        const vendorOrderCount = await prisma.order.count({
          where: { vendorId: group.vendorId, status: { notIn: ["PENDING", "FAILED"] } },
        }).catch(() => 0);
        if (vendorOrderCount === 1) {
          communicationService.send({
            eventKey: "vendor_first_order",
            recipientId: vendor.userId,
            variables: { store_name: vendor.storeName ?? "Your store", order_number: orderId },
          }).catch(() => {});
        }
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
