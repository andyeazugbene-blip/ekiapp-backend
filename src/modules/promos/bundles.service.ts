import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { buildVendorShareUrl } from "../vendors/vendors.service";
import { subscriptionsService } from "../subscriptions/subscriptions.service";

/**
 * Real, structured Bundle data (client mandate 2026-09) — replaces the old
 * "PromoCode whose code starts with BUNDLE" hack. bundlePriceMinor/name/
 * currency/productIds are now persisted for real instead of only surviving
 * as a derived discount amount that list views couldn't reconstruct.
 *
 * Checkout-time application is unchanged: a Bundle still creates a linked
 * PromoCode (promoCodeId) — the SAME already-proven redeemPromo() path
 * this codebase's real, working discount system already uses — so no
 * checkout logic needed to change.
 */

function generateBundleCode(): string {
  const date = new Date();
  return `BUNDLE${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function requireVendor(userId: string) {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true, storeSlug: true, isSuspended: true } });
  if (!vendor || vendor.isSuspended) throw new AppError("Vendor profile not found", 404);
  return vendor;
}

function shareUrl(storeSlug: string, code: string): string {
  const base = buildVendorShareUrl(storeSlug);
  return `${base}?promo=${encodeURIComponent(code)}`;
}

export const bundlesService = {
  async create(userId: string, input: { name: string; productIds: string[]; bundlePriceMinor: number; currency: string; quantityAvailable?: number | null }) {
    const vendor = await requireVendor(userId);
    await subscriptionsService.enforceBundleLimit(vendor.id);

    const name = input.name.trim();
    if (!name) throw new AppError("Bundle name is required", 400);
    const productIds = Array.from(new Set(input.productIds));
    if (productIds.length < 2) throw new AppError("A bundle needs at least 2 products", 400);
    if (!Number.isInteger(input.bundlePriceMinor) || input.bundlePriceMinor <= 0) {
      throw new AppError("Bundle price must be a positive amount", 400);
    }
    // Optional — an unset/null quantity means unlimited (no maxUses on the
    // linked PromoCode). When set, reuses PromoCode's real, already-proven
    // maxUses/usedCount enforcement (an atomic guarded UPDATE at redemption
    // time in promos.service.ts) rather than inventing a second, parallel
    // stock-tracking mechanism for the same underlying limit.
    if (input.quantityAvailable != null && (!Number.isInteger(input.quantityAvailable) || input.quantityAvailable <= 0)) {
      throw new AppError("Bundle quantity available must be a positive whole number", 400);
    }

    const products = await prisma.product.findMany({ where: { vendorId: vendor.id, id: { in: productIds } } });
    if (products.length !== productIds.length) {
      throw new AppError("One or more selected products do not belong to this store", 400);
    }
    const regularTotal = products.reduce((sum, p) => sum + p.priceInCents, 0);
    if (input.bundlePriceMinor >= regularTotal) {
      throw new AppError("Bundle price must be lower than the selected products' combined regular price", 400);
    }
    const currency = input.currency || products[0]?.currency || "EUR";

    const code = generateBundleCode();
    const discountValue = regularTotal - input.bundlePriceMinor;

    return prisma.$transaction(async (tx) => {
      const promo = await tx.promoCode.create({
        data: { vendorId: vendor.id, code, type: "FIXED_AMOUNT", value: discountValue, isActive: true, maxUses: input.quantityAvailable ?? null },
      });
      const bundle = await tx.bundle.create({
        data: {
          vendorId: vendor.id,
          name,
          bundlePriceMinor: input.bundlePriceMinor,
          currency,
          promoCodeId: promo.id,
          items: { create: productIds.map((productId) => ({ productId })) },
        },
        include: { items: { include: { product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true } } } }, promoCode: { select: { code: true, maxUses: true, usedCount: true } } },
      });
      return {
        ...bundle,
        regularPriceMinor: regularTotal,
        shareUrl: shareUrl(vendor.storeSlug, code),
        quantityAvailable: bundle.promoCode?.maxUses ?? null,
        quantitySold: bundle.promoCode?.usedCount ?? 0,
      };
    });
  },

  async listMine(userId: string) {
    const vendor = await requireVendor(userId);
    const bundles = await prisma.bundle.findMany({
      where: { vendorId: vendor.id },
      include: { items: { include: { product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true } } } }, promoCode: { select: { code: true, maxUses: true, usedCount: true } } },
      orderBy: { createdAt: "desc" },
    });
    return bundles.map((b) => ({
      ...b,
      regularPriceMinor: b.items.reduce((sum, i) => sum + i.product.priceInCents, 0),
      shareUrl: shareUrl(vendor.storeSlug, b.promoCode?.code ?? ""),
      quantityAvailable: b.promoCode?.maxUses ?? null,
      quantitySold: b.promoCode?.usedCount ?? 0,
    }));
  },

  async setActive(userId: string, bundleId: string, isActive: boolean) {
    const vendor = await requireVendor(userId);
    const bundle = await prisma.bundle.findFirst({ where: { id: bundleId, vendorId: vendor.id } });
    if (!bundle) throw new AppError("Bundle not found", 404);
    return prisma.$transaction(async (tx) => {
      if (bundle.promoCodeId) {
        await tx.promoCode.update({ where: { id: bundle.promoCodeId }, data: { isActive } });
      }
      return tx.bundle.update({ where: { id: bundleId }, data: { isActive } });
    });
  },

  async remove(userId: string, bundleId: string) {
    const vendor = await requireVendor(userId);
    const bundle = await prisma.bundle.findFirst({ where: { id: bundleId, vendorId: vendor.id }, include: { promoCode: { select: { usedCount: true } } } });
    if (!bundle) throw new AppError("Bundle not found", 404);
    if (bundle.promoCode && bundle.promoCode.usedCount > 0) {
      throw new AppError("Cannot delete a bundle that has already been purchased", 409);
    }
    await prisma.bundle.delete({ where: { id: bundleId } });
  },

  /** Public storefront read — real active, not-sold-out bundles only, from the real table, not a prefix scan. */
  async listPublic() {
    const bundles = await prisma.bundle.findMany({
      where: { isActive: true },
      include: {
        vendor: { select: { storeName: true, storeSlug: true } },
        items: { include: { product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true } } } },
        promoCode: { select: { code: true, maxUses: true, usedCount: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return bundles
      .filter((b) => b.promoCode?.maxUses == null || b.promoCode.usedCount < b.promoCode.maxUses)
      .map((b) => ({
        id: b.id,
        vendorId: b.vendorId,
        storeName: b.vendor.storeName,
        name: b.name,
        quantityAvailable: b.promoCode?.maxUses != null ? Math.max(0, b.promoCode.maxUses - b.promoCode.usedCount) : null,
        bundlePriceMinor: b.bundlePriceMinor,
        regularPriceMinor: b.items.reduce((sum, i) => sum + i.product.priceInCents, 0),
        currency: b.currency,
        productIds: b.items.map((i) => i.productId),
        shareUrl: shareUrl(b.vendor.storeSlug, b.promoCode?.code ?? ""),
      }));
  },
};
