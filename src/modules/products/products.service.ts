import { eventsService, EVENT_NAMES } from "../events/events.service";
import { vendorMilestoneNotificationsService } from "../vendors/vendor-milestone-notifications.service";
import type { Product, ProductStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { currencyFromCountry } from "../../shared/currency";
import { AppError } from "../../shared/errors/app-error";
import { subscriptionsService } from "../subscriptions/subscriptions.service";
import { isSellerReadinessGateEnabled, purchasableVendorWhere } from "./seller-readiness";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "./products.types";

// Acceptance audit fix: a suspended vendor must not be able to write
// anything (matches the existing, established convention in
// promos.service.ts/bundles.service.ts/flash-sales.service.ts — a
// suspended vendor's own write attempts get the same 404 an unauthorized
// caller would, not a message revealing suspension state).
async function getVendorWithVerification(userId: string): Promise<{ id: string; currency: string }> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, currency: true, country: true, isSuspended: true },
  });
  if (!vendor || vendor.isSuspended) {
    throw new AppError("Vendor profile not found", 404);
  }
  const currency = vendor.currency || currencyFromCountry(vendor.country);
  return { id: vendor.id, currency };
}

// Permissive on purpose — used by read paths (listMyProducts,
// getMyProductById) too, and a suspended vendor must still be able to see
// their own dashboard/listings. Write paths that could reactivate/expose a
// product (updateProduct) use getVendorIdForWrite below instead.
async function getVendorIdForUser(userId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!vendor) {
    throw new AppError("Vendor profile required", 403);
  }
  return vendor.id;
}

// Acceptance audit fix: a suspended vendor must not be able to write —
// same 404-as-not-found convention as promos/bundles/flash-sales.service.ts.
async function getVendorForWrite(userId: string): Promise<{ id: string }> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, isSuspended: true },
  });
  if (!vendor || vendor.isSuspended) {
    throw new AppError("Vendor profile not found", 404);
  }
  return { id: vendor.id };
}

async function nextProductCode(): Promise<string> {
  const last = await prisma.product.findFirst({
    where: { productCode: { not: null } },
    orderBy: { productCode: "desc" },
    select: { productCode: true },
  });
  const lastNumber = Number((last?.productCode ?? "EKI-010100").replace("EKI-", ""));
  return `EKI-${String((Number.isFinite(lastNumber) ? lastNumber : 10100) + 1).padStart(6, "0")}`;
}

/** Publish-check shared by vendor create and admin restore. */
export function isProductComplete(p: { images: string[] | null | undefined; priceInCents: number }): boolean {
  return (p.images?.length ?? 0) > 0 && p.priceInCents > 0;
}

/**
 * Policy change (19 Oct 2026, explicit owner decision): a vendor may
 * publish and sell live the moment a listing is complete — identity
 * verification is required only at withdrawal time (see
 * payouts.service.ts's createRequest), never to go live. Previously a
 * complete-but-unverified listing sat in PENDING_ACTIVATION until the
 * vendor verified; that state is no longer reachable from any normal
 * create/update flow (kept in the enum for admin/historical rows only —
 * see the 20261019_publish_pending_activation_on_verification_removal
 * migration, which flips every existing one to PUBLISHED once). An
 * incomplete listing is always DRAFT — there's nothing to activate yet.
 * isActive is kept in sync as a plain derived value:
 * `isActive = (status === "PUBLISHED")`, since every other query in the
 * codebase (cart, checkout, buyer feed, automations) still reads isActive
 * as the one enforced visibility gate.
 */
export function computeProductStatus(params: { complete: boolean }): ProductStatus {
  return params.complete ? "PUBLISHED" : "DRAFT";
}

export const productsService = {
  async createProduct(userId: string, input: CreateProductInput): Promise<Product> {
    const vendor = await getVendorWithVerification(userId);

    // A complete listing (image + price > 0, handbook 14.6) publishes
    // immediately regardless of verification state — identity
    // verification is required only at withdrawal time (payouts.service
    // .ts's createRequest), never to go live. See computeProductStatus().
    const complete = isProductComplete({ images: input.images ?? [], priceInCents: input.priceAmount });
    const status = computeProductStatus({ complete });

    // Enforce subscription product limit
    await subscriptionsService.enforceProductLimit(vendor.id);

    // Product currency ALWAYS inherits from vendor — input.currency is ignored
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const created = await prisma.product.create({
          data: {
            productCode: await nextProductCode(),
            vendorId: vendor.id,
            title: input.title,
            description: input.description,
            priceInCents: input.priceAmount,
            costAmount: input.costAmount,
            costCurrency: input.costAmount === undefined ? undefined : input.costCurrency ?? vendor.currency,
            currency: vendor.currency,
            images: input.images ?? [],
            category: input.category,
            stock: input.stock ?? 0,
            weightGrams: input.weightGrams,
            status,
            isActive: status === "PUBLISHED",
            publishedAt: status === "PUBLISHED" ? new Date() : null,
          },
        });
        if (created.isActive) {
          eventsService.emit({
            name: EVENT_NAMES.product_published, actorType: "vendor", actorId: userId, entityType: "Product", entityId: created.id,
            source: "vendor_app", secondaryEntities: { vendorId: vendor.id },
          });
          // Handoff V-05 "store.ready" — the product-side half of the
          // product+delivery-zone pair; see vendor-milestone-notifications
          // .service.ts for why this call site and delivery-zones.service.ts
          // both call it (idempotent either way).
          void vendorMilestoneNotificationsService.maybeSendStoreReady(vendor.id);
        }
        return created;
      } catch (error: any) {
        if (error?.code !== "P2002" || !String(error?.meta?.target ?? "").includes("productCode")) throw error;
      }
    }
    throw new AppError("Could not allocate product code", 409);
  },

  async updateProduct(
    userId: string,
    productId: string,
    input: UpdateProductInput,
  ): Promise<Product> {
    const vendor = await getVendorForWrite(userId);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError("Product not found", 404);
    }
    if (product.vendorId !== vendor.id) {
      throw new AppError("Forbidden", 403);
    }

    // currency is destructured out and discarded even though UpdateProductInput
    // no longer declares it — a product's currency always inherits from its
    // vendor and must never drift from it post-creation (see createProduct).
    const { priceAmount, costAmount, costCurrency, currency: _ignoredCurrency, ...rest } = input as UpdateProductInput & { currency?: string };

    if (product.isActive && rest.images !== undefined && !isProductComplete({ images: rest.images, priceInCents: priceAmount ?? product.priceInCents })) {
      throw new AppError("A live product needs at least one image. Add an image before removing the last one.", 400, null, "PRODUCT_INCOMPLETE");
    }
    if (product.isActive && priceAmount !== undefined && priceAmount <= 0) {
      throw new AppError("Price must be greater than zero", 400, null, "PRODUCT_INCOMPLETE");
    }

    // Re-evaluate status only from DRAFT/PENDING_ACTIVATION — those are the
    // two "not yet live" states an edit can legitimately move forward (e.g.
    // adding the missing image completes it). PUBLISHED is guarded above
    // instead of silently downgraded, and PAUSED/REJECTED are deliberate
    // vendor/admin decisions an ordinary content edit must never override.
    // PENDING_ACTIVATION itself is no longer reachable going forward (see
    // computeProductStatus()) but existing rows can still carry it until
    // their next edit flips them to PUBLISHED here.
    const statusUpdate =
      product.status === "DRAFT" || product.status === "PENDING_ACTIVATION"
        ? (() => {
            const complete = isProductComplete({
              images: rest.images !== undefined ? rest.images : product.images,
              priceInCents: priceAmount ?? product.priceInCents,
            });
            const status = computeProductStatus({ complete });
            return { status, isActive: status === "PUBLISHED", ...(status === "PUBLISHED" ? { publishedAt: new Date() } : {}) };
          })()
        : {};

    return prisma.product.update({
      where: { id: productId },
      data: {
        ...rest,
        ...(priceAmount !== undefined ? { priceInCents: priceAmount } : {}),
        ...(costAmount !== undefined
          ? {
              costAmount,
              costCurrency: costAmount === null ? null : costCurrency ?? product.currency,
            }
          : costCurrency !== undefined
            ? { costCurrency }
            : {}),
        ...statusUpdate,
      },
    });
  },

  async listMyProducts(userId: string): Promise<Product[]> {
    const vendorId = await getVendorIdForUser(userId);
    return prisma.product.findMany({
      where: { vendorId },
      orderBy: CURSOR_ORDER_BY,
    });
  },

  async getMyProductById(userId: string, productId: string): Promise<Product> {
    const vendorId = await getVendorIdForUser(userId);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.vendorId !== vendorId) {
      throw new AppError("Product not found", 404);
    }
    return product;
  },

  async disableProduct(userId: string, productId: string): Promise<Product> {
    const vendorId = await getVendorIdForUser(userId);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError("Product not found", 404);
    }
    if (product.vendorId !== vendorId) {
      throw new AppError("Forbidden", 403);
    }

    return prisma.product.update({
      where: { id: productId },
      // Vendor-initiated pause: temporarily unavailable, no issue to
      // resolve (distinct from admin REJECTED — see admin-products.service.ts).
      data: { isActive: false, status: "PAUSED" },
    });
  },

  /** Symmetric to disableProduct — a vendor un-pausing their own listing. */
  async resumeProduct(userId: string, productId: string): Promise<Product> {
    const vendor = await getVendorForWrite(userId);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError("Product not found", 404);
    }
    if (product.vendorId !== vendor.id) {
      throw new AppError("Forbidden", 403);
    }
    if (product.status !== "PAUSED") {
      throw new AppError("Only a paused listing can be resumed this way.", 409, null, "NOT_PAUSED");
    }

    const complete = isProductComplete({ images: product.images, priceInCents: product.priceInCents });
    const status = computeProductStatus({ complete });
    return prisma.product.update({
      where: { id: productId },
      data: { status, isActive: status === "PUBLISHED", ...(status === "PUBLISHED" ? { publishedAt: new Date() } : {}) },
    });
  },

  async listActiveProducts(
    query: ListProductsQuery,
  ): Promise<{ items: Array<Product & { vendor: { storeName: string; city: string | null; userId: string } }>; nextCursor: string | null }> {
    const items = await prisma.product.findMany({
      where: {
        isActive: true,
        // B15: hide products whose seller cannot receive payment.
        ...(isSellerReadinessGateEnabled() ? { vendor: purchasableVendorWhere() } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      },
      include: {
        vendor: {
          select: {
            storeName: true,
            city: true,
            userId: true,
          },
        },
      },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },

  async getProductById(productId: string): Promise<Product & { vendor: { storeName: string; city: string | null; userId: string } }> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        vendor: {
          select: {
            storeName: true,
            city: true,
            userId: true,
          },
        },
      },
    });
    if (!product || !product.isActive) {
      throw new AppError("Product not found", 404);
    }
    return product;
  },
};
