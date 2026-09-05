import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { calculateDeliveryFee } from "../../shared/pricing";
import { getFxRate, normalizeMoneyMinor } from "../../shared/fx-normalizer";
import { findGlobalDeliveryZone, resolveVendorDeliveryZone } from "../../shared/delivery-eligibility";
import type { CalculateDeliveryInput, CalculateDeliveryResult, VendorDeliveryEligibility } from "./delivery.types";

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

    // The country the buyer is asking about, and the zone every vendor
    // without their own override falls back to. Legacy callers pass a
    // specific destinationZoneId — that exact zone is used as the fallback,
    // unchanged from previous behavior. Preferred callers pass a country
    // directly, in which case the TRUE shared zone (vendorId: null) for
    // that country is looked up explicitly, rather than trusting whichever
    // zone a caller-side pre-check happened to pick.
    let country: string;
    let globalZone: Awaited<ReturnType<typeof findGlobalDeliveryZone>>;
    if (input.destinationZoneId) {
      const anchorZone = await prisma.deliveryZone.findUnique({ where: { id: input.destinationZoneId } });
      if (!anchorZone) {
        throw new AppError("Delivery zone not available", 404);
      }
      country = anchorZone.country;
      globalZone = anchorZone;
    } else if (input.deliveryCountry) {
      country = input.deliveryCountry;
      globalZone = await findGlobalDeliveryZone(country);
    } else {
      throw new AppError("Either destinationZoneId or deliveryCountry is required", 400);
    }

    // A cart may hold products in different native currencies — the buyer's
    // checkout currency is the ONE currency everything gets normalized
    // into. Default to the cart's first item's currency when the caller
    // doesn't specify one, matching the old single-currency behavior when
    // there's genuinely only one currency in play.
    const checkoutCurrency = (input.checkoutCurrency ?? cart.items[0].product.currency).toLowerCase();

    // Group by vendor — each vendor's delivery eligibility/zone for this
    // country is resolved independently (see resolveVendorDeliveryZone): a
    // valid vendor stays valid even when another vendor in the same cart
    // cannot deliver here.
    const vendorGroups = new Map<string, typeof cart.items>();
    for (const item of cart.items) {
      const existing = vendorGroups.get(item.product.vendorId) ?? [];
      existing.push(item);
      vendorGroups.set(item.product.vendorId, existing);
    }

    const vendors = await prisma.vendor.findMany({
      where: { id: { in: Array.from(vendorGroups.keys()) } },
      select: { id: true, storeName: true },
    });
    const vendorNameById = new Map(vendors.map((v) => [v.id, v.storeName]));

    let subtotalAmount = 0;
    let deliveryAmount = 0;
    let totalWeightGrams = 0;
    const vendorEligibility: VendorDeliveryEligibility[] = [];

    for (const [vendorId, items] of vendorGroups) {
      const vendorWeight = items.reduce((sum, i) => sum + (i.product.weightGrams ?? 0) * i.quantity, 0);
      const vendorCurrency = (items[0]?.product.currency ?? checkoutCurrency).toLowerCase();
      const vendorSubtotalNative = items.reduce((sum, i) => sum + i.product.priceInCents * i.quantity, 0);
      const productIds = items.map((i) => i.productId);
      const productTitles = items.map((i) => i.product.title);

      const resolution = await resolveVendorDeliveryZone(vendorId, country, globalZone);
      if (!resolution.eligible || !resolution.zone) {
        vendorEligibility.push({
          vendorId,
          vendorName: vendorNameById.get(vendorId) ?? "Vendor",
          eligible: false,
          reason: resolution.reason,
          productIds,
          productTitles,
        });
        continue;
      }

      const effectiveZone = resolution.zone;
      const deliveryFeeNative = calculateDeliveryFee({
        baseFeeAmount: effectiveZone.baseFeeAmount,
        feePerKgAmount: effectiveZone.feePerKgAmount,
        totalWeightGrams: vendorWeight,
      });

      const subtotalFx = getFxRate(vendorCurrency, checkoutCurrency);
      const deliveryFx = getFxRate(effectiveZone.currency, checkoutCurrency);

      const normalizedSubtotal = normalizeMoneyMinor(vendorSubtotalNative, vendorCurrency, checkoutCurrency, subtotalFx);
      const normalizedDelivery = normalizeMoneyMinor(deliveryFeeNative, effectiveZone.currency, checkoutCurrency, deliveryFx);

      subtotalAmount += normalizedSubtotal;
      deliveryAmount += normalizedDelivery;
      totalWeightGrams += vendorWeight;

      vendorEligibility.push({
        vendorId,
        vendorName: vendorNameById.get(vendorId) ?? "Vendor",
        eligible: true,
        productIds,
        productTitles,
        subtotalAmount: normalizedSubtotal,
        deliveryAmount: normalizedDelivery,
      });
    }

    return {
      eligible: vendorEligibility.every((v) => v.eligible),
      subtotalAmount,
      deliveryAmount,
      totalAmount: subtotalAmount + deliveryAmount,
      totalWeightGrams,
      currency: checkoutCurrency,
      vendors: vendorEligibility,
    };
  },
};
