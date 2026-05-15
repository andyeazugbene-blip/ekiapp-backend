import type { Product } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { subscriptionsService } from "../subscriptions/subscriptions.service";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "./products.types";

async function getVerifiedVendorIdForUser(userId: string): Promise<string> {
  const vendor = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, verificationStatus: true },
  });
  if (!vendor) {
    throw new AppError("Vendor profile required", 403);
  }
  if (vendor.verificationStatus !== "VERIFIED") {
    throw new AppError("Vendor must be verified to create products", 403);
  }
  return vendor.id;
}

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

export const productsService = {
  async createProduct(userId: string, input: CreateProductInput): Promise<Product> {
    const vendorId = await getVerifiedVendorIdForUser(userId);

    // Enforce subscription product limit
    await subscriptionsService.enforceProductLimit(vendorId);

    return prisma.product.create({
      data: {
        vendorId,
        title: input.title,
        description: input.description,
        priceInCents: input.priceAmount,
        currency: input.currency ?? env.defaultCurrency,
        images: input.images ?? [],
        category: input.category,
        stock: input.stock ?? 0,
        weightGrams: input.weightGrams,
      },
    });
  },

  async updateProduct(
    userId: string,
    productId: string,
    input: UpdateProductInput,
  ): Promise<Product> {
    const vendorId = await getVendorIdForUser(userId);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new AppError("Product not found", 404);
    }
    if (product.vendorId !== vendorId) {
      throw new AppError("Forbidden", 403);
    }

    const { priceAmount, ...rest } = input;

    return prisma.product.update({
      where: { id: productId },
      data: {
        ...rest,
        ...(priceAmount !== undefined ? { priceInCents: priceAmount } : {}),
      },
    });
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
  ): Promise<{ items: Product[]; nextCursor: string | null }> {
    const items = await prisma.product.findMany({
      where: {
        isActive: true,
        ...(query.category ? { category: query.category } : {}),
        ...(query.vendorId ? { vendorId: query.vendorId } : {}),
      },
      orderBy: { createdAt: "desc" },
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

  async getProductById(productId: string): Promise<Product> {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.isActive) {
      throw new AppError("Product not found", 404);
    }
    return product;
  },
};
