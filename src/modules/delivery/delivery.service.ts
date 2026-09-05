import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { calculateDeliveryFee } from "../../shared/pricing";
import { getFxRate, normalizeMoneyMinor } from "../../shared/fx-normalizer";
import type { CalculateDeliveryInput, CalculateDeliveryResult } from "./delivery.types";

export const deliveryService = {
  async calculate(
    buyerId: string,
    input: CalculateDeliveryInput,
  ): Promise<CalculateDeliveryResult> {
    const cart = await prisma.cart.findUnique({
      where: { id: input.cartId },
      include: { items: { include: { product: true } } },
    });

    if (!cart) {
      throw new AppError("Cart not found", 404);
    }
    if (cart.buyerId !== buyerId) {
      throw new AppError("Forbidden", 403);
    }
    if (cart.items.length === 0) {
      throw new AppError("Cart is empty", 400);
    }

    const zone = await prisma.deliveryZone.findUnique({
      where: { id: input.destinationZoneId },
    });
    if (!zone || !zone.isActive) {
      throw new AppError("Delivery zone not available", 404);
    }

    // A cart may hold products in different native currencies — the buyer's
    // checkout currency is the ONE currency everything gets normalized
    // into. Default to the cart's first item's currency when the caller
    // doesn't specify one, matching the old single-currency behavior when
    // there's genuinely only one currency in play.
    const checkoutCurrency = (input.checkoutCurrency ?? cart.items[0].product.currency).toLowerCase();

    // Mirrors payments.service.ts createPaymentIntent: group by vendor,
    // resolve each vendor's own delivery-zone override (falling back to the
    // shared zone when no override exists), sum per-vendor fees — then
    // normalize each vendor group's native subtotal/delivery into the one
    // checkout currency. This estimate is shown to the buyer BEFORE
    // payment, so it must match what actually gets charged.
    const vendorGroups = new Map<string, typeof cart.items>();
    for (const item of cart.items) {
      const existing = vendorGroups.get(item.product.vendorId) ?? [];
      existing.push(item);
      vendorGroups.set(item.product.vendorId, existing);
    }

    let subtotalAmount = 0;
    let deliveryAmount = 0;
    let totalWeightGrams = 0;

    for (const [vendorId, items] of vendorGroups) {
      const vendorWeight = items.reduce((sum, i) => sum + (i.product.weightGrams ?? 0) * i.quantity, 0);
      const vendorCurrency = (items[0]?.product.currency ?? checkoutCurrency).toLowerCase();
      const vendorSubtotalNative = items.reduce((sum, i) => sum + i.product.priceInCents * i.quantity, 0);

      const vendorZone = await prisma.deliveryZone.findFirst({
        where: { vendorId, country: { equals: zone.country, mode: "insensitive" }, isActive: true },
      });
      // No longer requires the zone's own currency to match anything — its
      // native fee gets normalized into the checkout currency below like
      // everything else. Prefer a real vendor-specific zone over the
      // shared/global one whenever one exists for this country.
      const effectiveZone = vendorZone ?? zone;

      const deliveryFeeNative = calculateDeliveryFee({
        baseFeeAmount: effectiveZone.baseFeeAmount,
        feePerKgAmount: effectiveZone.feePerKgAmount,
        totalWeightGrams: vendorWeight,
      });

      const subtotalFx = getFxRate(vendorCurrency, checkoutCurrency);
      const deliveryFx = getFxRate(effectiveZone.currency, checkoutCurrency);

      subtotalAmount += normalizeMoneyMinor(vendorSubtotalNative, vendorCurrency, checkoutCurrency, subtotalFx);
      deliveryAmount += normalizeMoneyMinor(deliveryFeeNative, effectiveZone.currency, checkoutCurrency, deliveryFx);
      totalWeightGrams += vendorWeight;
    }

    return {
      subtotalAmount,
      deliveryAmount,
      totalAmount: subtotalAmount + deliveryAmount,
      totalWeightGrams,
      currency: checkoutCurrency,
    };
  },
};
