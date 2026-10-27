import type { Prisma } from "@prisma/client";

import { env } from "../../config/env";
import { sendEmail } from "../../lib/email";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { notificationsService } from "../notifications/notifications.service";
import { computeProductStatus, isProductComplete } from "../products/products.service";
import { enqueueProductPublished } from "../products/product-publication-events";
import { dispatchNotificationsAfterCommit } from "../events/dispatch-notifications";
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
export type RealProductStatus = "DRAFT" | "PENDING_ACTIVATION" | "PUBLISHED" | "PAUSED" | "REJECTED";

const MAX_LIMIT = 100;
const VENDOR_LIST_SELECT = {
  storeName: true,
  userId: true,
  country: true,
  currency: true,
  ...SELLER_READINESS_SELECT,
} as const;

// Coarse 3-state view, now DERIVED FROM the real 5-state status column
// instead of re-computed from isActive+adminUnpublishedAt — the two used
// to disagree (a PENDING_ACTIVATION row has isActive=false with no
// adminUnpublishedAt, which the old formula also called "DRAFT", so admin
// saw a product badged "Draft" AND "Awaiting activation" at once). Kept
// only for API back-compat; admin-web now renders realStatus as the one
// badge of truth.
function productStatus(p: { status: RealProductStatus }): ProductStatus {
  if (p.status === "PUBLISHED") return "ACTIVE";
  if (p.status === "PAUSED" || p.status === "REJECTED") return "DISABLED";
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

    // Real 5-state filter (preferred) — PUBLISHED/PENDING_ACTIVATION/PAUSED/
    // REJECTED/DRAFT map straight to the status column. Legacy ACTIVE/
    // DISABLED/DRAFT/INACTIVE/?isActive=true|false still accepted for
    // back-compat, translated to the same real statuses so results stay
    // honest (the old isActive-only formula is what caused the
    // DRAFT/"Awaiting activation" double-badge bug).
    const REAL_STATUSES = new Set<RealProductStatus>(["DRAFT", "PENDING_ACTIVATION", "PUBLISHED", "PAUSED", "REJECTED"]);
    let status = str(query.status)?.toUpperCase();
    if (!status && query.isActive === "true") status = "ACTIVE";
    if (!status && query.isActive === "false") status = "INACTIVE";
    if (status && REAL_STATUSES.has(status as RealProductStatus)) and.push({ status: status as RealProductStatus });
    else if (status === "ACTIVE") and.push({ status: "PUBLISHED" });
    else if (status === "DISABLED") and.push({ status: { in: ["PAUSED", "REJECTED"] } });
    else if (status === "INACTIVE") and.push({ status: { not: "PUBLISHED" } });
    else if (status && status !== "ALL") throw new AppError("Invalid status", 400);

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

    const statusCounts = await prisma.product.groupBy({ by: ["status"], _count: { _all: true } });
    const countFor = (s: RealProductStatus) => statusCounts.find((c) => c.status === s)?._count._all ?? 0;
    const published = countFor("PUBLISHED");
    const pendingActivation = countFor("PENDING_ACTIVATION");
    const paused = countFor("PAUSED");
    const rejected = countFor("REJECTED");
    const draft = countFor("DRAFT");
    const total = published + pendingActivation + paused + rejected + draft;

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
        status: productStatus(p),
        realStatus: p.status,
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
      counts: { published, pendingActivation, paused, rejected, draft, total },
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
      status: productStatus(product),
      // See the matching comment in listProducts above — real 5-state
      // lifecycle, additive next to the existing 3-state `status`.
      realStatus: product.status,
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

  /** Unpublish: record retained, isActive=false, who/when/why stored. REJECTED — cannot go live again until the reason is resolved. */
  async unpublish(productId: string, reason: string, actorId: string) {
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { vendor: { select: { userId: true, storeName: true } } } });
    if (!product) throw new AppError("Product not found", 404);
    if (!product.isActive) throw new AppError("Product is already unpublished", 409, null, "ALREADY_UNPUBLISHED");
    const now = new Date();
    const res = await prisma.product.updateMany({
      where: { id: productId, isActive: true },
      data: { isActive: false, status: "REJECTED", adminUnpublishedAt: now, adminUnpublishedReason: reason, adminUnpublishedById: actorId },
    });
    if (res.count !== 1) throw new AppError("Product changed while you were editing. Reload and retry.", 409);
    return {
      product,
      before: { isActive: true, adminUnpublishedAt: null, adminUnpublishedReason: null, status: product.status },
      after: { isActive: false, adminUnpublishedAt: now.toISOString(), adminUnpublishedReason: reason, status: "REJECTED" },
    };
  },

  /** Restore: completeness gate (image + price > 0), clears the unpublish markers. Goes straight to PUBLISHED — verification is no longer a publish gate, only a withdrawal gate (see payouts.service.ts's createRequest). */
  async restore(productId: string, reason: string) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { vendor: { select: { userId: true, storeName: true } } },
    });
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
    const status = computeProductStatus({ complete: true });
    const publishedAt = status === "PUBLISHED" ? new Date() : null;
    const res = await prisma.$transaction(async (tx) => {
      const result = await tx.product.updateMany({
        where: { id: productId, isActive: false },
        data: {
          isActive: status === "PUBLISHED",
          status,
          publishedAt,
          adminUnpublishedAt: null,
          adminUnpublishedReason: null,
          adminUnpublishedById: null,
        },
      });
      if (result.count && publishedAt) {
        await enqueueProductPublished(tx, { id: product.id, vendorId: product.vendorId, publishedAt }, { actorType: "admin", source: "admin_product_restore" });
      }
      return result;
    });
    if (res.count !== 1) throw new AppError("Product changed while you were editing. Reload and retry.", 409);
    if (publishedAt) void dispatchNotificationsAfterCommit();
    return {
      product,
      before: {
        isActive: false,
        adminUnpublishedAt: product.adminUnpublishedAt ? product.adminUnpublishedAt.toISOString() : null,
        adminUnpublishedReason: product.adminUnpublishedReason,
        status: product.status,
      },
      after: { isActive: status === "PUBLISHED", adminUnpublishedAt: null, adminUnpublishedReason: null, restoreReason: reason, status },
    };
  },

  /**
   * Hard delete — genuinely removes the row, unlike unpublish (which keeps
   * the record). Only permitted when nothing real is attached to it: no
   * order ever referenced it (order history must never be erasable), no
   * live subscription/renewal/bundle/flash-sale linkage. A product with
   * any of that history gets a clear 409 pointing at Unpublish instead —
   * this is for genuinely removing test/garbage listings, not for
   * retroactively hiding something that was actually sold.
   */
  async deleteProduct(productId: string, reason: string) {
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { vendor: { select: { userId: true, storeName: true } } } });
    if (!product) throw new AppError("Product not found", 404);

    const [orderItems, subscriptionOfferProducts, subscriptionItems, renewalItems, bundleItems, flashSales] = await Promise.all([
      prisma.orderItem.count({ where: { productId } }),
      prisma.subscriptionOfferProduct.count({ where: { productId } }),
      prisma.subscriptionItem.count({ where: { productId } }),
      prisma.renewalItem.count({ where: { productId } }),
      prisma.bundleItem.count({ where: { productId } }),
      prisma.flashSale.count({ where: { productId } }),
    ]);
    const blockers = { orderItems, subscriptionOfferProducts, subscriptionItems, renewalItems, bundleItems, flashSales };
    const hasHistory = Object.values(blockers).some((n) => n > 0);
    if (hasHistory) {
      throw new AppError(
        "This product has real order or subscription history and can't be deleted — use Unpublish instead, which keeps the record and the history it's attached to.",
        409,
        blockers,
        "PRODUCT_HAS_HISTORY",
      );
    }

    // Cart items are transient/low-stakes (nobody has checked out with
    // them) — safe to clear so the delete doesn't fail on the Restrict FK.
    await prisma.cartItem.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });

    return { product, before: { title: product.title, status: product.status }, after: { deleted: true, reason } };
  },

  /** In-app + email notice to the vendor owner. Best effort, never throws. */
  async notifyVendor(params: {
    vendorUserId: string;
    productId: string;
    productTitle: string;
    action: "unpublished" | "restored" | "deleted";
    reason: string;
  }): Promise<void> {
    const title =
      params.action === "unpublished" ? "A product was unpublished" : params.action === "deleted" ? "A product was removed" : "Your product is live again";
    const body =
      params.action === "unpublished"
        ? `"${params.productTitle}" was unpublished by Eki support. Reason: ${params.reason}`
        : params.action === "deleted"
          ? `"${params.productTitle}" was removed from your store by Eki support. Reason: ${params.reason}`
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
