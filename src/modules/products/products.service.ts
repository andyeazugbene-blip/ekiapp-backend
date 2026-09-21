import type { Product } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { currencyFromCountry } from "../../shared/currency";
import { AppError } from "../../shared/errors/app-error";
import { subscriptionsService } from "../subscriptions/subscriptions.service";
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
async function getVendorWithVerification(userId: string): Promise<{ id: string; currency: string; isVerified: boolean }> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, verificationStatus: true, currency: true, country: true, isSuspended: true },
  });
  if (!vendor || vendor.isSuspended) {
    throw new AppError("Vendor profile not found", 404);
  }
  const currency = vendor.currency || currencyFromCountry(vendor.country);
  return { id: vendor.id, currency, isVerified: vendor.verificationStatus === "VERIFIED" };
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
async function getVendorIdForWrite(userId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, isSuspended: true },
  });
  if (!vendor || vendor.isSuspended) {
    throw new AppError("Vendor profile not found", 404);
  }
  return vendor.id;
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

export const productsService = {
  async createProduct(userId: string, input: CreateProductInput): Promise<Product> {
    const vendor = await getVendorWithVerification(userId);

    // Unverified vendors can only create draft (inactive) products
    const forceDraft = !vendor.isVerified;

    // Enforce subscription product limit
    await subscriptionsService.enforceProductLimit(vendor.id);

    // Product currency ALWAYS inherits from vendor — input.currency is ignored
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await prisma.product.create({
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
            ...(forceDraft ? { isActive: false } : {}),
          },
        });
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
    const vendorId = await getVendorIdForWrite(userId);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError("Product not found", 404);
    }
    if (product.vendorId !== vendorId) {
      throw new AppError("Forbidden", 403);
    }

    // currency is destructured out and discarded even though UpdateProductInput
    // no longer declares it — a product's currency always inherits from its
    // vendor and must never drift from it post-creation (see createProduct).
    const { priceAmount, costAmount, costCurrency, currency: _ignoredCurrency, ...rest } = input as UpdateProductInput & { currency?: string };

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
      data: { isActive: false },
    });
  },

  async listActiveProducts(
    query: ListProductsQuery,
  ): Promise<{ items: Array<Product & { vendor: { storeName: string; city: string | null; userId: string } }>; nextCursor: string | null }> {
    const items = await prisma.product.findMany({
      where: {
        isActive: true,
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
