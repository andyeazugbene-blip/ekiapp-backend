import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import {
  SELLER_READINESS_SELECT,
  SELLER_REASON_MESSAGES,
  assessSellerReadiness,
  isSellerReadinessGateEnabled,
} from "../products/seller-readiness";
import { buildVendorShareUrl } from "./vendors.service";

/**
 * Vendor-activation spec: "Vendors should be able to preview their complete
 * storefront before it becomes publicly visible." The real public store
 * page (getStoreBySlug/listStoreProducts) only ever shows isActive=true
 * products — exactly what it should show a buyer. This is the OTHER view:
 * authenticated, scoped to the calling vendor's own products, and includes
 * PENDING_ACTIVATION listings so they can see what buyers will see once
 * verification completes, each clearly marked as not yet live.
 */
export interface StorePreviewProduct {
  id: string;
  title: string;
  description: string | null;
  priceInCents: number;
  currency: string;
  images: string[];
  category: string | null;
  stock: number;
  status: "PUBLISHED" | "PENDING_ACTIVATION";
  visibleToBuyers: boolean;
}

export const vendorStorePreviewService = {
  async getPreview(userId: string): Promise<{
    vendorId: string;
    storeName: string;
    storeSlug: string;
    shareUrl: string;
    description: string | null;
    avatar: string | null;
    coverImage: string | null;
    city: string | null;
    country: string | null;
    verificationStatus: "PENDING" | "VERIFIED" | "REJECTED";
    products: StorePreviewProduct[];
  }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: {
        id: true,
        storeName: true,
        storeSlug: true,
        description: true,
        avatar: true,
        coverImage: true,
        city: true,
        country: true,
        verificationStatus: true,
      },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const rows = await prisma.product.findMany({
      where: { vendorId: vendor.id, status: { in: ["PUBLISHED", "PENDING_ACTIVATION"] } },
      orderBy: CURSOR_ORDER_BY,
      select: {
        id: true,
        title: true,
        description: true,
        priceInCents: true,
        currency: true,
        images: true,
        category: true,
        stock: true,
        status: true,
      },
    });

    return {
      vendorId: vendor.id,
      storeName: vendor.storeName,
      storeSlug: vendor.storeSlug,
      shareUrl: buildVendorShareUrl(vendor.storeSlug),
      description: vendor.description,
      avatar: vendor.avatar,
      coverImage: vendor.coverImage,
      city: vendor.city,
      country: vendor.country,
      verificationStatus: vendor.verificationStatus,
      products: rows.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        priceInCents: p.priceInCents,
        currency: p.currency,
        images: p.images,
        category: p.category,
        stock: p.stock,
        status: p.status as "PUBLISHED" | "PENDING_ACTIVATION",
        visibleToBuyers: p.status === "PUBLISHED",
      })),
    };
  },

  /**
   * Found 15 Oct 2026: a vendor whose Stripe charges/payouts are off has
   * every one of their PUBLISHED products silently hidden from buyers
   * (see seller-readiness.ts's purchasableVendorWhere, used by
   * listActiveProducts whenever SELLER_PAYMENT_READINESS_GATE is on) —
   * but their own app shows those listings as plain "Published" with no
   * indication buyers can't actually find them. This is the one call the
   * vendor app needs to know whether to show that warning.
   */
  async getReadiness(userId: string): Promise<{
    gateEnabled: boolean;
    ready: boolean;
    reason: string | null;
    message: string | null;
  }> {
    const vendor = await prisma.vendor.findUnique({ where: { userId }, select: SELLER_READINESS_SELECT });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }
    const gateEnabled = isSellerReadinessGateEnabled();
    const a = assessSellerReadiness(vendor);
    return {
      gateEnabled,
      // Not purchasable only MATTERS to a buyer while the gate is actually
      // on — report true (nothing to warn about) when it's off, same
      // convention admin-products.service.ts already uses for
      // notPurchasableReason.
      ready: !gateEnabled || a.ready,
      reason: gateEnabled ? a.reason : null,
      message: gateEnabled && a.reason ? SELLER_REASON_MESSAGES[a.reason] : null,
    };
  },
};
