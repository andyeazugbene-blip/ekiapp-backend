import type { Prisma } from "@prisma/client";

import { env } from "../../config/env";
import { sendEmail } from "../../lib/email";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { isProductComplete } from "../products/products.service";
import {
  SELLER_READINESS_SELECT,
  SELLER_REASON_MESSAGES,
  assessSellerReadiness,
  isSellerReadinessGateEnabled,
} from "../products/seller-readiness";

/**
 * Handbook 14.6 admin product moderation.
 *
 * productType is DERIVED (no column): a product linked to a Regular Delivery
 * offer (SubscriptionOfferProduct) is "REGULAR_DELIVERY" (customer-facing name
 * "Foodstuffs Subscription"); everything else is "STANDARD". Community Buy
 * campaigns carry their own product fields and are NOT Product rows, so the
 * COMMUNITY_BUY filter is accepted but matches no catalogue product.
 */
export type ProductType = "STANDARD" | "COMMUNITY_BUY" | "REGULAR_DELIVERY";
export type ProductStatus = "ACTIVE" | "DISABLED" | "DRAFT";

const MAX_LIMIT = 100;
const VENDOR_LIST_SELECT = {
  storeName: true,
  userId: true,
  country: true,
  currency: true,
  ...SELLER_READINESS_SELECT,
} as const;

function productStatus(p: { isActive: boolean; adminUnpublishedAt: Date | null }, vendor: { isSuspended: boolean } | null): ProductStatus {
  if (p.isActive) return "ACTIVE";
  if (p.adminUnpublishedAt || vendor?.isSuspended) return "DISABLED";
  return "DRAFT";
}

function readinessView(vendor: Parameters<typeof assessSellerReadiness>[0]) {
  const a = assessSellerReadiness(vendor);
  return {
    ready: a.ready,
    reason: a.reason,
    message: a.reason ? SELLER_REASON_MESSAGES[a.reason] : null,
    gateEnabled: isSellerReadinessGateEnabled(),
  };
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) throw new AppError(`Invalid limit (1-${MAX_LIMIT})`, 400);
  return n;
}

function str(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

export const adminProductsService = {
  async listProducts(query: Record<string, unknown>) {
    const limit = parseLimit(query.limit);
    const cursor = str(query.cursor);
    const and: Prisma.ProductWhereInput[] = [];

    const q = str(query.q);
    if (q) {
      and.push({
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { productCode: { contains: q, mode: "insensitive" } },
          { vendor: { storeName: { contains: q, mode: "insensitive" } } },
        ],
      });
    }

    // Legacy ?isActive=true|false still accepted.
    let status = str(query.status)?.toUpperCase();
    if (!status && query.isActive === "true") status = "ACTIVE";
    if (!status && query.isActive === "false") status = "INACTIVE";
    if (status === "ACTIVE") and.push({ isActive: true });
    else if (status === "DISABLED") and.push({ isActive: false, OR: [{ adminUnpublishedAt: { not: null } }, { vendor: { isSuspended: true } }] });
    else if (status === "DRAFT") and.push({ isActive: false, adminUnpublishedAt: null, vendor: { isSuspended: false } });
    else if (status === "INACTIVE") and.push({ isActive: false });
    else if (status && status !== "ALL") throw new AppError("Invalid status (active, disabled, draft)", 400);

    const category = str(query.category);
    if (category) and.push({ category: { equals: category, mode: "insensitive" } });
    const vendorId = str(query.vendorId);
    if (vendorId) and.push({ vendorId });

    const type = str(query.productType)?.toUpperCase();
    if (type === "REGULAR_DELIVERY") and.push({ subscriptionOfferProducts: { some: {} } });
    else if (type === "STANDARD") and.push({ subscriptionOfferProducts: { none: {} } });
    else if (type === "COMMUNITY_BUY") and.push({ id: { in: [] } });
    else if (type && type !== "ALL") throw new AppError("Invalid productType (STANDARD, COMMUNITY_BUY, REGULAR_DELIVERY)", 400);

    const where: Prisma.ProductWhereInput = and.length ? { AND: and } : {};
    const rows = await prisma.product.findMany({
      where,
      include: {
        vendor: { select: VENDOR_LIST_SELECT },
        subscriptionOfferProducts: { select: { id: true }, take: 1 },
      },
      orderBy: CURSOR_ORDER_BY,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    let nextCursor: string | null = null;
    if (rows.length > limit) nextCursor = rows.pop()?.id ?? null;

    const [active, inactiveAdmin, inactiveOther] = await Promise.all([
      prisma.product.count({ where: { isActive: true } }),
      prisma.product.count({ where: { isActive: false, OR: [{ adminUnpublishedAt: { not: null } }, { vendor: { isSuspended: true } }] } }),
      prisma.product.count({ where: { isActive: false, adminUnpublishedAt: null, vendor: { isSuspended: false } } }),
    ]);

    const categories = await prisma.product.findMany({
      where: { category: { not: null } },
      distinct: ["category"],
      select: { category: true },
      orderBy: { category: "asc" },
      take: 200,
    });

    const items = rows.map((p) => {
      const readiness = p.vendor ? readinessView(p.vendor) : null;
      return {
        id: p.id,
        productCode: p.productCode,
        title: p.title,
        image: p.images[0] ?? null,
        vendorId: p.vendorId,
        vendorName: p.vendor?.storeName ?? null,
        vendorUserId: p.vendor?.userId ?? null,
        category: p.category,
        productType: (p.subscriptionOfferProducts.length > 0 ? "REGULAR_DELIVERY" : "STANDARD") as ProductType,
        priceInCents: p.priceInCents,
        currency: p.currency,
        stock: p.stock,
        isActive: p.isActive,
        status: productStatus(p, p.vendor),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        sellerReadiness: readiness,
        // Not purchasable for payment reasons (only meaningful while the gate is on).
        notPurchasableReason: p.isActive && readiness && !readiness.ready && readiness.gateEnabled ? readiness.message : null,
      };
    });

    return {
      items,
      nextCursor,
      counts: { active, disabled: inactiveAdmin, draft: inactiveOther, total: active + inactiveAdmin + inactiveOther },
      categories: categories.map((c) => c.category).filter((c): c is string => Boolean(c)),
    };
  },

  async getProduct(productId: string) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        vendor: {
          select: {
            ...VENDOR_LIST_SELECT,
            contactEmail: true,
            city: true,
            storeSlug: true,
            stripePayoutsEnabled: true,
            stripeAccountStatus: true,
            sellerRegion: true,
          },
        },
        subscriptionOfferProducts: { select: { id: true, pausedAt: true, offerId: true } },
        orderItems: {
          select: { id: true, quantity: true, totalAmount: true, orderId: true },
          orderBy: { id: "desc" },
          take: 10,
        },
      },
    });
    if (!product) throw new AppError("Product not found", 404);

    const zoneSelect = {
      id: true,
      name: true,
      country: true,
      currency: true,
      baseFeeAmount: true,
      feePerKgAmount: true,
      deliveryMethods: {
        where: { isActive: true },
        select: { id: true, label: true, priceAmount: true, minDays: true, maxDays: true },
      },
    } as const;
    const [vendorZones, globalZones, unpublishedBy] = await Promise.all([
      prisma.deliveryZone.findMany({ where: { vendorId: product.vendorId, isActive: true }, select: zoneSelect }),
      prisma.deliveryZone.findMany({
        where: { vendorId: null, isActive: true, ...(product.vendor?.country ? { country: product.vendor.country } : {}) },
        select: zoneSelect,
      }),
      product.adminUnpublishedById
        ? prisma.user.findUnique({ where: { id: product.adminUnpublishedById }, select: { id: true, name: true, email: true } })
        : Promise.resolve(null),
    ]);
    const deliveryZones = [
      ...vendorZones.map((z) => ({ ...z, scope: "VENDOR" as const })),
      ...globalZones.map((z) => ({ ...z, scope: "MARKET" as const })),
    ];

    const vendor = product.vendor;
    const readiness = vendor ? readinessView(vendor) : null;
    const { vendor: _v, subscriptionOfferProducts, ...rest } = product;

    return {
      ...rest,
      costAmount: undefined,
      costCurrency: undefined,
      status: productStatus(product, vendor),
      productType: (subscriptionOfferProducts.length > 0 ? "REGULAR_DELIVERY" : "STANDARD") as ProductType,
      vendorName: vendor?.storeName ?? null,
      vendor: vendor
        ? {
            id: vendor.id,
            storeName: vendor.storeName,
            userId: vendor.userId,
            country: vendor.country,
            city: vendor.city,
            contactEmail: vendor.contactEmail,
            currency: vendor.currency,
            sellerRegion: vendor.sellerRegion,
            // Verification and payment readiness are separate facts.
            verificationStatus: vendor.verificationStatus,
            isSuspended: vendor.isSuspended,
            closedAt: vendor.closedAt,
            stripeAccountId: vendor.stripeAccountId,
            stripeChargesEnabled: vendor.stripeChargesEnabled,
            stripePayoutsEnabled: vendor.stripePayoutsEnabled,
            stripeAccountStatus: vendor.stripeAccountStatus,
          }
        : null,
      sellerReadiness: readiness,
      // Columns that do not exist today: reported honestly as null (UI: "Not provided").
      unitSize: null,
      packSize: null,
      minimumQuantity: null,
      deliveryZones,
      deliveryMethods: deliveryZones.flatMap((z) => z.deliveryMethods.map((m) => ({ ...m, zoneName: z.name, zoneCountry: z.country }))),
      completeness: { hasImage: product.images.length > 0, priceOk: product.priceInCents > 0 },
      unpublishedBy,
      publicStoreUrl: vendor ? `${env.publicStoreBaseUrl}/store/${vendor.storeSlug}` : null,
    };
  },

  /** Unpublish: record retained, isActive=false, who/when/why stored. */
  async unpublish(productId: string, reason: string, actorId: string) {
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { vendor: { select: { userId: true, storeName: true } } } });
    if (!product) throw new AppError("Product not found", 404);
    if (!product.isActive) throw new AppError("Product is already unpublished", 409, null, "ALREADY_UNPUBLISHED");
    const now = new Date();
    const res = await prisma.product.updateMany({
      where: { id: productId, isActive: true },
      data: { isActive: false, adminUnpublishedAt: now, adminUnpublishedReason: reason, adminUnpublishedById: actorId },
    });
    if (res.count !== 1) throw new AppError("Product changed while you were editing. Reload and retry.", 409);
    return {
      product,
      before: { isActive: true, adminUnpublishedAt: null, adminUnpublishedReason: null },
      after: { isActive: false, adminUnpublishedAt: now.toISOString(), adminUnpublishedReason: reason },
    };
  },

  /** Restore: completeness gate (image + price > 0), clears the unpublish markers. */
  async restore(productId: string, reason: string) {
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { vendor: { select: { userId: true, storeName: true } } } });
    if (!product) throw new AppError("Product not found", 404);
    if (product.isActive) throw new AppError("Product is already live", 409, null, "ALREADY_ACTIVE");
    if (!isProductComplete(product)) {
      throw new AppError(
        "A product needs at least one image and a price above zero before it can go live.",
        409,
        { hasImage: product.images.length > 0, priceOk: product.priceInCents > 0 },
        "PRODUCT_INCOMPLETE",
      );
    }
    const res = await prisma.product.updateMany({
      where: { id: productId, isActive: false },
      data: { isActive: true, adminUnpublishedAt: null, adminUnpublishedReason: null, adminUnpublishedById: null },
    });
    if (res.count !== 1) throw new AppError("Product changed while you were editing. Reload and retry.", 409);
    return {
      product,
      before: {
        isActive: false,
        adminUnpublishedAt: product.adminUnpublishedAt ? product.adminUnpublishedAt.toISOString() : null,
        adminUnpublishedReason: product.adminUnpublishedReason,
      },
      after: { isActive: true, adminUnpublishedAt: null, adminUnpublishedReason: null, restoreReason: reason },
    };
  },

  /** In-app + email notice to the vendor owner. Best effort, never throws. */
  async notifyVendor(params: {
    vendorUserId: string;
    productId: string;
    productTitle: string;
    action: "unpublished" | "restored";
    reason: string;
  }): Promise<void> {
    const title = params.action === "unpublished" ? "A product was unpublished" : "Your product is live again";
    const body =
      params.action === "unpublished"
        ? `"${params.productTitle}" was unpublished by Eki support. Reason: ${params.reason}`
        : `"${params.productTitle}" was restored and is visible to buyers again. Note: ${params.reason}`;
    try {
      await notificationsService.enqueue({
        userId: params.vendorUserId,
        type: "ADMIN_BROADCAST",
        title,
        body,
        data: { event: `product_${params.action}`, productId: params.productId },
      });
    } catch (error) {
      logger.warn("Product moderation in-app notification failed", {
        productId: params.productId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const user = await prisma.user.findUnique({ where: { id: params.vendorUserId }, select: { email: true, name: true } });
      if (user?.email) {
        const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await sendEmail({
          to: user.email,
          subject: title,
          html: `<p>Hi ${esc(user.name ?? "there")},</p><p>${esc(body)}</p><p>If you have questions, reply to this email or contact support in the Eki app.</p>`,
          text: `Hi ${user.name ?? "there"},\n\n${body}\n\nIf you have questions, contact support in the Eki app.`,
        });
      }
    } catch (error) {
      logger.warn("Product moderation email failed", {
        productId: params.productId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
