import type { PayoutMethod, Prisma, Vendor } from "@prisma/client";
import { UserRole } from "@prisma/client";

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

export const vendorsService = {
  async createVendor(userId: string, input: CreateVendorInput): Promise<Vendor> {
    const existing = await prisma.vendor.findUnique({ where: { userId } });
    if (existing) {
      throw new AppError("Vendor profile already exists", 409);
    }

    const storeSlug = await generateUniqueStoreSlug(input.storeName);

    return prisma.$transaction(async (tx) => {
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
  },

  async getOwnVendor(userId: string): Promise<Vendor> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      include: { wallet: true },
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

    // If storeName changes, only regenerate the slug when the vendor has not
    // explicitly set one yet (legacy rows). We do NOT change a slug that is
    // already in use because share links would break.
    return prisma.vendor.update({
      where: { id: vendor.id },
      data: input,
    });
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
