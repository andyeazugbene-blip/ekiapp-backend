import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import { buildVendorShareUrl } from "../vendors/vendors.service";
import type {
  ListPublicProductsQuery,
  PublicProduct,
  PublicStore,
} from "./public-stores.types";

/**
 * Public storefront service — returns ONLY public data. Suspended vendors
 * are treated as if they don't exist (404). Inactive products are hidden.
 */
export const publicStoresService = {
  async getStoreBySlug(slug: string): Promise<PublicStore> {
    const vendor = await prisma.vendor.findUnique({
      where: { storeSlug: slug },
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
        isSuspended: true,
        createdAt: true,
      },
    });

    if (!vendor || vendor.isSuspended) {
      throw new AppError("Store not found", 404);
    }

    const [totalProducts, deliveryZones] = await Promise.all([
      prisma.product.count({
        where: { vendorId: vendor.id, isActive: true },
      }),
      prisma.deliveryZone.findMany({
        where: { vendorId: vendor.id, isActive: true },
        select: { country: true },
        distinct: ["country"],
      }),
    ]);

    const deliveryCountries = deliveryZones
      .map((z) => z.country)
      .filter((c): c is string => Boolean(c));

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
      // Rating is not yet tracked in the schema. Return null so the contract
      // is stable and clients can show "no rating yet" until reviews land.
      rating: null,
      totalProducts,
      deliveryCountries,
      createdAt: vendor.createdAt,
    };
  },

  async listStoreProducts(
    slug: string,
    query: ListPublicProductsQuery,
  ): Promise<{ items: PublicProduct[]; nextCursor: string | null }> {
    const vendor = await prisma.vendor.findUnique({
      where: { storeSlug: slug },
      select: { id: true, isSuspended: true },
    });

    if (!vendor || vendor.isSuspended) {
      throw new AppError("Store not found", 404);
    }

    const items = await prisma.product.findMany({
      where: {
        vendorId: vendor.id,
        isActive: true,
        ...(query.category ? { category: query.category } : {}),
      },
      orderBy: CURSOR_ORDER_BY,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        vendorId: true,
        title: true,
        description: true,
        priceInCents: true,
        currency: true,
        images: true,
        category: true,
        stock: true,
        weightGrams: true,
        createdAt: true,
      },
    });

    let nextCursor: string | null = null;
    if (items.length > query.limit) {
      const next = items.pop();
      nextCursor = next?.id ?? null;
    }

    return { items, nextCursor };
  },
};
