import { Prisma, UserRole } from "@prisma/client";
import type { PayoutMethod, Vendor } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { currencyFromCountry } from "../../shared/currency";
import { resolveUniqueSlug } from "../../shared/utils/slug";
import type {
  CreatePayoutMethodInput,
  CreateVendorInput,
  UpdateVendorInput,
} from "./vendors.types";

async function ensureWallet(vendorId: string, tx: Prisma.TransactionClient): Promise<void> {
  await tx.wallet.upsert({
    where: { vendorId },
    update: {},
    create: { vendorId, currency: env.defaultCurrency },
  });
}

/**
 * Build the public share URL for a vendor storefront.
 * Format: {PUBLIC_STORE_BASE_URL}/store/{storeSlug}
 */
export function buildVendorShareUrl(storeSlug: string): string {
  return `${env.publicStoreBaseUrl}/store/${storeSlug}`;
}

async function generateUniqueStoreSlug(storeName: string): Promise<string> {
  return resolveUniqueSlug(storeName, async (candidate) => {
    const existing = await prisma.vendor.findUnique({
      where: { storeSlug: candidate },
      select: { id: true },
    });
    return existing !== null;
  });
}

async function ensureStoreNameAvailable(storeName: string, excludeVendorId?: string): Promise<void> {
  const existing = await prisma.vendor.findFirst({
    where: {
      storeName: {
        equals: storeName,
        mode: "insensitive",
      },
      ...(excludeVendorId ? { NOT: { id: excludeVendorId } } : {}),
    },
    select: { id: true },
  });

  if (existing) {
    throw new AppError("Store name already exists", 409);
  }
}

function isUniqueViolation(error: unknown, field: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002"
    && Array.isArray(error.meta?.target)
    && error.meta.target.includes(field);
}

export const vendorsService = {
  async listPublicVendors(input?: { search?: string; limit?: number; sort?: "newest" | "popular" }): Promise<any[]> {
    const search = input?.search?.trim();
    const limit = Math.min(Math.max(input?.limit ?? 20, 1), 100);
    const sort = input?.sort ?? "popular";

    const vendors = await prisma.vendor.findMany({
      where: {
        isSuspended: false,
        verificationStatus: "VERIFIED",
        ...(search
          ? {
              OR: [
                { storeName: { contains: search, mode: "insensitive" } },
                { description: { contains: search, mode: "insensitive" } },
                { city: { contains: search, mode: "insensitive" } },
                { country: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        _count: { select: { products: true } },
      },
      orderBy: sort === "newest" ? { createdAt: "desc" } : { createdAt: "desc" },
      take: limit,
    });

    const vendorIds = vendors.map((vendor) => vendor.id);
    const orderCounts = vendorIds.length
      ? await prisma.order.groupBy({
          by: ["vendorId"],
          where: {
            vendorId: { in: vendorIds },
            status: { notIn: ["PENDING", "FAILED", "CANCELLED"] },
          },
          _count: { _all: true },
        })
      : [];

    const orderCountMap = new Map(orderCounts.map((entry) => [entry.vendorId ?? "", entry._count._all]));

    const serialized = vendors.map((vendor) => ({
      ...vendor,
      ownerName: vendor.user?.name ?? "",
      totalProducts: vendor._count.products,
      totalOrders: orderCountMap.get(vendor.id) ?? 0,
      rating: 0,
    }));

    if (sort === "popular") {
      serialized.sort((left, right) => {
        const leftScore = (left.totalOrders ?? 0) * 5 + (left.totalProducts ?? 0) * 2 + (left.user?.avatar ? 4 : 0);
        const rightScore = (right.totalOrders ?? 0) * 5 + (right.totalProducts ?? 0) * 2 + (right.user?.avatar ? 4 : 0);
        return rightScore - leftScore || right.createdAt.getTime() - left.createdAt.getTime();
      });
    }

    return serialized;
  },

  async getPublicVendorById(id: string): Promise<any> {
    const vendor = await prisma.vendor.findFirst({
      where: {
        id,
        isSuspended: false,
        verificationStatus: "VERIFIED",
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        _count: { select: { products: true } },
      },
    });
    if (!vendor) {
      throw new AppError("Vendor not found", 404);
    }

    const totalOrders = await prisma.order.count({
      where: {
        vendorId: vendor.id,
        status: { notIn: ["PENDING", "FAILED", "CANCELLED"] },
      },
    });

    return {
      ...vendor,
      ownerName: vendor.user?.name ?? "",
      totalProducts: vendor._count.products,
      totalOrders,
      rating: 0,
    };
  },

  async createVendor(userId: string, input: CreateVendorInput): Promise<Vendor> {
    const existing = await prisma.vendor.findUnique({ where: { userId } });
    if (existing) {
      throw new AppError("Vendor profile already exists", 409);
    }

    await ensureStoreNameAvailable(input.storeName);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const storeSlug = await generateUniqueStoreSlug(input.storeName);

      try {
        return await prisma.$transaction(async (tx) => {
          const vendor = await tx.vendor.create({
            data: {
              userId,
              storeName: input.storeName,
              storeSlug,
              description: input.description,
              contactEmail: input.contactEmail,
              contactPhone: input.contactPhone,
              country: input.country,
              currency: currencyFromCountry(input.country),
            },
          });

          await ensureWallet(vendor.id, tx);

          // Only promote buyers to vendors; never demote admins or other elevated roles.
          await tx.user.updateMany({
            where: { id: userId, role: UserRole.BUYER },
            data: { role: UserRole.VENDOR },
          });

          return vendor;
        });
      } catch (error) {
        if (isUniqueViolation(error, "storeSlug")) {
          continue;
        }
        if (isUniqueViolation(error, "storeName")) {
          throw new AppError("Store name already exists", 409);
        }
        throw error;
      }
    }

    throw new AppError("Unable to create a unique store slug. Please try again.", 409);
  },

  async getOwnVendor(userId: string): Promise<Vendor> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      include: { wallet: true, user: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }
    return vendor;
  },

  async updateOwnVendor(userId: string, input: UpdateVendorInput): Promise<Vendor> {
    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }

    if (
      input.storeName
      && input.storeName.trim().toLowerCase() !== vendor.storeName.trim().toLowerCase()
    ) {
      await ensureStoreNameAvailable(input.storeName, vendor.id);
    }

    // If storeName changes, only regenerate the slug when the vendor has not
    // explicitly set one yet (legacy rows). We do NOT change a slug that is
    // already in use because share links would break.
    try {
      return await prisma.vendor.update({
        where: { id: vendor.id },
        data: input,
      });
    } catch (error) {
      if (isUniqueViolation(error, "storeName")) {
        throw new AppError("Store name already exists", 409);
      }
      throw error;
    }
  },

  async createPayoutMethod(
    userId: string,
    input: CreatePayoutMethodInput,
  ): Promise<PayoutMethod> {
    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }

    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.payoutMethod.updateMany({
          where: { vendorId: vendor.id, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.payoutMethod.create({
        data: {
          vendorId: vendor.id,
          type: input.type,
          label: input.label,
          details: input.details as Prisma.InputJsonValue,
          isDefault: input.isDefault ?? false,
        },
      });
    });
  },

  async listPayoutMethods(userId: string): Promise<PayoutMethod[]> {
    const vendor = await prisma.vendor.findUnique({ where: { userId } });
    if (!vendor) {
      throw new AppError("Vendor profile not found", 404);
    }
    return prisma.payoutMethod.findMany({
      where: { vendorId: vendor.id },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
  },
};
