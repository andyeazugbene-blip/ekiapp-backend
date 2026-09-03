import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { buildVendorShareUrl } from "../vendors/vendors.service";

/**
 * Real, structured Flash Sale data (client mandate 2026-09) — replaces the
 * old "PromoCode whose code starts with FLASH" hack. salePriceMinor/
 * currency/dates are now persisted for real, with real start/end
 * validation this never had before.
 *
 * Checkout-time application is unchanged: a Flash Sale still creates a
 * linked PromoCode (promoCodeId) — the same already-proven redeemPromo()
 * path this codebase's real, working discount system already uses.
 */

export type FlashSaleStatus = "UPCOMING" | "ACTIVE" | "EXPIRED" | "INACTIVE";

function computeStatus(now: Date, startsAt: Date, endsAt: Date, isActive: boolean): FlashSaleStatus {
  if (!isActive) return "INACTIVE";
  if (now < startsAt) return "UPCOMING";
  if (now > endsAt) return "EXPIRED";
  return "ACTIVE";
}

function generateFlashCode(): string {
  const date = new Date();
  return `FLASH${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
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

export const flashSalesService = {
  async create(userId: string, input: { productId: string; salePriceMinor: number; currency: string; startsAt: string; endsAt: string }) {
    const vendor = await requireVendor(userId);

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new AppError("startsAt/endsAt must be valid dates", 400);
    }
    // Real date-order validation — never existed before this. A flash sale
    // that ends before (or at the same moment) it starts is meaningless.
    if (endsAt <= startsAt) {
      throw new AppError("endsAt must be after startsAt", 400);
    }
    if (!Number.isInteger(input.salePriceMinor) || input.salePriceMinor <= 0) {
      throw new AppError("Sale price must be a positive amount", 400);
    }

    const product = await prisma.product.findFirst({ where: { id: input.productId, vendorId: vendor.id } });
    if (!product) throw new AppError("Selected product does not belong to this store", 400);
    if (input.salePriceMinor >= product.priceInCents) {
      throw new AppError("Sale price must be lower than the product's regular price", 400);
    }
    const currency = input.currency || product.currency;
    const discountValue = product.priceInCents - input.salePriceMinor;
    const code = generateFlashCode();

    const flashSale = await prisma.$transaction(async (tx) => {
      const promo = await tx.promoCode.create({
        data: { vendorId: vendor.id, code, type: "FIXED_AMOUNT", value: discountValue, validFrom: startsAt, validUntil: endsAt, isActive: true },
      });
      return tx.flashSale.create({
        data: { vendorId: vendor.id, productId: input.productId, salePriceMinor: input.salePriceMinor, currency, startsAt, endsAt, promoCodeId: promo.id },
        include: { product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true } }, promoCode: { select: { code: true } } },
      });
    });

    return { ...flashSale, status: computeStatus(new Date(), flashSale.startsAt, flashSale.endsAt, flashSale.isActive), shareUrl: shareUrl(vendor.storeSlug, code) };
  },

  async listMine(userId: string) {
    const vendor = await requireVendor(userId);
    const flashSales = await prisma.flashSale.findMany({
      where: { vendorId: vendor.id },
      include: { product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true } }, promoCode: { select: { code: true, usedCount: true } } },
      orderBy: { startsAt: "desc" },
    });
    const now = new Date();
    return flashSales.map((f) => ({
      ...f,
      status: computeStatus(now, f.startsAt, f.endsAt, f.isActive),
      shareUrl: shareUrl(vendor.storeSlug, f.promoCode?.code ?? ""),
    }));
  },

  async setActive(userId: string, flashSaleId: string, isActive: boolean) {
    const vendor = await requireVendor(userId);
    const flashSale = await prisma.flashSale.findFirst({ where: { id: flashSaleId, vendorId: vendor.id } });
    if (!flashSale) throw new AppError("Flash sale not found", 404);
    return prisma.$transaction(async (tx) => {
      if (flashSale.promoCodeId) {
        await tx.promoCode.update({ where: { id: flashSale.promoCodeId }, data: { isActive } });
      }
      return tx.flashSale.update({ where: { id: flashSaleId }, data: { isActive } });
    });
  },

  async remove(userId: string, flashSaleId: string) {
    const vendor = await requireVendor(userId);
    const flashSale = await prisma.flashSale.findFirst({ where: { id: flashSaleId, vendorId: vendor.id }, include: { promoCode: { select: { usedCount: true } } } });
    if (!flashSale) throw new AppError("Flash sale not found", 404);
    if (flashSale.promoCode && flashSale.promoCode.usedCount > 0) {
      throw new AppError("Cannot delete a flash sale that has already been purchased", 409);
    }
    await prisma.flashSale.delete({ where: { id: flashSaleId } });
  },

  /** Public storefront read — real ACTIVE-by-date flash sales only, from the real table, not a prefix scan. */
  async listPublic() {
    const now = new Date();
    const flashSales = await prisma.flashSale.findMany({
      where: { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } },
      include: {
        vendor: { select: { storeName: true, storeSlug: true } },
        product: { select: { id: true, title: true, priceInCents: true, currency: true, images: true } },
        promoCode: { select: { code: true } },
      },
      orderBy: { endsAt: "asc" },
    });
    return flashSales.map((f) => ({
      id: f.id,
      vendorId: f.vendorId,
      storeName: f.vendor.storeName,
      productId: f.productId,
      productTitle: f.product.title,
      salePriceMinor: f.salePriceMinor,
      regularPriceMinor: f.product.priceInCents,
      currency: f.currency,
      startsAt: f.startsAt.toISOString(),
      endsAt: f.endsAt.toISOString(),
      shareUrl: shareUrl(f.vendor.storeSlug, f.promoCode?.code ?? ""),
    }));
  },
};
