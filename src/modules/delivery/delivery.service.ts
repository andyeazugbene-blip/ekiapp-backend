import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { calculateDeliveryFee } from "../../shared/pricing";
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

    const currencies = new Set(cart.items.map((item) => item.product.currency.toLowerCase()));
    if (currencies.size > 1) {
      throw new AppError("Products must use the same currency", 400);
    }

    const cartCurrency = [...currencies][0];
    if (cartCurrency !== zone.currency.toLowerCase()) {
      throw new AppError("Delivery zone currency mismatch", 400);
    }

    // Mirrors payments.service.ts createPaymentIntent exactly: group by
    // vendor, resolve each vendor's own delivery-zone override (falling back
    // to the shared zone when no override exists or the override's currency
    // doesn't match), and sum per-vendor fees. This estimate is shown to the
    // buyer BEFORE payment — it previously applied one flat global-zone fee
    // to the whole cart's combined weight, which silently diverged from the
    // real per-vendor charge computed at actual payment time whenever any
    // vendor had their own zone override (different fee, or a different
    // weight split across vendors).
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
      const vendorSubtotal = items.reduce((sum, i) => sum + i.product.priceInCents * i.quantity, 0);

      const vendorZone = await prisma.deliveryZone.findFirst({
        where: { vendorId, country: { equals: zone.country, mode: "insensitive" }, isActive: true },
      });
      const effectiveZone =
        vendorZone && vendorZone.currency.toLowerCase() === cartCurrency ? vendorZone : zone;

      subtotalAmount += vendorSubtotal;
      totalWeightGrams += vendorWeight;
      deliveryAmount += calculateDeliveryFee({
        baseFeeAmount: effectiveZone.baseFeeAmount,
        feePerKgAmount: effectiveZone.feePerKgAmount,
        totalWeightGrams: vendorWeight,
      });
    }

    return {
      subtotalAmount,
      deliveryAmount,
      totalAmount: subtotalAmount + deliveryAmount,
      totalWeightGrams,
      currency: cartCurrency,
    };
  },
};
